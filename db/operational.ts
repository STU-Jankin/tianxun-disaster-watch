import type { DisasterEvent } from "../lib/disasters.ts";
import type { RoadDisruption, RoadDisruptionRegistryEntry } from "../lib/response-disruptions.ts";
import type { SatelliteOrbitCacheRecord, SatelliteTleRecord } from "../lib/satellite-orbits.ts";
import type { SchedulingComparison, SchedulingManualRules } from "../lib/mission-scheduler.ts";
import { createPlanningScenarioRecord, planningScenarioHasValidChecksum, planningScenarioSummary, type PlanningScenarioRecord, type PlanningScenarioSummary } from "../lib/planning-scenarios.ts";
import { canTransitionTask } from "../lib/task-contract.ts";
import { compareEventVersionFreshness, eventHasInvalidIdentity, isValidSourceEventId } from "../lib/event-integrity.ts";
import { evidenceReassignmentSql } from "../lib/operational-sql.ts";
import type { SourceGovernance, SourceRole, SourceTier } from "../lib/source-governance.ts";
import type { ExposureAssessment } from "../lib/exposure-assessment.ts";
import { taskPatchFromExecutionReceipt, type MissionExecutionReceipt, type NormalizedExecutionReceiptInput } from "../lib/mission-execution.ts";
import { buildStacItem, geometryBbox, type ObservationProduct, type ObservationProductInput } from "../lib/stac-products.ts";
import { partitionAoiGeometry, transitionAoiWorkPackage, type AoiWorkPackage, type AoiWorkPackageAction } from "../lib/aoi-work-packages.ts";
import { buildTaskAoi, type GeoGeometry } from "../lib/task-aoi.ts";
import {
  evaluationWindow,
  type DetectionEvaluationReport,
  type EvaluationBenchmarkCase,
  type EvaluationCandidate,
  type EvaluationSourceReliability,
} from "../lib/evaluation-center.ts";
import type { ForecastRasterStorageBackend } from "../lib/forecast-raster-storage.ts";
import type { LhasaRiskRasterSummary } from "../lib/lhasa-nowcast.ts";
import type { LhasaV1GranuleProbeRecord, LhasaV1GranuleStatus } from "../lib/lhasa-v1-history.ts";

type TaskRecord = Record<string, unknown> & {
  taskId: string;
  eventId: string;
  masterEventId: string;
  title: string;
  status: string;
  priority: number;
  latitude: number;
  longitude: number;
  aoiType: string;
  imagingStart: string;
  imagingEnd: string;
  aoiApproval: string;
  createdAt: string;
  updatedAt?: string;
  revision?: number;
  eventRevision?: string;
  aoiHash?: string;
};

type LifecycleTaskRow = { task_id: string; owner: string; status: string; revision: number; payload_json: string };

export type WebSessionRecord = {
  username: string;
  role: "viewer" | "operator" | "admin";
  authVersion: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type SourceRegistryInput = SourceGovernance & {
  name: string;
  tier: SourceTier;
  role: SourceRole;
  setupUrl: string;
  state: "online" | "offline" | "needs_config";
  lastAttemptAt: string;
  durationMs: number;
  count: number;
  message: string;
};

export type SourceFetchCapture = {
  runId: string;
  refreshId: string;
  sourceId: string;
  requestedUrl: string;
  fetchedAt: string;
  durationMs: number;
  httpStatus: number | null;
  ok: boolean;
  payloadSha256: string | null;
  contentType: string;
  bodyText: string;
  byteLength: number;
  storedByteLength: number;
  truncated: boolean;
  errorMessage: string | null;
};

export type IngestionSnapshotRecord = {
  snapshotId: string;
  refreshId: string;
  capturedAt: string;
  payloadSha256: string;
  eventCount: number;
  sourceCount: number;
  payload: Record<string, unknown>;
};

export type ForecastRasterProductRecord = {
  productId: string;
  sourceId: string;
  productTime: string;
  validFrom: string;
  validTo: string;
  sourceUrl: string;
  payloadSha256: string;
  storageKey: string;
  storageBackend: ForecastRasterStorageBackend;
  contentType: string;
  byteLength: number;
  sourceWidth: number;
  sourceHeight: number;
  groupPixels: number;
  gridWidth: number;
  gridHeight: number;
  summary: LhasaRiskRasterSummary;
  archivedAt: string;
};

type EventExposureAssessmentRow = {
  master_event_id: string;
  event_revision: string;
  aoi_hash: string;
  status: string;
  payload_json: string;
  computed_at: string;
  expires_at: string;
  updated_by: string;
};

export type OsmQueryCacheRecord<T = unknown> = {
  cacheKey: string;
  queryKind: "exposure" | "infrastructure";
  dataProfile: "public" | "china_daily";
  payload: T;
  fetchedAt: string;
  expiresAt: string;
  osmBaseTimestamp?: string;
};

type OsmQueryCacheRow = {
  cache_key: string;
  query_kind: string;
  data_profile: string;
  payload_json: string;
  fetched_at: string;
  expires_at: string;
  osm_base_timestamp: string | null;
};

let schemaReady: Promise<void> | null = null;
let databaseReady: Promise<DatabaseLike> | null = null;
let lastRetentionPruneAt = 0;
const operationalQueryBatchSize = 80;

type DatabaseStatement = {
  bind(...values: unknown[]): DatabaseStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
};

type DatabaseLike = {
  prepare(sql: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<unknown[]>;
};

type NodePreparedStatement = {
  run(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
};

class NodeStatement implements DatabaseStatement {
  private values: unknown[] = [];
  private readonly prepareStatement: () => NodePreparedStatement;

  constructor(prepareStatement: () => NodePreparedStatement) {
    this.prepareStatement = prepareStatement;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    return this.prepareStatement().run(...this.values);
  }

  async all<T>() {
    return { results: this.prepareStatement().all(...this.values) as T[] };
  }

  async first<T>() {
    return (this.prepareStatement().get(...this.values) as T | undefined) ?? null;
  }
}

async function loadCloudflareDatabase() {
  try {
    const workers = await import("cloudflare:workers");
    return (workers.env as { DB?: DatabaseLike }).DB ?? null;
  } catch {
    return null;
  }
}

async function loadNodeDatabase(): Promise<DatabaseLike> {
  // Keep Node-only modules out of the Cloudflare bundle while allowing the same
  // API handlers to run under vinext start on a conventional VPS.
  const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const [{ DatabaseSync }, fs, path] = await Promise.all([
    dynamicImport("node:sqlite") as Promise<{ DatabaseSync: new (filename: string) => {
      exec(sql: string): void;
      prepare(sql: string): NodePreparedStatement;
    } }>,
    dynamicImport("node:fs") as Promise<{ mkdirSync(path: string, options: { recursive: boolean }): void }>,
    dynamicImport("node:path") as Promise<{ dirname(path: string): string; resolve(path: string): string }>,
  ]);
  const configuredPath = process.env.TIANXUN_SQLITE_PATH || ".data/operational.sqlite";
  const sqlitePath = path.resolve(configuredPath);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  return {
    prepare(sql) {
      return new NodeStatement(() => sqlite.prepare(sql));
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function database() {
  if (!databaseReady) {
    databaseReady = loadCloudflareDatabase().then((db) => db ?? loadNodeDatabase());
  }
  return databaseReady;
}

function evidenceReferencesBySource(events: DisasterEvent[]) {
  const references = new Map<string, Set<string>>();
  for (const event of events) {
    for (const evidence of event.evidence) {
      if (!isValidSourceEventId(evidence.sourceEventId)) continue;
      const sourceReferences = references.get(evidence.source) ?? new Set<string>();
      sourceReferences.add(evidence.sourceEventId);
      references.set(evidence.source, sourceReferences);
    }
  }
  return references;
}

async function loadRelevantTombstones(db: DatabaseLike, events: DisasterEvent[]) {
  const rows: { source: string; source_event_id: string }[] = [];
  for (const [source, sourceEventIds] of evidenceReferencesBySource(events)) {
    const ids = [...sourceEventIds];
    for (let offset = 0; offset < ids.length; offset += operationalQueryBatchSize) {
      const batch = ids.slice(offset, offset + operationalQueryBatchSize);
      const placeholders = batch.map(() => "?").join(",");
      const result = await db.prepare(`SELECT source, source_event_id FROM event_tombstones WHERE source = ? AND source_event_id IN (${placeholders})`)
        .bind(source, ...batch).all<{ source: string; source_event_id: string }>();
      rows.push(...result.results);
    }
  }
  return rows;
}

async function loadRelevantClaims(db: DatabaseLike, events: DisasterEvent[]) {
  const rows: { source: string; source_event_id: string; master_event_id: string; hazard: string }[] = [];
  for (const [source, sourceEventIds] of evidenceReferencesBySource(events)) {
    const ids = [...sourceEventIds];
    for (let offset = 0; offset < ids.length; offset += operationalQueryBatchSize) {
      const batch = ids.slice(offset, offset + operationalQueryBatchSize);
      const placeholders = batch.map(() => "?").join(",");
      const result = await db.prepare(`SELECT source, source_event_id, master_event_id, hazard FROM event_source_claims WHERE source = ? AND source_event_id IN (${placeholders})`)
        .bind(source, ...batch).all<{ source: string; source_event_id: string; master_event_id: string; hazard: string }>();
      rows.push(...result.results);
    }
  }
  return rows;
}

export function ensureOperationalSchema() {
  if (schemaReady) return schemaReady;
  const statements = [
    `CREATE TABLE IF NOT EXISTS canonical_events (id TEXT PRIMARY KEY NOT NULL, hazard TEXT NOT NULL, title TEXT NOT NULL, lifecycle_status TEXT NOT NULL, severity TEXT NOT NULL, geometry_type TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, location_quality TEXT NOT NULL, location_accuracy_km REAL NOT NULL, confidence_score INTEGER NOT NULL, occurred_at TEXT NOT NULL, updated_at TEXT NOT NULL, observation_expires_at TEXT NOT NULL, payload_json TEXT NOT NULL, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS canonical_events_hazard_status_idx ON canonical_events (hazard, lifecycle_status)`,
    `CREATE INDEX IF NOT EXISTS canonical_events_updated_idx ON canonical_events (updated_at)`,
    `CREATE TABLE IF NOT EXISTS event_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, master_event_id TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT NOT NULL, source_event_id TEXT NOT NULL, observed_at TEXT NOT NULL, role TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS event_evidence_source_event_uidx ON event_evidence (master_event_id, source, source_event_id)`,
    `CREATE INDEX IF NOT EXISTS event_evidence_master_idx ON event_evidence (master_event_id)`,
    `CREATE TABLE IF NOT EXISTS satellite_tasks (task_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, master_event_id TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'legacy', title TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, aoi_type TEXT NOT NULL, aoi_json TEXT NOT NULL, sensors_json TEXT NOT NULL, imaging_start TEXT NOT NULL, imaging_end TEXT NOT NULL, aoi_approval TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, event_revision TEXT NOT NULL DEFAULT '', aoi_hash TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_status_priority_idx ON satellite_tasks (status, priority)`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_event_idx ON satellite_tasks (master_event_id)`,
    `CREATE TABLE IF NOT EXISTS task_cancellation_intents (task_id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL DEFAULT 'legacy', cancelled_at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS task_cancellation_intents_time_idx ON task_cancellation_intents (cancelled_at)`,
    `CREATE TABLE IF NOT EXISTS task_export_packages (package_id TEXT PRIMARY KEY NOT NULL, format TEXT NOT NULL, task_ids_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS task_export_packages_created_idx ON task_export_packages (created_at)`,
    `CREATE TABLE IF NOT EXISTS task_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS task_status_history_task_idx ON task_status_history (task_id, changed_at)`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_insert AFTER INSERT ON satellite_tasks BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, NULL, NEW.status, 'task created'); END`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_update AFTER UPDATE OF status ON satellite_tasks WHEN OLD.status != NEW.status BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, OLD.status, NEW.status, 'status changed'); END`,
    `CREATE TABLE IF NOT EXISTS task_revision_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT NOT NULL, actor TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS task_revision_history_task_revision_uidx ON task_revision_history (task_id, revision)`,
    `CREATE INDEX IF NOT EXISTS task_revision_history_owner_time_idx ON task_revision_history (owner, changed_at)`,
    `CREATE TABLE IF NOT EXISTS event_tombstones (source TEXT NOT NULL, source_event_id TEXT NOT NULL, reason TEXT NOT NULL, resolved_at TEXT NOT NULL, PRIMARY KEY (source, source_event_id))`,
    `CREATE TABLE IF NOT EXISTS event_source_claims (source TEXT NOT NULL, source_event_id TEXT NOT NULL, master_event_id TEXT NOT NULL, hazard TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (source, source_event_id))`,
    `CREATE TABLE IF NOT EXISTS event_quarantine (master_event_id TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL, quarantined_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS operational_changes (id TEXT PRIMARY KEY NOT NULL, change_type TEXT NOT NULL, master_event_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS operational_changes_created_idx ON operational_changes (created_at, id)`,
    `CREATE TABLE IF NOT EXISTS planning_scenarios (scenario_id TEXT PRIMARY KEY NOT NULL, series_id TEXT NOT NULL, version INTEGER NOT NULL, parent_scenario_id TEXT, owner TEXT NOT NULL, name TEXT NOT NULL, problem_fingerprint TEXT NOT NULL, objective_score INTEGER NOT NULL, assignment_count INTEGER NOT NULL, conditional_assignment_count INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS planning_scenarios_series_version_uidx ON planning_scenarios (series_id, version)`,
    `CREATE INDEX IF NOT EXISTS planning_scenarios_owner_time_idx ON planning_scenarios (owner, created_at)`,
    `CREATE TABLE IF NOT EXISTS satellite_orbits (norad_id INTEGER PRIMARY KEY NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', last_attempt_at TEXT NOT NULL, last_success_at TEXT, last_error TEXT)`,
    `CREATE INDEX IF NOT EXISTS satellite_orbits_success_idx ON satellite_orbits (last_success_at)`,
    `CREATE TABLE IF NOT EXISTS road_disruptions (disruption_id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, lifecycle_status TEXT NOT NULL, verification TEXT NOT NULL, revision INTEGER NOT NULL, valid_from TEXT, valid_to TEXT, payload_json TEXT NOT NULL, reported_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS road_disruptions_active_time_idx ON road_disruptions (lifecycle_status, valid_to, updated_at)`,
    `CREATE INDEX IF NOT EXISTS road_disruptions_owner_idx ON road_disruptions (owner, updated_at)`,
    `CREATE TABLE IF NOT EXISTS road_disruption_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, disruption_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS road_disruption_history_revision_uidx ON road_disruption_history (disruption_id, revision)`,
    `CREATE TABLE IF NOT EXISTS web_sessions (session_hash TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, auth_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS web_sessions_expiry_idx ON web_sessions (expires_at)`,
    `CREATE INDEX IF NOT EXISTS web_sessions_user_seen_idx ON web_sessions (username, last_seen_at)`,
    `CREATE TABLE IF NOT EXISTS source_registry (source_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, tier TEXT NOT NULL, role TEXT NOT NULL, authority_class TEXT NOT NULL, setup_url TEXT NOT NULL, poll_interval_minutes INTEGER NOT NULL, latency_slo_minutes INTEGER NOT NULL, update_semantics TEXT NOT NULL, geometry_semantics TEXT NOT NULL, license_note TEXT NOT NULL, state TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_duration_ms INTEGER NOT NULL DEFAULT 0, last_count INTEGER NOT NULL DEFAULT 0, last_message TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS source_registry_state_idx ON source_registry (state, last_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS source_registry_success_idx ON source_registry (last_success_at)`,
    `CREATE TABLE IF NOT EXISTS source_payloads (payload_sha256 TEXT PRIMARY KEY NOT NULL, content_type TEXT NOT NULL, body_text TEXT NOT NULL, byte_length INTEGER NOT NULL, stored_byte_length INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS source_fetch_runs (run_id TEXT PRIMARY KEY NOT NULL, refresh_id TEXT NOT NULL, source_id TEXT NOT NULL, requested_url TEXT NOT NULL, fetched_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, http_status INTEGER, ok INTEGER NOT NULL, payload_sha256 TEXT, error_message TEXT)`,
    `CREATE INDEX IF NOT EXISTS source_fetch_runs_source_time_idx ON source_fetch_runs (source_id, fetched_at)`,
    `CREATE INDEX IF NOT EXISTS source_fetch_runs_refresh_idx ON source_fetch_runs (refresh_id)`,
    `CREATE TABLE IF NOT EXISTS ingestion_snapshots (snapshot_id TEXT PRIMARY KEY NOT NULL, refresh_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload_sha256 TEXT NOT NULL, event_count INTEGER NOT NULL, source_count INTEGER NOT NULL, payload_json TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ingestion_snapshots_payload_idx ON ingestion_snapshots (payload_sha256)`,
    `CREATE INDEX IF NOT EXISTS ingestion_snapshots_captured_idx ON ingestion_snapshots (captured_at)`,
    `CREATE TABLE IF NOT EXISTS event_reviews (master_event_id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '', conclusion TEXT NOT NULL DEFAULT '', exposure_index INTEGER, exposure_basis TEXT, vulnerability_index INTEGER, vulnerability_basis TEXT, alert_acknowledged_at TEXT, alert_acknowledged_by TEXT, alert_acknowledged_version TEXT, event_revision TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS event_reviews_status_time_idx ON event_reviews (status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS event_reviews_assignee_status_idx ON event_reviews (assignee, status)`,
    `CREATE TABLE IF NOT EXISTS event_review_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, master_event_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS event_review_history_event_revision_uidx ON event_review_history (master_event_id, revision)`,
    `CREATE INDEX IF NOT EXISTS event_review_history_event_time_idx ON event_review_history (master_event_id, changed_at)`,
    `CREATE TABLE IF NOT EXISTS event_exposure_assessments (master_event_id TEXT PRIMARY KEY NOT NULL, event_revision TEXT NOT NULL, aoi_hash TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, computed_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS event_exposure_assessments_expiry_idx ON event_exposure_assessments (expires_at, computed_at)`,
    `CREATE INDEX IF NOT EXISTS event_exposure_assessments_status_idx ON event_exposure_assessments (status, computed_at)`,
    `CREATE TABLE IF NOT EXISTS osm_query_cache (cache_key TEXT PRIMARY KEY NOT NULL, query_kind TEXT NOT NULL, data_profile TEXT NOT NULL, payload_json TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL, osm_base_timestamp TEXT)`,
    `CREATE INDEX IF NOT EXISTS osm_query_cache_kind_profile_idx ON osm_query_cache (query_kind, data_profile, fetched_at)`,
    `CREATE INDEX IF NOT EXISTS osm_query_cache_expiry_idx ON osm_query_cache (expires_at)`,
    `CREATE TABLE IF NOT EXISTS mission_execution_receipts (receipt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, master_event_id TEXT NOT NULL, owner TEXT NOT NULL, provider TEXT NOT NULL, external_task_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, task_revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS mission_execution_receipts_task_time_idx ON mission_execution_receipts (task_id, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS mission_execution_receipts_provider_external_idx ON mission_execution_receipts (provider, external_task_id)`,
    `CREATE TABLE IF NOT EXISTS observation_products (item_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, master_event_id TEXT NOT NULL, owner TEXT NOT NULL, collection_id TEXT NOT NULL, product_level TEXT NOT NULL, quality_status TEXT NOT NULL, acquired_at TEXT NOT NULL, geometry_json TEXT NOT NULL, bbox_json TEXT NOT NULL, stac_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS observation_products_task_time_idx ON observation_products (task_id, acquired_at)`,
    `CREATE INDEX IF NOT EXISTS observation_products_event_time_idx ON observation_products (master_event_id, acquired_at)`,
    `CREATE INDEX IF NOT EXISTS observation_products_owner_quality_idx ON observation_products (owner, quality_status)`,
    `CREATE TABLE IF NOT EXISTS aoi_work_packages (package_id TEXT PRIMARY KEY NOT NULL, master_event_id TEXT NOT NULL, source_task_id TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, geometry_json TEXT NOT NULL, aoi_hash TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '', reviewer TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, review_note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS aoi_work_packages_task_status_idx ON aoi_work_packages (source_task_id, status)`,
    `CREATE INDEX IF NOT EXISTS aoi_work_packages_owner_status_idx ON aoi_work_packages (owner, status)`,
    `CREATE INDEX IF NOT EXISTS aoi_work_packages_assignee_status_idx ON aoi_work_packages (assignee, status)`,
    `CREATE TABLE IF NOT EXISTS aoi_work_package_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, package_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS aoi_work_package_history_revision_uidx ON aoi_work_package_history (package_id, revision)`,
    `CREATE INDEX IF NOT EXISTS aoi_work_package_history_time_idx ON aoi_work_package_history (package_id, changed_at)`,
    `CREATE TABLE IF NOT EXISTS evaluation_benchmark_cases (case_id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, hazard TEXT NOT NULL, objective TEXT NOT NULL DEFAULT 'event_detection', hazard_subtype TEXT, outcome TEXT NOT NULL DEFAULT 'event', calibration_group TEXT, occurred_at TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, location_tolerance_km REAL NOT NULL, event_time_tolerance_hours REAL NOT NULL, accepted_lead_minutes INTEGER NOT NULL DEFAULT 0, detection_deadline_minutes INTEGER NOT NULL, expected_severity TEXT, required_source TEXT, minimum_forecast_risk_percent REAL, provenance_url TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', verification_status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS evaluation_cases_hazard_time_idx ON evaluation_benchmark_cases (hazard, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS evaluation_cases_verification_time_idx ON evaluation_benchmark_cases (verification_status, occurred_at)`,
    `CREATE TABLE IF NOT EXISTS evaluation_runs (run_id TEXT PRIMARY KEY NOT NULL, model_version TEXT NOT NULL, case_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL, detected_count INTEGER NOT NULL, report_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS evaluation_runs_created_idx ON evaluation_runs (created_at)`,
    `CREATE TABLE IF NOT EXISTS lhasa_v1_granule_probes (case_id TEXT PRIMARY KEY NOT NULL, product_date TEXT NOT NULL, status TEXT NOT NULL, collection_concept_id TEXT NOT NULL, granule_concept_id TEXT, producer_granule_id TEXT, download_url TEXT, granule_size_mb REAL, time_start TEXT, time_end TEXT, message TEXT NOT NULL, checked_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS lhasa_v1_granule_probes_status_date_idx ON lhasa_v1_granule_probes (status, product_date)`,
    `CREATE TABLE IF NOT EXISTS forecast_raster_products (product_id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, product_time TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT NOT NULL, source_url TEXT NOT NULL, payload_sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, storage_backend TEXT NOT NULL, content_type TEXT NOT NULL, byte_length INTEGER NOT NULL, source_width INTEGER NOT NULL, source_height INTEGER NOT NULL, group_pixels INTEGER NOT NULL, grid_width INTEGER NOT NULL, grid_height INTEGER NOT NULL, summary_json TEXT NOT NULL, archived_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS forecast_raster_products_source_time_uidx ON forecast_raster_products (source_id, product_time)`,
    `CREATE INDEX IF NOT EXISTS forecast_raster_products_time_idx ON forecast_raster_products (product_time, source_id)`,
  ];
  schemaReady = database().then(async (db) => {
    await db.batch(statements.map((statement) => db.prepare(statement)));
    const columns = await db.prepare(`PRAGMA table_info(satellite_tasks)`).all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    const migrations: DatabaseStatement[] = [];
    if (!names.has("revision")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`));
    if (!names.has("event_revision")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN event_revision TEXT NOT NULL DEFAULT ''`));
    if (!names.has("aoi_hash")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN aoi_hash TEXT NOT NULL DEFAULT ''`));
    if (!names.has("owner")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy'`));
    if (migrations.length) await db.batch(migrations);
    const evaluationColumns = await db.prepare(`PRAGMA table_info(evaluation_benchmark_cases)`).all<{ name: string }>();
    const evaluationNames = new Set(evaluationColumns.results.map((column) => column.name));
    const evaluationMigrations: DatabaseStatement[] = [];
    if (!evaluationNames.has("objective")) evaluationMigrations.push(db.prepare(`ALTER TABLE evaluation_benchmark_cases ADD COLUMN objective TEXT NOT NULL DEFAULT 'event_detection'`));
    if (!evaluationNames.has("hazard_subtype")) evaluationMigrations.push(db.prepare(`ALTER TABLE evaluation_benchmark_cases ADD COLUMN hazard_subtype TEXT`));
    if (!evaluationNames.has("minimum_forecast_risk_percent")) evaluationMigrations.push(db.prepare(`ALTER TABLE evaluation_benchmark_cases ADD COLUMN minimum_forecast_risk_percent REAL`));
    if (!evaluationNames.has("outcome")) evaluationMigrations.push(db.prepare(`ALTER TABLE evaluation_benchmark_cases ADD COLUMN outcome TEXT NOT NULL DEFAULT 'event'`));
    if (!evaluationNames.has("calibration_group")) evaluationMigrations.push(db.prepare(`ALTER TABLE evaluation_benchmark_cases ADD COLUMN calibration_group TEXT`));
    if (evaluationMigrations.length) await db.batch(evaluationMigrations);
    const intentColumns = await db.prepare(`PRAGMA table_info(task_cancellation_intents)`).all<{ name: string }>();
    if (!intentColumns.results.some((column) => column.name === "owner")) await db.prepare(`ALTER TABLE task_cancellation_intents ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy'`).run();
    const sessionColumns = await db.prepare(`PRAGMA table_info(web_sessions)`).all<{ name: string }>();
    if (!sessionColumns.results.some((column) => column.name === "auth_version")) await db.prepare(`ALTER TABLE web_sessions ADD COLUMN auth_version TEXT NOT NULL DEFAULT ''`).run();
    await db.batch([
      db.prepare(`CREATE INDEX IF NOT EXISTS satellite_tasks_owner_status_idx ON satellite_tasks (owner, status)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS task_cancellation_intents_owner_time_idx ON task_cancellation_intents (owner, cancelled_at)`),
    ]);
    await db.prepare(`INSERT OR IGNORE INTO event_source_claims (source, source_event_id, master_event_id, hazard, claimed_at)
      SELECT e.source, e.source_event_id, e.master_event_id, c.hazard, CURRENT_TIMESTAMP
      FROM event_evidence e JOIN canonical_events c ON c.id = e.master_event_id
      WHERE lower(e.source_event_id) NOT LIKE '%undefined%' AND lower(e.source_event_id) NOT LIKE '%null%' AND lower(e.source_event_id) NOT LIKE '%nan%'
      ORDER BY e.observed_at DESC`).run();
    await quarantineInvalidOperationalRecords(db);
  })
    .catch((error) => {
      schemaReady = null;
      throw error;
    });
  return schemaReady;
}

export async function persistCanonicalEvents(events: DisasterEvent[]): Promise<DisasterEvent[] | null> {
  try {
    await ensureOperationalSchema();
    const db = await database();
    const syncMarker = new Date().toISOString();
    const [tombstones, claimRows] = await Promise.all([
      loadRelevantTombstones(db, events),
      loadRelevantClaims(db, events),
    ]);
    const blockedEvidence = new Set(tombstones.map((item) => `${item.source}|${item.source_event_id}`));
    const claims = new Map(claimRows.map((item) => [`${item.source}|${item.source_event_id}`, item]));
    const acceptedEvents: DisasterEvent[] = [];
    for (const originalEvent of events) {
      if (eventHasInvalidIdentity(originalEvent)) continue;
      const evidence = originalEvent.evidence.filter((item) => isValidSourceEventId(item.sourceEventId) && !blockedEvidence.has(`${item.source}|${item.sourceEventId}`));
      if (!evidence.length) continue;
      const existingMasters = new Set(evidence.flatMap((item) => {
        const claim = claims.get(`${item.source}|${item.sourceEventId}`);
        return claim && claim.hazard === originalEvent.hazard ? [claim.master_event_id] : [];
      }));
      const masterEventId = existingMasters.size > 1
        ? await reconcileCanonicalMasters(db, [...existingMasters], originalEvent)
        : [...existingMasters][0] ?? originalEvent.masterEventId;
      const acceptedEvidence = evidence.filter((item) => {
        const claim = claims.get(`${item.source}|${item.sourceEventId}`);
        return !claim || (claim.hazard === originalEvent.hazard && (claim.master_event_id === masterEventId || existingMasters.has(claim.master_event_id)));
      });
      if (!acceptedEvidence.length) continue;
      const event = {
        ...originalEvent,
        masterEventId,
        evidence: acceptedEvidence,
        evidenceCount: acceptedEvidence.length,
        independentSourceCount: distinctEvidenceSources(acceptedEvidence),
        bulletinCount: originalEvent.updateHistory?.length ?? originalEvent.updateCount ?? acceptedEvidence.length,
      };
      acceptedEvidence.forEach((item) => claims.set(`${item.source}|${item.sourceEventId}`, { source: item.source, source_event_id: item.sourceEventId, master_event_id: masterEventId, hazard: event.hazard }));
      acceptedEvents.push(event);
    }
    const canonicalEvents = collapseCanonicalEventsByMasterId(acceptedEvents);
    const statements = canonicalEvents.flatMap((event) => [
      db.prepare(`INSERT INTO canonical_events (id, hazard, title, lifecycle_status, severity, geometry_type, latitude, longitude, location_quality, location_accuracy_km, confidence_score, occurred_at, updated_at, observation_expires_at, payload_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hazard=excluded.hazard, title=excluded.title, lifecycle_status=excluded.lifecycle_status, severity=excluded.severity, geometry_type=excluded.geometry_type, latitude=excluded.latitude, longitude=excluded.longitude, location_quality=excluded.location_quality, location_accuracy_km=excluded.location_accuracy_km, confidence_score=excluded.confidence_score, occurred_at=excluded.occurred_at, updated_at=excluded.updated_at, observation_expires_at=excluded.observation_expires_at, payload_json=excluded.payload_json, synced_at=excluded.synced_at WHERE excluded.updated_at >= canonical_events.updated_at`)
        .bind(event.masterEventId, event.hazard, event.title, event.lifecycleStatus, event.severity, event.geometryType, event.latitude, event.longitude, event.locationQuality, event.locationAccuracyKm, event.confidenceScore, event.occurredAt, event.updatedAt, event.observationExpiresAt, JSON.stringify(event), syncMarker),
      ...event.evidence.map((item) => db.prepare(`INSERT INTO event_evidence (master_event_id, source, source_url, source_event_id, observed_at, role) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(master_event_id, source, source_event_id) DO UPDATE SET source_url=excluded.source_url, observed_at=excluded.observed_at, role=excluded.role`)
        .bind(event.masterEventId, item.source, item.sourceUrl, item.sourceEventId, item.observedAt, item.role)),
      ...event.evidence.map((item) => db.prepare(`INSERT INTO event_source_claims (source, source_event_id, master_event_id, hazard, claimed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, source_event_id) DO NOTHING`)
        .bind(item.source, item.sourceEventId, event.masterEventId, event.hazard, syncMarker)),
    ]);
    // Publish one ingestion snapshot atomically. A partially committed refresh
    // is more dangerous than rejecting an oversized run because task/event
    // provenance depends on canonical rows and evidence changing together.
    if (statements.length) await db.batch(statements);
    await resolveClaimAliases(db, canonicalEvents.map((event) => event.masterEventId));
    await db.prepare(`UPDATE canonical_events SET lifecycle_status = CASE WHEN observation_expires_at <= ? THEN 'archived' ELSE 'monitoring' END WHERE synced_at < ? AND lifecycle_status IN ('active', 'monitoring')`)
      .bind(syncMarker, syncMarker).run();
    await pruneOperationalDataIfDue(db, Date.now());
    return await readPersistedCanonicalEvents(db, canonicalEvents);
  } catch (error) {
    console.error("canonical event persistence unavailable", error);
    return null;
  }
}

async function pruneOperationalDataIfDue(db: DatabaseLike, nowMs: number) {
  if (nowMs - lastRetentionPruneAt < 6 * 60 * 60_000) return;
  const eventCutoff = new Date(nowMs - 180 * 86_400_000).toISOString();
  const auditCutoff = new Date(nowMs - 365 * 86_400_000).toISOString();
  const expiredSessionCutoff = new Date(nowMs).toISOString();
  const removableEvents = `SELECT id FROM canonical_events c WHERE c.lifecycle_status IN ('resolved','archived') AND c.observation_expires_at < ? AND NOT EXISTS (SELECT 1 FROM satellite_tasks t WHERE t.master_event_id=c.id)`;
  try {
    await db.batch([
      db.prepare(`DELETE FROM event_evidence WHERE master_event_id IN (${removableEvents})`).bind(eventCutoff),
      db.prepare(`DELETE FROM event_source_claims WHERE master_event_id IN (${removableEvents})`).bind(eventCutoff),
      db.prepare(`DELETE FROM event_quarantine WHERE master_event_id IN (${removableEvents})`).bind(eventCutoff),
      db.prepare(`DELETE FROM canonical_events WHERE id IN (${removableEvents})`).bind(eventCutoff),
      db.prepare(`DELETE FROM operational_changes WHERE created_at < ?`).bind(eventCutoff),
      db.prepare(`DELETE FROM task_export_packages WHERE created_at < ?`).bind(auditCutoff),
      db.prepare(`DELETE FROM task_status_history WHERE changed_at < ? AND EXISTS (SELECT 1 FROM satellite_tasks t WHERE t.task_id=task_status_history.task_id AND t.status='cancelled')`).bind(auditCutoff),
      db.prepare(`DELETE FROM task_revision_history WHERE changed_at < ? AND EXISTS (SELECT 1 FROM satellite_tasks t WHERE t.task_id=task_revision_history.task_id AND t.status='cancelled')`).bind(auditCutoff),
      db.prepare(`DELETE FROM road_disruption_history WHERE changed_at < ? AND EXISTS (SELECT 1 FROM road_disruptions r WHERE r.disruption_id=road_disruption_history.disruption_id AND r.lifecycle_status IN ('resolved','rejected'))`).bind(auditCutoff),
      db.prepare(`DELETE FROM event_tombstones WHERE resolved_at < ? AND NOT EXISTS (SELECT 1 FROM event_evidence e WHERE e.source=event_tombstones.source AND e.source_event_id=event_tombstones.source_event_id)`).bind(auditCutoff),
      db.prepare(`DELETE FROM web_sessions WHERE expires_at <= ?`).bind(expiredSessionCutoff),
      db.prepare(`DELETE FROM source_fetch_runs WHERE fetched_at < ?`).bind(new Date(nowMs - 30 * 86_400_000).toISOString()),
      db.prepare(`DELETE FROM source_payloads WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM source_fetch_runs r WHERE r.payload_sha256=source_payloads.payload_sha256)`).bind(new Date(nowMs - 30 * 86_400_000).toISOString()),
      db.prepare(`DELETE FROM ingestion_snapshots WHERE captured_at < ?`).bind(new Date(nowMs - 90 * 86_400_000).toISOString()),
    ]);
    lastRetentionPruneAt = nowMs;
  } catch (error) {
    console.error("operational retention prune failed", error);
  }
}

export async function persistIngestionArtifacts(input: {
  refreshId: string;
  sources: SourceRegistryInput[];
  fetches: SourceFetchCapture[];
  snapshot: IngestionSnapshotRecord;
}) {
  await ensureOperationalSchema();
  const db = await database();
  const statements: DatabaseStatement[] = [];
  for (const source of input.sources) {
    statements.push(db.prepare(`INSERT INTO source_registry (source_id, name, tier, role, authority_class, setup_url, poll_interval_minutes, latency_slo_minutes, update_semantics, geometry_semantics, license_note, state, last_attempt_at, last_success_at, consecutive_failures, last_duration_ms, last_count, last_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='online' THEN ? ELSE NULL END, CASE WHEN ?='offline' THEN 1 ELSE 0 END, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET name=excluded.name, tier=excluded.tier, role=excluded.role, authority_class=excluded.authority_class, setup_url=excluded.setup_url, poll_interval_minutes=excluded.poll_interval_minutes, latency_slo_minutes=excluded.latency_slo_minutes, update_semantics=excluded.update_semantics, geometry_semantics=excluded.geometry_semantics, license_note=excluded.license_note, state=excluded.state, last_attempt_at=excluded.last_attempt_at, last_success_at=CASE WHEN excluded.state='online' THEN excluded.last_attempt_at ELSE source_registry.last_success_at END, consecutive_failures=CASE WHEN excluded.state='offline' THEN source_registry.consecutive_failures + 1 WHEN excluded.state='online' THEN 0 ELSE source_registry.consecutive_failures END, last_duration_ms=excluded.last_duration_ms, last_count=excluded.last_count, last_message=excluded.last_message`)
      .bind(source.sourceId, source.name, source.tier, source.role, source.authorityClass, source.setupUrl, source.pollIntervalMinutes, source.latencySloMinutes, source.updateSemantics, source.geometrySemantics, source.licenseNote, source.state, source.lastAttemptAt, source.state, source.lastAttemptAt, source.state, source.durationMs, source.count, source.message));
  }
  for (const fetch of input.fetches) {
    if (fetch.payloadSha256) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO source_payloads (payload_sha256, content_type, body_text, byte_length, stored_byte_length, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(fetch.payloadSha256, fetch.contentType, fetch.bodyText, fetch.byteLength, fetch.storedByteLength, fetch.truncated ? 1 : 0, fetch.fetchedAt));
    }
    statements.push(db.prepare(`INSERT OR IGNORE INTO source_fetch_runs (run_id, refresh_id, source_id, requested_url, fetched_at, duration_ms, http_status, ok, payload_sha256, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(fetch.runId, fetch.refreshId, fetch.sourceId, fetch.requestedUrl, fetch.fetchedAt, fetch.durationMs, fetch.httpStatus, fetch.ok ? 1 : 0, fetch.payloadSha256, fetch.errorMessage));
  }
  const previous = await db.prepare(`SELECT captured_at, payload_sha256 FROM ingestion_snapshots ORDER BY captured_at DESC LIMIT 1`).first<{ captured_at: string; payload_sha256: string }>();
  const sameRecentSnapshot = previous?.payload_sha256 === input.snapshot.payloadSha256
    && Date.parse(input.snapshot.capturedAt) - Date.parse(previous.captured_at) < 30 * 60_000;
  if (!sameRecentSnapshot) {
    statements.push(db.prepare(`INSERT INTO ingestion_snapshots (snapshot_id, refresh_id, captured_at, payload_sha256, event_count, source_count, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.snapshot.snapshotId, input.snapshot.refreshId, input.snapshot.capturedAt, input.snapshot.payloadSha256, input.snapshot.eventCount, input.snapshot.sourceCount, JSON.stringify(input.snapshot.payload)));
  }
  // D1 and the local SQLite adapter both support batch, but one refresh can
  // contain many independent source payloads. Chunking keeps individual D1
  // requests below practical statement/body limits without making raw archive
  // persistence part of the canonical-event transaction.
  for (let index = 0; index < statements.length; index += 24) await db.batch(statements.slice(index, index + 24));
  await pruneOperationalDataIfDue(db, Date.now());
}

export async function listSourceRegistry(sourceId?: string, limit = 80) {
  await ensureOperationalSchema();
  const db = await database();
  const sources = await db.prepare(`SELECT source_id AS sourceId, name, tier, role, authority_class AS authorityClass, setup_url AS setupUrl, poll_interval_minutes AS pollIntervalMinutes, latency_slo_minutes AS latencySloMinutes, update_semantics AS updateSemantics, geometry_semantics AS geometrySemantics, license_note AS licenseNote, state, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, consecutive_failures AS consecutiveFailures, last_duration_ms AS lastDurationMs, last_count AS lastCount, last_message AS lastMessage FROM source_registry ${sourceId ? "WHERE source_id=?" : ""} ORDER BY tier, name LIMIT ?`)
    .bind(...(sourceId ? [sourceId, limit] : [limit])).all<Record<string, unknown>>();
  const runs = sourceId
    ? await db.prepare(`SELECT run_id AS runId, refresh_id AS refreshId, source_id AS sourceId, requested_url AS requestedUrl, fetched_at AS fetchedAt, duration_ms AS durationMs, http_status AS httpStatus, ok, payload_sha256 AS payloadSha256, error_message AS errorMessage FROM source_fetch_runs WHERE source_id=? ORDER BY fetched_at DESC LIMIT 30`).bind(sourceId).all<Record<string, unknown>>()
    : { results: [] };
  return { sources: sources.results, runs: runs.results };
}

export async function getSourcePayloadPreview(payloadSha256: string) {
  await ensureOperationalSchema();
  const db = await database();
  return db.prepare(`SELECT payload_sha256 AS payloadSha256, content_type AS contentType, body_text AS bodyText, byte_length AS byteLength, stored_byte_length AS storedByteLength, truncated, created_at AS createdAt FROM source_payloads WHERE payload_sha256=?`).bind(payloadSha256).first<Record<string, unknown>>();
}

export async function getIngestionSnapshot(asOf: string): Promise<IngestionSnapshotRecord | null> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT snapshot_id AS snapshotId, refresh_id AS refreshId, captured_at AS capturedAt, payload_sha256 AS payloadSha256, event_count AS eventCount, source_count AS sourceCount, payload_json AS payloadJson FROM ingestion_snapshots WHERE captured_at <= ? ORDER BY captured_at DESC LIMIT 1`).bind(asOf).first<Record<string, unknown>>();
  if (!row) return null;
  try {
    return { snapshotId: String(row.snapshotId), refreshId: String(row.refreshId), capturedAt: String(row.capturedAt), payloadSha256: String(row.payloadSha256), eventCount: Number(row.eventCount), sourceCount: Number(row.sourceCount), payload: JSON.parse(String(row.payloadJson)) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function listIngestionSnapshots(limit = 24) {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT snapshot_id AS snapshotId, captured_at AS capturedAt, event_count AS eventCount, source_count AS sourceCount FROM ingestion_snapshots ORDER BY captured_at DESC LIMIT ?`).bind(Math.max(1, Math.min(100, limit))).all<Record<string, unknown>>();
  return rows.results;
}

export async function getForecastRasterProduct(productId: string): Promise<ForecastRasterProductRecord | null> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`${forecastRasterSelectSql} WHERE product_id=? LIMIT 1`).bind(productId).first<Record<string, unknown>>();
  return row ? forecastRasterProductFromRow(row) : null;
}

export async function upsertForecastRasterProduct(product: ForecastRasterProductRecord) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO forecast_raster_products (product_id, source_id, product_time, valid_from, valid_to, source_url, payload_sha256, storage_key, storage_backend, content_type, byte_length, source_width, source_height, group_pixels, grid_width, grid_height, summary_json, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET source_id=excluded.source_id, product_time=excluded.product_time, valid_from=excluded.valid_from, valid_to=excluded.valid_to, source_url=excluded.source_url, payload_sha256=excluded.payload_sha256, storage_key=excluded.storage_key, storage_backend=excluded.storage_backend, content_type=excluded.content_type, byte_length=excluded.byte_length, source_width=excluded.source_width, source_height=excluded.source_height, group_pixels=excluded.group_pixels, grid_width=excluded.grid_width, grid_height=excluded.grid_height, summary_json=excluded.summary_json, archived_at=excluded.archived_at`)
    .bind(product.productId, product.sourceId, product.productTime, product.validFrom, product.validTo, product.sourceUrl, product.payloadSha256, product.storageKey, product.storageBackend, product.contentType, product.byteLength, product.sourceWidth, product.sourceHeight, product.groupPixels, product.gridWidth, product.gridHeight, JSON.stringify(product.summary), product.archivedAt).run();
  return product;
}

export async function listForecastRasterProducts(from?: string, to?: string, limit = 1_500): Promise<ForecastRasterProductRecord[]> {
  await ensureOperationalSchema();
  const db = await database();
  const boundedLimit = Math.max(1, Math.min(1_500, Math.round(limit)));
  const rows = from && to
    ? await db.prepare(`${forecastRasterSelectSql} WHERE product_time BETWEEN ? AND ? ORDER BY product_time, product_id LIMIT ?`).bind(from, to, boundedLimit).all<Record<string, unknown>>()
    : await db.prepare(`${forecastRasterSelectSql} ORDER BY product_time DESC, product_id LIMIT ?`).bind(boundedLimit).all<Record<string, unknown>>();
  return rows.results.map(forecastRasterProductFromRow).filter((item): item is ForecastRasterProductRecord => Boolean(item));
}

export async function forecastRasterArchiveStatus() {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT COUNT(*) AS productCount, MIN(product_time) AS firstProductAt, MAX(product_time) AS lastProductAt, SUM(byte_length) AS archivedBytes FROM forecast_raster_products`).first<Record<string, unknown>>();
  return {
    productCount: Number(row?.productCount ?? 0),
    firstProductAt: row?.firstProductAt ? String(row.firstProductAt) : null,
    lastProductAt: row?.lastProductAt ? String(row.lastProductAt) : null,
    archivedBytes: Number(row?.archivedBytes ?? 0),
  };
}

const forecastRasterSelectSql = `SELECT product_id AS productId, source_id AS sourceId, product_time AS productTime, valid_from AS validFrom, valid_to AS validTo, source_url AS sourceUrl, payload_sha256 AS payloadSha256, storage_key AS storageKey, storage_backend AS storageBackend, content_type AS contentType, byte_length AS byteLength, source_width AS sourceWidth, source_height AS sourceHeight, group_pixels AS groupPixels, grid_width AS gridWidth, grid_height AS gridHeight, summary_json AS summaryJson, archived_at AS archivedAt FROM forecast_raster_products`;

function forecastRasterProductFromRow(row: Record<string, unknown>): ForecastRasterProductRecord | null {
  try {
    if (!row.productId || !row.sourceId || !row.productTime || !row.storageKey || !["r2", "filesystem"].includes(String(row.storageBackend))) return null;
    const summary = JSON.parse(String(row.summaryJson)) as LhasaRiskRasterSummary;
    if (!Array.isArray(summary.histogram) || summary.histogram.length !== 101) return null;
    return {
      productId: String(row.productId), sourceId: String(row.sourceId), productTime: String(row.productTime), validFrom: String(row.validFrom), validTo: String(row.validTo),
      sourceUrl: String(row.sourceUrl), payloadSha256: String(row.payloadSha256), storageKey: String(row.storageKey), storageBackend: String(row.storageBackend) as ForecastRasterStorageBackend,
      contentType: String(row.contentType), byteLength: Number(row.byteLength), sourceWidth: Number(row.sourceWidth), sourceHeight: Number(row.sourceHeight), groupPixels: Number(row.groupPixels),
      gridWidth: Number(row.gridWidth), gridHeight: Number(row.gridHeight), summary, archivedAt: String(row.archivedAt),
    };
  } catch {
    return null;
  }
}

export async function listEvaluationCases(limit = 100): Promise<EvaluationBenchmarkCase[]> {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT case_id AS caseId, title, hazard, objective, hazard_subtype AS hazardSubtype, outcome, calibration_group AS calibrationGroup, occurred_at AS occurredAt, latitude, longitude, location_tolerance_km AS locationToleranceKm, event_time_tolerance_hours AS eventTimeToleranceHours, accepted_lead_minutes AS acceptedLeadMinutes, detection_deadline_minutes AS detectionDeadlineMinutes, expected_severity AS expectedSeverity, required_source AS requiredSource, minimum_forecast_risk_percent AS minimumForecastRiskPercent, provenance_url AS provenanceUrl, notes, verification_status AS verificationStatus, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM evaluation_benchmark_cases ORDER BY occurred_at DESC, case_id LIMIT ?`)
    .bind(Math.max(1, Math.min(100, limit))).all<Record<string, unknown>>();
  return rows.results.map(evaluationCaseFromRow).filter((item): item is EvaluationBenchmarkCase => Boolean(item));
}

export async function upsertEvaluationCase(benchmark: EvaluationBenchmarkCase) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO evaluation_benchmark_cases (case_id, title, hazard, objective, hazard_subtype, outcome, calibration_group, occurred_at, latitude, longitude, location_tolerance_km, event_time_tolerance_hours, accepted_lead_minutes, detection_deadline_minutes, expected_severity, required_source, minimum_forecast_risk_percent, provenance_url, notes, verification_status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id) DO UPDATE SET title=excluded.title, hazard=excluded.hazard, objective=excluded.objective, hazard_subtype=excluded.hazard_subtype, outcome=excluded.outcome, calibration_group=excluded.calibration_group, occurred_at=excluded.occurred_at, latitude=excluded.latitude, longitude=excluded.longitude, location_tolerance_km=excluded.location_tolerance_km, event_time_tolerance_hours=excluded.event_time_tolerance_hours, accepted_lead_minutes=excluded.accepted_lead_minutes, detection_deadline_minutes=excluded.detection_deadline_minutes, expected_severity=excluded.expected_severity, required_source=excluded.required_source, minimum_forecast_risk_percent=excluded.minimum_forecast_risk_percent, provenance_url=excluded.provenance_url, notes=excluded.notes, verification_status=excluded.verification_status, updated_at=excluded.updated_at`)
    .bind(benchmark.caseId, benchmark.title, benchmark.hazard, benchmark.objective, benchmark.hazardSubtype ?? null, benchmark.outcome === "no_event" ? "no_event" : "event", benchmark.calibrationGroup ?? null, benchmark.occurredAt, benchmark.latitude, benchmark.longitude, benchmark.locationToleranceKm, benchmark.eventTimeToleranceHours, benchmark.acceptedLeadMinutes, benchmark.detectionDeadlineMinutes, benchmark.expectedSeverity ?? null, benchmark.requiredSource ?? null, benchmark.minimumForecastRiskPercent ?? null, benchmark.provenanceUrl, benchmark.notes, benchmark.verificationStatus, benchmark.createdBy, benchmark.createdAt, benchmark.updatedAt).run();
  return benchmark;
}

export async function deleteEvaluationCase(caseId: string) {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT case_id FROM evaluation_benchmark_cases WHERE case_id=?`).bind(caseId).first<{ case_id: string }>();
  if (!existing) return false;
  await db.prepare(`DELETE FROM lhasa_v1_granule_probes WHERE case_id=?`).bind(caseId).run();
  await db.prepare(`DELETE FROM evaluation_benchmark_cases WHERE case_id=?`).bind(caseId).run();
  return true;
}

export async function listLhasaV1GranuleProbes(limit = 100): Promise<LhasaV1GranuleProbeRecord[]> {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT case_id AS caseId, product_date AS productDate, status, collection_concept_id AS collectionConceptId, granule_concept_id AS granuleConceptId, producer_granule_id AS producerGranuleId, download_url AS downloadUrl, granule_size_mb AS granuleSizeMb, time_start AS timeStart, time_end AS timeEnd, message, checked_at AS checkedAt FROM lhasa_v1_granule_probes ORDER BY product_date, case_id LIMIT ?`)
    .bind(Math.max(1, Math.min(100, limit))).all<Record<string, unknown>>();
  return rows.results.flatMap((row) => {
    const status = String(row.status) as LhasaV1GranuleStatus;
    if (!row.caseId || !row.productDate || !["available", "not_found", "metadata_error"].includes(status)) return [];
    return [{
      caseId: String(row.caseId), productDate: String(row.productDate), status, collectionConceptId: String(row.collectionConceptId),
      granuleConceptId: row.granuleConceptId ? String(row.granuleConceptId) : undefined,
      producerGranuleId: row.producerGranuleId ? String(row.producerGranuleId) : undefined,
      downloadUrl: row.downloadUrl ? String(row.downloadUrl) : undefined,
      granuleSizeMb: row.granuleSizeMb === null || row.granuleSizeMb === undefined ? undefined : Number(row.granuleSizeMb),
      timeStart: row.timeStart ? String(row.timeStart) : undefined, timeEnd: row.timeEnd ? String(row.timeEnd) : undefined,
      message: String(row.message ?? ""), checkedAt: String(row.checkedAt),
    }];
  });
}

export async function upsertLhasaV1GranuleProbe(probe: LhasaV1GranuleProbeRecord) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO lhasa_v1_granule_probes (case_id, product_date, status, collection_concept_id, granule_concept_id, producer_granule_id, download_url, granule_size_mb, time_start, time_end, message, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id) DO UPDATE SET product_date=excluded.product_date, status=excluded.status, collection_concept_id=excluded.collection_concept_id, granule_concept_id=excluded.granule_concept_id, producer_granule_id=excluded.producer_granule_id, download_url=excluded.download_url, granule_size_mb=excluded.granule_size_mb, time_start=excluded.time_start, time_end=excluded.time_end, message=excluded.message, checked_at=excluded.checked_at`)
    .bind(probe.caseId, probe.productDate, probe.status, probe.collectionConceptId, probe.granuleConceptId ?? null, probe.producerGranuleId ?? null, probe.downloadUrl ?? null, probe.granuleSizeMb ?? null, probe.timeStart ?? null, probe.timeEnd ?? null, probe.message, probe.checkedAt).run();
  return probe;
}

export async function listEvaluationRuns(limit = 10): Promise<DetectionEvaluationReport[]> {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT report_json AS reportJson FROM evaluation_runs ORDER BY created_at DESC LIMIT ?`)
    .bind(Math.max(1, Math.min(20, limit))).all<{ reportJson: string }>();
  return rows.results.flatMap((row) => {
    try { return [JSON.parse(row.reportJson) as DetectionEvaluationReport]; } catch { return []; }
  });
}

export async function persistEvaluationRun(report: DetectionEvaluationReport, actor: string) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO evaluation_runs (run_id, model_version, case_count, eligible_count, detected_count, report_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(report.runId, report.modelVersion, report.metrics.verifiedCases, report.metrics.eligibleCases, report.metrics.detectedCases, JSON.stringify(report), actor, report.computedAt).run();
  await db.prepare(`DELETE FROM evaluation_runs WHERE run_id IN (SELECT run_id FROM evaluation_runs ORDER BY created_at DESC LIMIT -1 OFFSET 30)`).run();
  return report;
}

export async function listEvaluationCandidates(benchmark: EvaluationBenchmarkCase): Promise<EvaluationCandidate[]> {
  await ensureOperationalSchema();
  const db = await database();
  const window = evaluationWindow(benchmark);
  const latitudeDelta = Math.min(90, benchmark.locationToleranceKm / 110.574);
  const longitudeScale = Math.max(0.05, Math.abs(Math.cos(benchmark.latitude * Math.PI / 180)));
  const longitudeDelta = Math.min(180, benchmark.locationToleranceKm / (111.32 * longitudeScale));
  const requiredSource = benchmark.requiredSource?.trim().toLocaleLowerCase() ?? "";
  const requiredSourcePattern = requiredSource ? `%${requiredSource.replaceAll("%", "").replaceAll("_", "")}%` : "";
  const rows = benchmark.objective === "landslide_forecast"
    ? await db.prepare(`SELECT s.snapshot_id AS snapshotId, MIN(s.captured_at) AS capturedAt, event.value AS eventJson
      FROM ingestion_snapshots s, json_each(s.payload_json, '$.events') AS event
      WHERE s.captured_at BETWEEN ? AND ?
        AND json_extract(event.value, '$.hazard') = 'landslide'
        AND json_extract(event.value, '$.phenomenonStage') IN ('forecast', 'warning')
        AND (? = '' OR lower(json_extract(event.value, '$.source')) LIKE ?)
      GROUP BY json_extract(event.value, '$.masterEventId')
      ORDER BY capturedAt, s.snapshot_id
      LIMIT 5000`)
      .bind(window.startAt, window.expectedBy, requiredSource, requiredSourcePattern)
      .all<{ snapshotId: string; capturedAt: string; eventJson: string }>()
    : await db.prepare(`SELECT s.snapshot_id AS snapshotId, s.captured_at AS capturedAt, event.value AS eventJson
    FROM ingestion_snapshots s, json_each(s.payload_json, '$.events') AS event
    WHERE s.captured_at BETWEEN ? AND ?
      AND json_extract(event.value, '$.hazard') = ?
      AND json_extract(event.value, '$.occurredAt') BETWEEN ? AND ?
      AND CAST(json_extract(event.value, '$.latitude') AS REAL) BETWEEN ? AND ?
      AND (ABS(CAST(json_extract(event.value, '$.longitude') AS REAL) - ?) <= ? OR ABS(CAST(json_extract(event.value, '$.longitude') AS REAL) - ?) >= ?)
    ORDER BY s.captured_at, s.snapshot_id
    LIMIT 1000`)
    .bind(window.startAt, window.expectedBy, benchmark.hazard, window.eventStartAt, window.eventEndAt, benchmark.latitude - latitudeDelta, benchmark.latitude + latitudeDelta, benchmark.longitude, longitudeDelta, benchmark.longitude, 360 - longitudeDelta)
    .all<{ snapshotId: string; capturedAt: string; eventJson: string }>();
  return rows.results.flatMap((row) => {
    try {
      const event = JSON.parse(row.eventJson) as DisasterEvent;
      if (!event?.masterEventId || !event?.hazard || !Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) return [];
      return [{ snapshotId: row.snapshotId, capturedAt: row.capturedAt, event }];
    } catch { return []; }
  });
}

export async function evaluationSourceSuccessTimes(requiredSource: string, from: string, to: string) {
  await ensureOperationalSchema();
  const db = await database();
  const pattern = `%${requiredSource.trim().toLocaleLowerCase().replaceAll("%", "").replaceAll("_", "")}%`;
  const rows = await db.prepare(`SELECT r.fetched_at AS fetchedAt FROM source_fetch_runs r LEFT JOIN source_registry s ON s.source_id=r.source_id
    WHERE r.ok=1 AND r.fetched_at BETWEEN ? AND ? AND (lower(r.source_id) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ?)
    ORDER BY r.fetched_at LIMIT 5000`)
    .bind(from, to, pattern, pattern).all<{ fetchedAt: string }>();
  return rows.results.map((row) => row.fetchedAt);
}

export async function evaluationSnapshotTimes(from: string, to: string) {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT captured_at AS capturedAt FROM ingestion_snapshots WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at LIMIT 5000`)
    .bind(from, to).all<{ capturedAt: string }>();
  return rows.results.map((row) => row.capturedAt);
}

export async function evaluationSourceReliability(from: string, to: string): Promise<EvaluationSourceReliability[]> {
  await ensureOperationalSchema();
  const db = await database();
  const rows = await db.prepare(`SELECT r.source_id AS sourceId, COALESCE(s.name, r.source_id) AS name, COUNT(*) AS attempts, SUM(CASE WHEN r.ok=1 THEN 1 ELSE 0 END) AS successfulAttempts, AVG(r.duration_ms) AS averageDurationMs
    FROM source_fetch_runs r LEFT JOIN source_registry s ON s.source_id=r.source_id
    WHERE r.fetched_at BETWEEN ? AND ? GROUP BY r.source_id, s.name ORDER BY r.source_id LIMIT 100`)
    .bind(from, to).all<Record<string, unknown>>();
  return rows.results.map((row) => {
    const attempts = Number(row.attempts);
    const successfulAttempts = Number(row.successfulAttempts);
    return {
      sourceId: String(row.sourceId),
      name: String(row.name),
      attempts,
      successfulAttempts,
      successRatePercent: attempts ? Math.round(successfulAttempts / attempts * 1_000) / 10 : 0,
      averageDurationMs: Math.round(Number(row.averageDurationMs ?? 0)),
    };
  });
}

function evaluationCaseFromRow(row: Record<string, unknown>): EvaluationBenchmarkCase | null {
  if (!row.caseId || !row.title || !row.hazard || !row.occurredAt) return null;
  return {
    caseId: String(row.caseId), title: String(row.title), hazard: String(row.hazard) as EvaluationBenchmarkCase["hazard"],
    objective: row.objective === "landslide_forecast" ? "landslide_forecast" : "event_detection",
    hazardSubtype: row.hazardSubtype ? String(row.hazardSubtype) as EvaluationBenchmarkCase["hazardSubtype"] : undefined,
    outcome: row.outcome === "no_event" ? "no_event" : "event",
    calibrationGroup: row.calibrationGroup ? String(row.calibrationGroup) : undefined,
    occurredAt: String(row.occurredAt),
    latitude: Number(row.latitude), longitude: Number(row.longitude), locationToleranceKm: Number(row.locationToleranceKm), eventTimeToleranceHours: Number(row.eventTimeToleranceHours),
    acceptedLeadMinutes: Number(row.acceptedLeadMinutes), detectionDeadlineMinutes: Number(row.detectionDeadlineMinutes),
    expectedSeverity: row.expectedSeverity ? String(row.expectedSeverity) as EvaluationBenchmarkCase["expectedSeverity"] : undefined,
    requiredSource: row.requiredSource ? String(row.requiredSource) : undefined,
    minimumForecastRiskPercent: row.minimumForecastRiskPercent === null || row.minimumForecastRiskPercent === undefined ? undefined : Number(row.minimumForecastRiskPercent),
    provenanceUrl: String(row.provenanceUrl), notes: String(row.notes ?? ""),
    verificationStatus: String(row.verificationStatus) as EvaluationBenchmarkCase["verificationStatus"], createdBy: String(row.createdBy), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

export async function getEventExposureAssessment(masterEventId: string): Promise<ExposureAssessment | null> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT * FROM event_exposure_assessments WHERE master_event_id = ?`).bind(masterEventId).first<EventExposureAssessmentRow>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as ExposureAssessment;
    if (parsed.masterEventId !== row.master_event_id || parsed.eventRevision !== row.event_revision || parsed.aoiHash !== row.aoi_hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function upsertEventExposureAssessment(assessment: ExposureAssessment): Promise<ExposureAssessment> {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO event_exposure_assessments (master_event_id, event_revision, aoi_hash, status, payload_json, computed_at, expires_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(master_event_id) DO UPDATE SET event_revision=excluded.event_revision, aoi_hash=excluded.aoi_hash, status=excluded.status, payload_json=excluded.payload_json, computed_at=excluded.computed_at, expires_at=excluded.expires_at, updated_by=excluded.updated_by`)
    .bind(assessment.masterEventId, assessment.eventRevision, assessment.aoiHash, assessment.status, JSON.stringify(assessment), assessment.computedAt, assessment.expiresAt, assessment.updatedBy).run();
  await db.prepare(`DELETE FROM event_exposure_assessments WHERE expires_at < ?`).bind(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()).run();
  return assessment;
}

export async function getOsmQueryCache<T = unknown>(cacheKey: string, queryKind: "exposure" | "infrastructure"): Promise<OsmQueryCacheRecord<T> | null> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT * FROM osm_query_cache WHERE cache_key = ? AND query_kind = ?`).bind(cacheKey, queryKind).first<OsmQueryCacheRow>();
  if (!row || !["public", "china_daily"].includes(row.data_profile)) return null;
  try {
    return {
      cacheKey: row.cache_key,
      queryKind,
      dataProfile: row.data_profile as OsmQueryCacheRecord["dataProfile"],
      payload: JSON.parse(row.payload_json) as T,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      osmBaseTimestamp: row.osm_base_timestamp ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function upsertOsmQueryCache<T>(record: OsmQueryCacheRecord<T>): Promise<boolean> {
  const payloadJson = JSON.stringify(record.payload);
  if (payloadJson.length > 2 * 1024 * 1024) return false;
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO osm_query_cache (cache_key, query_kind, data_profile, payload_json, fetched_at, expires_at, osm_base_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET query_kind=excluded.query_kind, data_profile=excluded.data_profile, payload_json=excluded.payload_json, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at, osm_base_timestamp=excluded.osm_base_timestamp`)
    .bind(record.cacheKey, record.queryKind, record.dataProfile, payloadJson, record.fetchedAt, record.expiresAt, record.osmBaseTimestamp ?? null).run();
  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM osm_query_cache WHERE expires_at < ?`).bind(retentionCutoff),
    db.prepare(`DELETE FROM osm_query_cache WHERE cache_key IN (SELECT cache_key FROM osm_query_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET 500)`),
  ]);
  return true;
}

export function collapseCanonicalEventsByMasterId(events: DisasterEvent[]) {
  const groups = new Map<string, DisasterEvent[]>();
  for (const event of events) groups.set(event.masterEventId, [...(groups.get(event.masterEventId) ?? []), event]);
  return [...groups.values()].map((versions) => {
    const latest = [...versions].sort((left, right) => compareEventVersionFreshness(right, left))[0];
    const evidence = deduplicateNewest(
      versions.flatMap((event) => event.evidence ?? []),
      (item) => `${item.source}|${item.sourceEventId}`,
      (item) => item.observedAt,
    );
    const updateHistory = deduplicateNewest(
      versions.flatMap((event) => event.updateHistory ?? []),
      (item) => `${item.source}|${item.sourceEventId}|${item.observedAt}|${item.sourceSeverity}`,
      (item) => item.observedAt,
    ).slice(0, 100);
    const cycloneForecast = versions.flatMap((event) => event.cycloneForecast ? [event.cycloneForecast] : [])
      .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt) || right.track.length - left.track.length)[0];
    return {
      ...latest,
      evidence,
      evidenceCount: evidence.length,
      independentSourceCount: distinctEvidenceSources(evidence),
      updateHistory,
      updateCount: Math.max(updateHistory.length, ...versions.map((event) => event.updateCount ?? 0)),
      bulletinCount: Math.max(updateHistory.length, ...versions.map((event) => event.bulletinCount ?? 0)),
      cycloneForecast,
    };
  });
}

async function readPersistedCanonicalEvents(db: DatabaseLike, requested: DisasterEvent[]) {
  if (!requested.length) return [];
  const ids = requested.map((event) => event.masterEventId);
  const fallback = new Map(requested.map((event) => [event.masterEventId, event]));
  const persisted = new Map<string, DisasterEvent>();
  // D1 deployments may retain SQLite's conservative host-parameter limit.
  // Keep this well below that limit instead of letting a normal 250-event
  // refresh turn a successful write into a false persistence failure.
  const readBatchSize = 80;
  for (let offset = 0; offset < ids.length; offset += readBatchSize) {
    const batch = ids.slice(offset, offset + readBatchSize);
    const result = await db.prepare(`SELECT id, payload_json FROM canonical_events WHERE id IN (${batch.map(() => "?").join(",")})`)
      .bind(...batch).all<{ id: string; payload_json: string }>();
    for (const row of result.results) {
      try { persisted.set(row.id, JSON.parse(row.payload_json) as DisasterEvent); } catch { /* keep the validated in-memory event */ }
    }
  }
  return ids.flatMap((id) => persisted.get(id) ?? fallback.get(id) ?? []);
}

function deduplicateNewest<T>(items: T[], key: (item: T) => string, timestamp: (item: T) => string) {
  const result = new Map<string, T>();
  for (const item of items) {
    const existing = result.get(key(item));
    if (!existing || Date.parse(timestamp(item)) >= Date.parse(timestamp(existing))) result.set(key(item), item);
  }
  return [...result.values()].sort((left, right) => Date.parse(timestamp(right)) - Date.parse(timestamp(left)));
}

async function resolveClaimAliases(db: DatabaseLike, affectedMasterIds: string[]) {
  const uniqueIds = [...new Set(affectedMasterIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += operationalQueryBatchSize) {
    const batch = uniqueIds.slice(offset, offset + operationalQueryBatchSize);
    const placeholders = batch.map(() => "?").join(",");
    const aliases = await db.prepare(`SELECT c.id, c.hazard, COUNT(e.id) AS evidence_count, COUNT(sc.source_event_id) AS claimed_count, COUNT(DISTINCT sc.master_event_id) AS target_count, MIN(sc.master_event_id) AS target_id
      FROM canonical_events c
      JOIN event_evidence e ON e.master_event_id = c.id
      LEFT JOIN event_source_claims sc ON sc.source = e.source AND sc.source_event_id = e.source_event_id AND sc.hazard = c.hazard
      WHERE c.lifecycle_status IN ('active','monitoring') AND c.id IN (${placeholders})
      GROUP BY c.id, c.hazard`)
      .bind(...batch)
      .all<{ id: string; hazard: string; evidence_count: number; claimed_count: number; target_count: number; target_id: string | null }>();

    for (const alias of aliases.results) {
      if (!alias.target_id || alias.target_id === alias.id || Number(alias.evidence_count) === 0 || Number(alias.claimed_count) !== Number(alias.evidence_count) || Number(alias.target_count) !== 1) continue;
      const target = await db.prepare(`SELECT id FROM canonical_events WHERE id = ? AND hazard = ?`).bind(alias.target_id, alias.hazard).first<{ id: string }>();
      if (!target) continue;
      const canonical = await db.prepare(`SELECT payload_json FROM canonical_events WHERE id = ?`).bind(alias.id).first<{ payload_json: string }>();
      const taskRows = await db.prepare(`SELECT task_id, owner, status, revision, payload_json FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
        .bind(alias.id).all<LifecycleTaskRow>();
      const now = new Date().toISOString();
      const reason = `历史别名已收敛到主事件 ${alias.target_id}`;
      let event: unknown = null;
      try { event = canonical ? JSON.parse(canonical.payload_json) : null; } catch { /* keep an auditable null payload */ }
      const statements: DatabaseStatement[] = [
        db.prepare(`UPDATE canonical_events SET lifecycle_status='resolved', observation_expires_at=?, synced_at=? WHERE id=? AND lifecycle_status IN ('active','monitoring')`).bind(now, now, alias.id),
        db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_merged', ?, ?, ?)`)
          .bind(`event_merged:${alias.id}:${now}`, alias.target_id, JSON.stringify({ fromMasterEventId: alias.id, toMasterEventId: alias.target_id, reason, event }), now),
      ];
      for (const task of taskRows.results) statements.push(...lifecycleTaskTransitionStatements(db, task, alias.id, now, `${reason}；旧任务必须重新核对 AOI`));
      await db.batch(statements);
    }
  }
}

async function reconcileCanonicalMasters(db: DatabaseLike, masterIds: string[], event: DisasterEvent) {
  const candidates = await Promise.all(masterIds.map(async (id) => {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
      .bind(id).first<{ count: number }>();
    return { id, taskCount: Number(row?.count ?? 0), preferred: id === event.masterEventId ? 1 : 0 };
  }));
  candidates.sort((a, b) => b.taskCount - a.taskCount || b.preferred - a.preferred || a.id.localeCompare(b.id));
  const target = candidates[0]?.id ?? event.masterEventId;
  const reason = `同一${event.hazard}过程的多来源/多期通报已聚合到 ${target}`;

  for (const source of candidates.filter((candidate) => candidate.id !== target)) {
    const [canonical, taskRows] = await Promise.all([
      db.prepare(`SELECT payload_json FROM canonical_events WHERE id = ?`).bind(source.id).first<{ payload_json: string }>(),
      db.prepare(`SELECT task_id, owner, status, revision, payload_json FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
        .bind(source.id).all<LifecycleTaskRow>(),
    ]);
    const now = new Date().toISOString();
    const statements: DatabaseStatement[] = [
      db.prepare(evidenceReassignmentSql.copy).bind(target, source.id),
      db.prepare(evidenceReassignmentSql.removeSource).bind(source.id),
      db.prepare(`UPDATE event_source_claims SET master_event_id = ? WHERE master_event_id = ? AND hazard = ?`).bind(target, source.id, event.hazard),
      db.prepare(`UPDATE canonical_events SET lifecycle_status = 'resolved', observation_expires_at = ?, synced_at = ? WHERE id = ?`).bind(now, now, source.id),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_merged', ?, ?, ?)`)
        .bind(`event_merged:${source.id}:${now}`, target, JSON.stringify({ fromMasterEventId: source.id, toMasterEventId: target, reason, event: canonical ? JSON.parse(canonical.payload_json) : null }), now),
    ];
    for (const task of taskRows.results) statements.push(...lifecycleTaskTransitionStatements(db, task, source.id, now, `${reason}；旧任务必须重新核对 AOI`));
    await db.batch(statements);
  }
  return target;
}

export async function listSatelliteTasks(owner?: string) {
  await ensureOperationalSchema();
  const db = await database();
  const result = owner
    ? await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE status != 'cancelled' AND owner=? ORDER BY priority DESC, updated_at DESC LIMIT 500`).bind(owner).all<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>()
    : await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE status != 'cancelled' ORDER BY priority DESC, updated_at DESC LIMIT 500`).all<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>();
  return result.results.flatMap((row): TaskRecord[] => {
    try {
      const payload = JSON.parse(row.payload_json) as TaskRecord;
      return [{ ...payload, status: row.status, revision: row.revision, eventRevision: row.event_revision, aoiHash: row.aoi_hash, updatedAt: row.updated_at }];
    } catch { return []; }
  });
}

export async function getSatelliteTask(taskId: string, owner?: string) {
  await ensureOperationalSchema();
  const db = await database();
  const row = owner
    ? await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE task_id = ? AND owner=? AND status != 'cancelled'`).bind(taskId, owner).first<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>()
    : await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE task_id = ? AND status != 'cancelled'`).bind(taskId).first<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>();
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as TaskRecord;
    return { ...payload, status: row.status, revision: row.revision, eventRevision: row.event_revision, aoiHash: row.aoi_hash, updatedAt: row.updated_at };
  } catch { return null; }
}

export async function listSatelliteTaskCancellationIds(owner?: string) {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT task_id FROM (
      SELECT task_id, owner, updated_at AS cancelled_at FROM satellite_tasks WHERE status = 'cancelled'
      UNION ALL
      SELECT task_id, owner, cancelled_at FROM task_cancellation_intents
    ) WHERE ?='' OR owner=? GROUP BY task_id ORDER BY MAX(cancelled_at) DESC LIMIT 5000`).bind(owner ?? "", owner ?? "").all<{ task_id: string }>();
  return result.results.map((row) => row.task_id);
}

export async function listTaskRevisionHistory(taskId: string, owner?: string) {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at
      FROM task_revision_history WHERE task_id=? AND (?='' OR owner=?) ORDER BY revision ASC LIMIT 500`)
    .bind(taskId, owner ?? "", owner ?? "")
    .all<{ task_id: string; revision: number; owner: string; actor: string; from_status: string | null; to_status: string; reason: string; payload_json: string; changed_at: string }>();
  return result.results.map((row) => ({
    taskId: row.task_id,
    revision: row.revision,
    owner: row.owner,
    actor: row.actor,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    payloadJson: row.payload_json,
    changedAt: row.changed_at,
  }));
}

export async function listRetainedCanonicalEvents() {
  await ensureOperationalSchema();
  const db = await database();
  const [result, tombstones] = await Promise.all([
    db.prepare(`SELECT lifecycle_status, payload_json FROM canonical_events WHERE lifecycle_status IN ('active', 'monitoring') AND observation_expires_at > ? ORDER BY updated_at DESC LIMIT 1000`)
      .bind(new Date().toISOString()).all<{ lifecycle_status: DisasterEvent["lifecycleStatus"]; payload_json: string }>(),
    db.prepare(`SELECT source, source_event_id FROM event_tombstones`).all<{ source: string; source_event_id: string }>(),
  ]);
  const blocked = new Set(tombstones.results.map((item) => `${item.source}|${item.source_event_id}`));
  return result.results.flatMap((row) => {
    try {
      const event = JSON.parse(row.payload_json) as DisasterEvent;
      if (eventHasInvalidIdentity(event)) return [];
      const evidence = event.evidence.filter((item) => !blocked.has(`${item.source}|${item.sourceEventId}`));
      if (!evidence.length) return [];
      return [{
        ...event,
        evidence,
        evidenceCount: evidence.length,
        independentSourceCount: distinctEvidenceSources(evidence),
        bulletinCount: event.updateHistory?.length ?? event.updateCount ?? evidence.length,
        lifecycleStatus: row.lifecycle_status,
      }];
    } catch {
      return [];
    }
  });
}

export async function getCanonicalEventForTask(masterEventId: string, reference?: { eventId?: string; entityKey?: string; hazard?: string }) {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT lifecycle_status, observation_expires_at, payload_json FROM canonical_events WHERE id = ?`)
    .bind(masterEventId).first<{ lifecycle_status: string; observation_expires_at: string; payload_json: string }>();
  const exact = row ? await taskCanonicalFromRow(db, masterEventId, row) : null;
  if (exact && !["resolved", "archived"].includes(exact.lifecycleStatus)) return exact;

  const entityKey = reference?.entityKey?.trim();
  const hazard = reference?.hazard?.trim();
  if (!entityKey || entityKey.length > 300 || !hazard || hazard.length > 40) return exact;
  const candidates = await db.prepare(`SELECT id, lifecycle_status, observation_expires_at, payload_json FROM canonical_events WHERE hazard = ? AND lifecycle_status IN ('active','monitoring') AND observation_expires_at > ? ORDER BY updated_at DESC LIMIT 1000`)
    .bind(hazard, new Date().toISOString()).all<{ id: string; lifecycle_status: string; observation_expires_at: string; payload_json: string }>();
  const matches = [];
  for (const candidate of candidates.results) {
    const parsed = await taskCanonicalFromRow(db, candidate.id, candidate);
    if (parsed?.event.entityKey === entityKey) matches.push(parsed);
  }
  if (matches.length === 1) return matches[0];
  const eventId = reference?.eventId?.trim();
  const direct = eventId ? matches.filter((candidate) => candidate.event.id === eventId || candidate.event.evidence.some((item) => item.sourceEventId === eventId)) : [];
  return direct.length === 1 ? direct[0] : exact;
}

async function taskCanonicalFromRow(db: DatabaseLike, masterEventId: string, row: { lifecycle_status: string; observation_expires_at: string; payload_json: string }) {
  if (!await hasActiveEvidence(db, masterEventId)) return null;
  try {
    const event = JSON.parse(row.payload_json) as DisasterEvent;
    if (eventHasInvalidIdentity(event)) return null;
    return { lifecycleStatus: row.lifecycle_status, observationExpiresAt: row.observation_expires_at, event };
  } catch {
    return null;
  }
}

export async function upsertSatelliteTask(task: TaskRecord, canonicalGuard?: { payloadJson: string }, owner = "legacy", allowAllOwners = false) {
  await ensureOperationalSchema();
  const db = await database();
  const cancellationIntent = await db.prepare(`SELECT task_id FROM task_cancellation_intents WHERE task_id = ?`).bind(task.taskId).first<{ task_id: string }>();
  if (cancellationIntent) throw new Error("任务已取消，不允许重新创建；请新建任务");
  const existing = await db.prepare(`SELECT status, revision, owner FROM satellite_tasks WHERE task_id = ?`).bind(task.taskId).first<{ status: string; revision: number; owner: string }>();
  if (existing && !allowAllOwners && existing.owner !== owner) throw new Error("任务不属于当前操作员");
  if (!canTransitionTask(existing?.status ?? null, task.status)) throw new Error(`不允许的任务状态转换：${existing?.status ?? "new"} -> ${task.status}`);
  const suppliedRevision = Number(task.revision ?? 0);
  if (existing && suppliedRevision !== existing.revision) throw new Error(`任务版本冲突：当前为 ${existing.revision}，请求为 ${suppliedRevision}`);
  if (!existing && suppliedRevision !== 0) throw new Error("新任务 revision 必须为 0");
  const updatedAt = new Date().toISOString();
  const revision = existing ? existing.revision + 1 : 1;
  const payload = { ...task, revision, updatedAt };
  const aoi = JSON.stringify({ type: task.aoiType, sourceGeometry: task.sourceGeometry, customGeometry: task.customGeometry, radiusKm: task.aoiRadiusKm, widthKm: task.aoiWidthKm, heightKm: task.aoiHeightKm, lengthKm: task.aoiLengthKm, bearingDeg: task.aoiBearingDeg });
  const canonicalCondition = canonicalGuard
    ? ` AND EXISTS (SELECT 1 FROM canonical_events c WHERE c.id=? AND c.lifecycle_status IN ('active','monitoring') AND c.observation_expires_at>? AND c.payload_json=? AND EXISTS (SELECT 1 FROM event_evidence e LEFT JOIN event_tombstones t ON t.source=e.source AND t.source_event_id=e.source_event_id WHERE e.master_event_id=c.id AND t.source IS NULL))`
    : "";
  const guardValues = canonicalGuard ? [task.masterEventId, updatedAt, canonicalGuard.payloadJson] : [];
  const save = existing
    ? db.prepare(`UPDATE satellite_tasks SET event_id=?, master_event_id=?, title=?, status=?, priority=?, latitude=?, longitude=?, aoi_type=?, aoi_json=?, sensors_json=?, imaging_start=?, imaging_end=?, aoi_approval=?, payload_json=?, updated_at=?, revision=?, event_revision=?, aoi_hash=? WHERE task_id=? AND status=? AND revision=?${canonicalCondition}`)
      .bind(task.eventId, task.masterEventId, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), updatedAt, revision, task.eventRevision ?? "", task.aoiHash ?? "", task.taskId, existing.status, existing.revision, ...guardValues)
    : db.prepare(`INSERT INTO satellite_tasks (task_id, event_id, master_event_id, owner, title, status, priority, latitude, longitude, aoi_type, aoi_json, sensors_json, imaging_start, imaging_end, aoi_approval, payload_json, created_at, updated_at, revision, event_revision, aoi_hash)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM task_cancellation_intents WHERE task_id = ?)${canonicalCondition}`)
      .bind(task.taskId, task.eventId, task.masterEventId, owner, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), task.createdAt, updatedAt, revision, task.eventRevision ?? "", task.aoiHash ?? "", task.taskId, ...guardValues);
  const auditReason = existing ? existing.status === task.status ? "operator task edit" : "operator status update" : "operator task create";
  const audit = db.prepare(`INSERT OR IGNORE INTO task_revision_history (task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at)
      SELECT task_id, revision, owner, ?, ?, status, ?, payload_json, updated_at FROM satellite_tasks WHERE task_id=? AND revision=?`)
    .bind(owner, existing?.status ?? null, auditReason, task.taskId, revision);
  const [result] = await db.batch([save, audit]);
  if (existing && affectedRows(result) === 0) throw new Error("任务或主事件已被其他请求更新，请刷新后重试");
  if (!existing && affectedRows(result) === 0) throw new Error("任务已取消，或主事件在保存期间发生变化；请刷新后新建任务");
  return payload;
}

export type TaskExportSnapshotRow = {
  taskId: string;
  status: string;
  revision: number;
  eventRevision: string;
  aoiHash: string;
  task: Record<string, unknown>;
  lifecycleStatus: string;
  observationExpiresAt: string;
  event: DisasterEvent;
  activeEvidenceCount: number;
};

export async function getTaskExportSnapshot(taskIds: string[], owner?: string): Promise<TaskExportSnapshotRow[]> {
  await ensureOperationalSchema();
  if (!taskIds.length || taskIds.length > 100) return [];
  const db = await database();
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT t.task_id, t.status, t.revision, t.event_revision, t.aoi_hash,
      t.payload_json AS task_payload_json, c.lifecycle_status, c.observation_expires_at,
      c.payload_json AS event_payload_json,
      (SELECT COUNT(*) FROM event_evidence e LEFT JOIN event_tombstones x ON x.source=e.source AND x.source_event_id=e.source_event_id WHERE e.master_event_id=c.id AND x.source IS NULL) AS active_evidence_count
    FROM satellite_tasks t JOIN canonical_events c ON c.id=t.master_event_id
    WHERE t.task_id IN (${placeholders}) AND t.status != 'cancelled' AND (?='' OR t.owner=?)`).bind(...taskIds, owner ?? "", owner ?? "")
    .all<{ task_id: string; status: string; revision: number; event_revision: string; aoi_hash: string; task_payload_json: string; lifecycle_status: string; observation_expires_at: string; event_payload_json: string; active_evidence_count: number }>();
  return rows.results.flatMap((row) => {
    try {
      return [{
        taskId: row.task_id,
        status: row.status,
        revision: row.revision,
        eventRevision: row.event_revision,
        aoiHash: row.aoi_hash,
        task: JSON.parse(row.task_payload_json) as Record<string, unknown>,
        lifecycleStatus: row.lifecycle_status,
        observationExpiresAt: row.observation_expires_at,
        event: JSON.parse(row.event_payload_json) as DisasterEvent,
        activeEvidenceCount: Number(row.active_evidence_count),
      }];
    } catch {
      return [];
    }
  });
}

export async function recordTaskExportPackage(record: { packageId: string; format: string; taskIds: string[]; masterEventIds: string[]; payloadSha256: string; actor: string; createdAt: string }) {
  await ensureOperationalSchema();
  const db = await database();
  await db.batch([
    db.prepare(`INSERT INTO task_export_packages (package_id, format, task_ids_json, payload_sha256, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(record.packageId, record.format, JSON.stringify(record.taskIds), record.payloadSha256, record.actor, record.createdAt),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'task_package_exported', ?, ?, ?)`)
      .bind(`task_package_exported:${record.packageId}`, record.masterEventIds[0] ?? "task-package", JSON.stringify(record), record.createdAt),
  ]);
}

export async function deleteSatelliteTask(taskId: string, expectedRevision?: number, actor = "legacy", reason = "操作员取消任务", allowAllOwners = false) {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT status, revision, master_event_id, owner, payload_json FROM satellite_tasks WHERE task_id = ?`).bind(taskId).first<{ status: string; revision: number; master_event_id: string; owner: string; payload_json: string }>();
  const cancelledAt = new Date().toISOString();
  if (!existing) {
    await db.prepare(`INSERT INTO task_cancellation_intents (task_id, owner, cancelled_at, actor, reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner, cancelled_at=excluded.cancelled_at, actor=excluded.actor, reason=excluded.reason`)
      .bind(taskId, actor, cancelledAt, actor, reason).run();
    return { state: "cancellation_recorded" as const, revision: null };
  }
  if (!allowAllOwners && existing.owner !== actor) throw new Error("任务不属于当前操作员");
  if (existing.status === "cancelled") return { state: "already_cancelled" as const, revision: existing.revision };
  if (existing.status === "cancellation_requested") return { state: "cancellation_requested" as const, revision: existing.revision };
  if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw new Error(`任务版本冲突：当前为 ${existing.revision}，请求为 ${expectedRevision}`);
  if (["submitted", "cancel_rejected"].includes(existing.status)) {
    const revision = existing.revision + 1;
    let previousPayload: Record<string, unknown> = {};
    try { previousPayload = JSON.parse(existing.payload_json) as Record<string, unknown>; } catch { /* preserve normalized columns */ }
    const cancellationRequestId = `CANCEL-${taskId}-${revision}`;
    const payload = { ...previousPayload, status: "cancellation_requested", revision, updatedAt: cancelledAt, cancellationRequestId, cancellationRequestedAt: cancelledAt, cancellationRequestedBy: actor, cancellationReason: reason };
    const statements = [
      db.prepare(`UPDATE satellite_tasks SET status='cancellation_requested', payload_json=?, updated_at=?, revision=? WHERE task_id=? AND status=? AND revision=?`)
        .bind(JSON.stringify(payload), cancelledAt, revision, taskId, existing.status, existing.revision),
      db.prepare(`INSERT OR IGNORE INTO task_revision_history (task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at)
        SELECT task_id, revision, owner, ?, ?, status, ?, payload_json, updated_at FROM satellite_tasks WHERE task_id=? AND revision=?`)
        .bind(actor, existing.status, reason, taskId, revision),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
        SELECT ?, 'task_cancellation_requested', ?, ?, ? WHERE changes() > 0`)
        .bind(`task_cancellation_requested:${taskId}:${revision}`, existing.master_event_id, JSON.stringify({ taskId, previousStatus: existing.status, status: "cancellation_requested", revision, cancellationRequestId, actor, reason }), cancelledAt),
    ];
    const [result] = await db.batch(statements);
    if (affectedRows(result) === 0) throw new Error("任务已被其他请求更新，请刷新后重试");
    return { state: "cancellation_requested" as const, revision, task: payload };
  }
  if (!canTransitionTask(existing.status, "cancelled")) throw new Error(`不允许取消状态为 ${existing.status} 的任务`);
  const revision = existing.revision + 1;
  let previousPayload: Record<string, unknown> = {};
  try { previousPayload = JSON.parse(existing.payload_json) as Record<string, unknown>; } catch { /* 旧数据仍按规范化列完成取消。 */ }
  const payload = { ...previousPayload, status: "cancelled", revision, updatedAt: cancelledAt, cancelledAt, cancelledBy: actor, cancellationReason: reason };
  const statements = [
    db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', payload_json = ?, updated_at = ?, revision = ? WHERE task_id = ? AND status = ? AND revision = ?`)
      .bind(JSON.stringify(payload), cancelledAt, revision, taskId, existing.status, existing.revision),
    db.prepare(`INSERT OR IGNORE INTO task_revision_history (task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at)
      SELECT task_id, revision, owner, ?, ?, status, ?, payload_json, updated_at FROM satellite_tasks WHERE task_id=? AND revision=?`)
      .bind(actor, existing.status, reason, taskId, revision),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, 'task_cancelled', ?, ?, ? WHERE EXISTS (SELECT 1 FROM satellite_tasks WHERE task_id=? AND status='cancelled' AND revision=?)`)
      .bind(`task_cancelled:${taskId}:${revision}`, existing.master_event_id, JSON.stringify({ taskId, previousStatus: existing.status, revision, actor, reason }), cancelledAt, taskId, revision),
    db.prepare(`INSERT INTO task_cancellation_intents (task_id, owner, cancelled_at, actor, reason)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM satellite_tasks WHERE task_id=? AND status='cancelled' AND revision=?)
      ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner, cancelled_at=excluded.cancelled_at, actor=excluded.actor, reason=excluded.reason`)
      .bind(taskId, existing.owner, cancelledAt, actor, reason, taskId, revision),
  ];
  const [result] = await db.batch(statements);
  if (affectedRows(result) === 0) throw new Error("任务已被其他请求更新，请刷新后重试");
  return { state: "cancelled" as const, revision };
}

export async function resolveCanonicalEventsByReferences(references: Array<{ source: string; sourceEventId: string }>, reason: string) {
  if (!references.length) return 0;
  await ensureOperationalSchema();
  const db = await database();
  let resolved = 0;
  for (const reference of references) {
    const resolvedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO event_tombstones (source, source_event_id, reason, resolved_at) VALUES (?, ?, ?, ?) ON CONFLICT(source, source_event_id) DO UPDATE SET reason=excluded.reason, resolved_at=excluded.resolved_at`)
      .bind(reference.source, reference.sourceEventId, reason, resolvedAt).run();
    const rows = await db.prepare(`SELECT DISTINCT master_event_id FROM event_evidence WHERE source = ? AND source_event_id = ?`)
      .bind(reference.source, reference.sourceEventId).all<{ master_event_id: string }>();
    for (const row of rows.results) {
      if (await hasActiveEvidence(db, row.master_event_id)) continue;
      const canonical = await db.prepare(`SELECT payload_json FROM canonical_events WHERE id=?`).bind(row.master_event_id).first<{ payload_json: string }>();
      const taskRows = await db.prepare(`SELECT task_id, owner, status, revision, payload_json FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate', 'reviewed', 'scheduled', 'submitted')`)
        .bind(row.master_event_id).all<LifecycleTaskRow>();
      const now = new Date().toISOString();
      const statements: DatabaseStatement[] = [
        db.prepare(`UPDATE canonical_events SET lifecycle_status = 'resolved', observation_expires_at = ?, synced_at = ? WHERE id = ?`).bind(now, now, row.master_event_id),
        db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_resolved', ?, ?, ?)`)
          .bind(`event_resolved:${row.master_event_id}:${now}`, row.master_event_id, JSON.stringify({ reason, event: canonical ? JSON.parse(canonical.payload_json) : null }), now),
      ];
      for (const task of taskRows.results) statements.push(...lifecycleTaskTransitionStatements(db, task, row.master_event_id, now, reason));
      await db.batch(statements);
      resolved += 1;
    }
  }
  return resolved;
}

export async function listPlanningScenarioSummaries(owner: string, limit = 40): Promise<PlanningScenarioSummary[]> {
  await ensureOperationalSchema();
  const db = await database();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await db.prepare(`SELECT scenario_id, series_id, version, parent_scenario_id, name, problem_fingerprint, objective_score, assignment_count, conditional_assignment_count, created_at
    FROM planning_scenarios WHERE owner=? ORDER BY created_at DESC LIMIT ?`)
    .bind(owner, safeLimit).all<{ scenario_id: string; series_id: string; version: number; parent_scenario_id: string | null; name: string; problem_fingerprint: string; objective_score: number; assignment_count: number; conditional_assignment_count: number; created_at: string }>();
  return result.results.map((row) => ({
    scenarioId: row.scenario_id,
    seriesId: row.series_id,
    version: Number(row.version),
    parentScenarioId: row.parent_scenario_id ?? undefined,
    name: row.name,
    createdAt: row.created_at,
    problemFingerprint: row.problem_fingerprint,
    objectiveScore: Number(row.objective_score),
    assignmentCount: Number(row.assignment_count),
    conditionalAssignmentCount: Number(row.conditional_assignment_count),
  }));
}

export async function getPlanningScenario(scenarioId: string, owner: string): Promise<PlanningScenarioRecord | null> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT payload_json FROM planning_scenarios WHERE scenario_id=? AND owner=?`).bind(scenarioId, owner).first<{ payload_json: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json);
    return planningScenarioHasValidChecksum(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePlanningScenario(input: {
  scenarioId: string;
  seriesId?: string;
  parentScenarioId?: string;
  owner: string;
  name: string;
  createdAt: string;
  problemIds: string[];
  manualRules: SchedulingManualRules;
  comparison: SchedulingComparison;
}): Promise<PlanningScenarioRecord> {
  await ensureOperationalSchema();
  const db = await database();
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM planning_scenarios WHERE owner=?`).bind(input.owner).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 100) throw new Error("当前账号已保存100个规划方案，请联系管理员归档后再保存");
  let seriesId = input.seriesId;
  if (seriesId && !/^series-[0-9a-f-]{36}$/i.test(seriesId)) throw new Error("规划方案系列ID无效");
  if (seriesId && !input.parentScenarioId) throw new Error("续存方案必须提供父方案");
  if (input.parentScenarioId) {
    const parent = await db.prepare(`SELECT series_id, owner FROM planning_scenarios WHERE scenario_id=?`).bind(input.parentScenarioId).first<{ series_id: string; owner: string }>();
    if (!parent || parent.owner !== input.owner) throw new Error("父方案不存在或不属于当前操作员");
    if (seriesId && seriesId !== parent.series_id) throw new Error("父方案与方案系列不一致");
    seriesId = parent.series_id;
  }
  seriesId ??= `series-${crypto.randomUUID()}`;
  const latest = await db.prepare(`SELECT MAX(version) AS version FROM planning_scenarios WHERE series_id=? AND owner=?`).bind(seriesId, input.owner).first<{ version: number | null }>();
  const version = Number(latest?.version ?? 0) + 1;
  const record = createPlanningScenarioRecord({
    scenarioId: input.scenarioId,
    seriesId,
    version,
    parentScenarioId: input.parentScenarioId,
    name: input.name,
    owner: input.owner,
    createdAt: input.createdAt,
    problemIds: input.problemIds,
    manualRules: input.manualRules,
    comparison: input.comparison,
  });
  const summary = planningScenarioSummary(record);
  const payload = JSON.stringify(record);
  if (new TextEncoder().encode(payload).byteLength > 512 * 1024) throw new Error("规划方案快照超过512KB，无法保存");
  try {
    await db.prepare(`INSERT INTO planning_scenarios (scenario_id, series_id, version, parent_scenario_id, owner, name, problem_fingerprint, objective_score, assignment_count, conditional_assignment_count, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.scenarioId, record.seriesId, record.version, record.parentScenarioId ?? null, record.owner, record.name, record.problemFingerprint, summary.objectiveScore, summary.assignmentCount, summary.conditionalAssignmentCount, payload, record.createdAt).run();
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new Error("规划方案版本冲突，请刷新后重试保存");
    throw error;
  }
  return record;
}

export async function listMissionExecutionReceipts(filters: { taskId?: string; masterEventId?: string; limit?: number }, owner?: string) {
  await ensureOperationalSchema();
  const db = await database();
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 100)));
  const result = await db.prepare(`SELECT payload_json FROM mission_execution_receipts
      WHERE (?='' OR task_id=?) AND (?='' OR master_event_id=?) AND (?='' OR owner=?)
      ORDER BY occurred_at DESC, received_at DESC LIMIT ?`)
    .bind(filters.taskId ?? "", filters.taskId ?? "", filters.masterEventId ?? "", filters.masterEventId ?? "", owner ?? "", owner ?? "", limit)
    .all<{ payload_json: string }>();
  return result.results.flatMap((row) => parseJsonRecord<MissionExecutionReceipt>(row.payload_json));
}

export async function recordMissionExecutionReceipt(input: NormalizedExecutionReceiptInput, actor: string, allowAllOwners = false): Promise<MissionExecutionReceipt> {
  await ensureOperationalSchema();
  const db = await database();
  const current = await db.prepare(`SELECT task_id, master_event_id, owner, status, revision, payload_json FROM satellite_tasks WHERE task_id=?`)
    .bind(input.taskId).first<{ task_id: string; master_event_id: string; owner: string; status: string; revision: number; payload_json: string }>();
  if (!current) throw new Error("卫星任务不存在");
  if (!allowAllOwners && current.owner !== actor) throw new Error("任务不属于当前执行身份");
  if (Number(current.revision) !== input.expectedRevision) throw new Error(`任务版本冲突：当前为 ${current.revision}，请求为 ${input.expectedRevision}`);
  let currentPayload: Record<string, unknown>;
  try { currentPayload = JSON.parse(current.payload_json) as Record<string, unknown>; } catch { throw new Error("任务载荷损坏，禁止写入执行回执"); }
  const receivedAt = new Date().toISOString();
  const receiptId = input.receiptId ?? `receipt-${crypto.randomUUID()}`;
  const duplicate = await db.prepare(`SELECT payload_json FROM mission_execution_receipts WHERE receipt_id=?`).bind(receiptId).first<{ payload_json: string }>();
  if (duplicate) {
    const existing = parseJsonRecord<MissionExecutionReceipt>(duplicate.payload_json)[0];
    if (existing && existing.taskId === input.taskId && existing.provider === input.provider && existing.externalTaskId === input.externalTaskId && existing.toStatus === input.toStatus && existing.occurredAt === input.occurredAt) return existing;
    throw new Error("执行回执 ID 已被其他记录使用");
  }
  const nextPayload = taskPatchFromExecutionReceipt({ ...currentPayload, status: current.status }, input);
  const revision = Number(current.revision) + 1;
  const taskPayload = { ...nextPayload, revision, updatedAt: receivedAt };
  const receipt: MissionExecutionReceipt = {
    receiptId,
    taskId: input.taskId,
    masterEventId: current.master_event_id,
    owner: current.owner,
    provider: input.provider,
    externalTaskId: input.externalTaskId,
    fromStatus: current.status as MissionExecutionReceipt["fromStatus"],
    toStatus: input.toStatus,
    taskRevision: revision,
    occurredAt: input.occurredAt,
    receivedAt,
    actor,
    note: input.note,
    payload: input.payload,
  };
  const receiptJson = JSON.stringify(receipt);
  const [result] = await db.batch([
    db.prepare(`UPDATE satellite_tasks SET status=?, revision=?, payload_json=?, updated_at=? WHERE task_id=? AND status=? AND revision=?`)
      .bind(input.toStatus, revision, JSON.stringify(taskPayload), receivedAt, input.taskId, current.status, current.revision),
    db.prepare(`INSERT INTO mission_execution_receipts (receipt_id, task_id, master_event_id, owner, provider, external_task_id, from_status, to_status, task_revision, occurred_at, received_at, actor, note, payload_json)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM satellite_tasks WHERE task_id=? AND revision=? AND status=?)`)
      .bind(receipt.receiptId, receipt.taskId, receipt.masterEventId, receipt.owner, receipt.provider, receipt.externalTaskId, receipt.fromStatus, receipt.toStatus, revision, receipt.occurredAt, receipt.receivedAt, receipt.actor, receipt.note, receiptJson, input.taskId, revision, input.toStatus),
    db.prepare(`INSERT INTO task_revision_history (task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at)
      SELECT task_id, revision, owner, ?, ?, status, 'executor receipt', payload_json, updated_at FROM satellite_tasks WHERE task_id=? AND revision=?`)
      .bind(actor, current.status, input.taskId, revision),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, 'task_execution_receipt', ?, ?, ? WHERE EXISTS (SELECT 1 FROM mission_execution_receipts WHERE receipt_id=?)`)
      .bind(`task_execution_receipt:${receipt.receiptId}`, receipt.masterEventId, receiptJson, receivedAt, receipt.receiptId),
  ]);
  if (affectedRows(result) === 0) throw new Error("任务已被其他执行回执更新，请刷新版本后重试");
  return receipt;
}

export async function listObservationProducts(filters: { taskId?: string; masterEventId?: string; limit?: number }, owner?: string): Promise<ObservationProduct[]> {
  await ensureOperationalSchema();
  const db = await database();
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 100)));
  const result = await db.prepare(`SELECT item_id, task_id, master_event_id, owner, collection_id, product_level, quality_status, acquired_at, geometry_json, bbox_json, stac_json, revision, created_at, updated_at
      FROM observation_products WHERE (?='' OR task_id=?) AND (?='' OR master_event_id=?) AND (?='' OR owner=?)
      ORDER BY acquired_at DESC, item_id LIMIT ?`)
    .bind(filters.taskId ?? "", filters.taskId ?? "", filters.masterEventId ?? "", filters.masterEventId ?? "", owner ?? "", owner ?? "", limit)
    .all<{ item_id: string; task_id: string; master_event_id: string; owner: string; collection_id: string; product_level: string; quality_status: ObservationProduct["qualityStatus"]; acquired_at: string; geometry_json: string; bbox_json: string; stac_json: string; revision: number; created_at: string; updated_at: string }>();
  return result.results.flatMap((row) => {
    try {
      return [{
        itemId: row.item_id, taskId: row.task_id, masterEventId: row.master_event_id, owner: row.owner,
        collectionId: row.collection_id, productLevel: row.product_level, qualityStatus: row.quality_status,
        acquiredAt: row.acquired_at, geometry: JSON.parse(row.geometry_json) as GeoGeometry,
        bbox: JSON.parse(row.bbox_json) as [number, number, number, number], stac: JSON.parse(row.stac_json) as Record<string, unknown>,
        revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      }];
    } catch { return []; }
  });
}

export async function upsertObservationProduct(input: ObservationProductInput, actor: string, allowAllOwners = false): Promise<ObservationProduct> {
  await ensureOperationalSchema();
  const db = await database();
  const task = await db.prepare(`SELECT master_event_id, owner, status, payload_json FROM satellite_tasks WHERE task_id=?`)
    .bind(input.taskId).first<{ master_event_id: string; owner: string; status: string; payload_json: string }>();
  if (!task) throw new Error("产品关联的卫星任务不存在");
  if (!allowAllOwners && task.owner !== actor) throw new Error("任务不属于当前执行身份");
  if (!['acquired', 'completed'].includes(task.status)) throw new Error("只有已成像或已完成任务可以登记产品");
  const existing = await db.prepare(`SELECT owner, revision, created_at FROM observation_products WHERE item_id=?`)
    .bind(input.itemId).first<{ owner: string; revision: number; created_at: string }>();
  if (existing && !allowAllOwners && existing.owner !== actor) throw new Error("产品不属于当前执行身份");
  if (existing && input.expectedRevision !== existing.revision) throw new Error(`产品版本冲突：当前为 ${existing.revision}，请求为 ${input.expectedRevision ?? 0}`);
  if (!existing && input.expectedRevision !== undefined) throw new Error("新产品不得携带 expectedRevision");
  const now = new Date().toISOString();
  const revision = Number(existing?.revision ?? 0) + 1;
  const stac = buildStacItem(input, { taskId: input.taskId, masterEventId: task.master_event_id });
  const product: ObservationProduct = {
    itemId: input.itemId, taskId: input.taskId, masterEventId: task.master_event_id, owner: task.owner,
    collectionId: input.collectionId, productLevel: input.productLevel, qualityStatus: input.qualityStatus,
    acquiredAt: input.acquiredAt, geometry: input.geometry, bbox: geometryBbox(input.geometry), stac,
    revision, createdAt: existing?.created_at ?? now, updatedAt: now,
  };
  const [result] = await db.batch([
    db.prepare(`INSERT INTO observation_products (item_id, task_id, master_event_id, owner, collection_id, product_level, quality_status, acquired_at, geometry_json, bbox_json, stac_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET collection_id=excluded.collection_id, product_level=excluded.product_level, quality_status=excluded.quality_status, acquired_at=excluded.acquired_at, geometry_json=excluded.geometry_json, bbox_json=excluded.bbox_json, stac_json=excluded.stac_json, revision=excluded.revision, updated_at=excluded.updated_at
      WHERE observation_products.revision=?`)
      .bind(product.itemId, product.taskId, product.masterEventId, product.owner, product.collectionId, product.productLevel, product.qualityStatus, product.acquiredAt, JSON.stringify(product.geometry), JSON.stringify(product.bbox), JSON.stringify(product.stac), product.revision, product.createdAt, product.updatedAt, existing?.revision ?? -1),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, 'observation_product_registered', ?, ?, ? WHERE EXISTS (SELECT 1 FROM observation_products WHERE item_id=? AND revision=?)`)
      .bind(`observation_product_registered:${product.itemId}:${product.revision}`, product.masterEventId, JSON.stringify({ itemId: product.itemId, taskId: product.taskId, qualityStatus: product.qualityStatus, revision: product.revision }), now, product.itemId, product.revision),
  ]);
  if (affectedRows(result) === 0) throw new Error("产品已被其他请求更新，请刷新后重试");
  return product;
}

export async function listAoiWorkPackages(filters: { taskId?: string; masterEventId?: string; includeCancelled?: boolean; limit?: number }, owner?: string): Promise<AoiWorkPackage[]> {
  await ensureOperationalSchema();
  const db = await database();
  const limit = Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 200)));
  const result = await db.prepare(`SELECT payload_json FROM aoi_work_packages
      WHERE (?='' OR source_task_id=?) AND (?='' OR master_event_id=?) AND (?='' OR owner=?) AND (?=1 OR status!='cancelled')
      ORDER BY priority DESC, updated_at DESC LIMIT ?`)
    .bind(filters.taskId ?? "", filters.taskId ?? "", filters.masterEventId ?? "", filters.masterEventId ?? "", owner ?? "", owner ?? "", filters.includeCancelled ? 1 : 0, limit)
    .all<{ payload_json: string }>();
  return result.results.flatMap((row) => parseJsonRecord<AoiWorkPackage>(row.payload_json));
}

export async function createAoiWorkPackagesFromTask(input: { taskId: string; widthKm: number; heightKm: number; maximumPackages?: number }, actor: string, allowAllOwners = false): Promise<AoiWorkPackage[]> {
  await ensureOperationalSchema();
  const db = await database();
  const task = await db.prepare(`SELECT master_event_id, owner, title, priority, payload_json FROM satellite_tasks WHERE task_id=? AND status!='cancelled'`)
    .bind(input.taskId).first<{ master_event_id: string; owner: string; title: string; priority: number; payload_json: string }>();
  if (!task) throw new Error("用于分块的卫星任务不存在");
  if (!allowAllOwners && task.owner !== actor) throw new Error("任务不属于当前操作员");
  let taskPayload: Record<string, unknown>;
  try { taskPayload = JSON.parse(task.payload_json) as Record<string, unknown>; } catch { throw new Error("任务载荷损坏，无法生成 AOI 分块"); }
  const sourceGeometry = taskPayload.opportunityFootprint && typeof taskPayload.opportunityFootprint === "object"
    ? taskPayload.opportunityFootprint as GeoGeometry
    : buildTaskAoi(taskPayload);
  if (!sourceGeometry) throw new Error("任务缺少可分块的 AOI 几何");
  const geometries = partitionAoiGeometry(sourceGeometry, input);
  const now = new Date().toISOString();
  const packages: AoiWorkPackage[] = [];
  for (let index = 0; index < geometries.length; index += 1) {
    const geometry = geometries[index];
    const aoiHash = await sha256Hex(JSON.stringify(geometry));
    const packageId = `aoi-${(await sha256Hex(`${input.taskId}|${aoiHash}`)).slice(0, 40)}`;
    const existing = await db.prepare(`SELECT payload_json FROM aoi_work_packages WHERE package_id=?`).bind(packageId).first<{ payload_json: string }>();
    if (existing) { packages.push(...parseJsonRecord<AoiWorkPackage>(existing.payload_json)); continue; }
    const record: AoiWorkPackage = {
      packageId, masterEventId: task.master_event_id, sourceTaskId: input.taskId, owner: task.owner,
      title: `${task.title} · 分块 ${index + 1}/${geometries.length}`, geometry, aoiHash, status: "open",
      assignee: "", reviewer: "", priority: Number(task.priority), reviewNote: "", revision: 1, createdAt: now, updatedAt: now,
    };
    const payload = JSON.stringify(record);
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO aoi_work_packages (package_id, master_event_id, source_task_id, owner, title, geometry_json, aoi_hash, status, assignee, reviewer, priority, review_note, revision, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', '', '', ?, '', 1, ?, ?, ?)`)
        .bind(record.packageId, record.masterEventId, record.sourceTaskId, record.owner, record.title, JSON.stringify(record.geometry), record.aoiHash, record.priority, payload, now, now),
      db.prepare(`INSERT OR IGNORE INTO aoi_work_package_history (package_id, revision, actor, action, from_status, to_status, payload_json, changed_at) VALUES (?, 1, ?, 'create', NULL, 'open', ?, ?)`)
        .bind(record.packageId, actor, payload, now),
    ]);
    packages.push(record);
  }
  return packages;
}

export async function transitionStoredAoiWorkPackage(packageId: string, expectedRevision: number, action: AoiWorkPackageAction, actor: string, note: string, allowAllOwners = false): Promise<AoiWorkPackage> {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT owner, revision, payload_json FROM aoi_work_packages WHERE package_id=?`).bind(packageId)
    .first<{ owner: string; revision: number; payload_json: string }>();
  if (!row) throw new Error("AOI 分块不存在");
  if (!allowAllOwners && row.owner !== actor) throw new Error("AOI 分块不属于当前操作员");
  if (Number(row.revision) !== expectedRevision) throw new Error(`AOI 分块版本冲突：当前为 ${row.revision}，请求为 ${expectedRevision}`);
  const current = parseJsonRecord<AoiWorkPackage>(row.payload_json)[0];
  if (!current) throw new Error("AOI 分块记录损坏");
  const next = transitionAoiWorkPackage(current, action, actor, note);
  const payload = JSON.stringify(next);
  const [result] = await db.batch([
    db.prepare(`UPDATE aoi_work_packages SET status=?, assignee=?, reviewer=?, review_note=?, revision=?, payload_json=?, updated_at=? WHERE package_id=? AND revision=?`)
      .bind(next.status, next.assignee, next.reviewer, next.reviewNote, next.revision, payload, next.updatedAt, packageId, expectedRevision),
    db.prepare(`INSERT INTO aoi_work_package_history (package_id, revision, actor, action, from_status, to_status, payload_json, changed_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM aoi_work_packages WHERE package_id=? AND revision=?)`)
      .bind(packageId, next.revision, actor, action, current.status, next.status, payload, next.updatedAt, packageId, next.revision),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, 'aoi_work_package_transition', ?, ?, ? WHERE EXISTS (SELECT 1 FROM aoi_work_packages WHERE package_id=? AND revision=?)`)
      .bind(`aoi_work_package_transition:${packageId}:${next.revision}`, next.masterEventId, JSON.stringify({ packageId, action, actor, fromStatus: current.status, toStatus: next.status, revision: next.revision }), next.updatedAt, packageId, next.revision),
  ]);
  if (affectedRows(result) === 0) throw new Error("AOI 分块已被其他操作员更新，请刷新后重试");
  return next;
}

function parseJsonRecord<T>(value: string): T[] {
  try { const parsed = JSON.parse(value) as T; return parsed ? [parsed] : []; } catch { return []; }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function listRoadDisruptions(options: { includeInactive?: boolean; activeAt?: string } = {}): Promise<RoadDisruptionRegistryEntry[]> {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT payload_json FROM road_disruptions
    WHERE (?=1 OR lifecycle_status='active')
      AND (?='' OR valid_from IS NULL OR valid_from < ?)
      AND (?='' OR valid_to IS NULL OR valid_to > ?)
    ORDER BY CASE verification WHEN 'verified' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 500`)
    .bind(options.includeInactive ? 1 : 0, options.activeAt ?? "", options.activeAt ?? "", options.activeAt ?? "", options.activeAt ?? "")
    .all<{ payload_json: string }>();
  return result.results.flatMap((row) => {
    try {
      const entry = JSON.parse(row.payload_json) as RoadDisruptionRegistryEntry;
      return entry?.disruptionId ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export async function upsertRoadDisruptionReports(disruptions: RoadDisruption[], actor: string, allowAllOwners = false): Promise<RoadDisruptionRegistryEntry[]> {
  await ensureOperationalSchema();
  if (!disruptions.length || disruptions.length > 50) throw new Error("道路中断上报数量必须为 1–50 条");
  const db = await database();
  const now = new Date().toISOString();
  const saved: RoadDisruptionRegistryEntry[] = [];
  for (const disruption of disruptions) {
    const existing = await db.prepare(`SELECT owner, revision, reported_at FROM road_disruptions WHERE disruption_id=?`)
      .bind(disruption.disruptionId).first<{ owner: string; revision: number; reported_at: string }>();
    if (existing && !allowAllOwners && existing.owner !== actor) throw new Error("道路中断记录不属于当前操作员");
    const revision = Number(existing?.revision ?? 0) + 1;
    const entry: RoadDisruptionRegistryEntry = {
      ...disruption,
      verification: "reported",
      lifecycleStatus: "active",
      revision,
      reportedAt: existing?.reported_at ?? now,
      updatedAt: now,
      reportedBy: existing?.owner ?? actor,
      verifiedAt: undefined,
      verifiedBy: undefined,
      resolvedAt: undefined,
      resolvedBy: undefined,
    };
    const payload = JSON.stringify(entry);
    await db.batch([
      db.prepare(`INSERT INTO road_disruptions (disruption_id, owner, lifecycle_status, verification, revision, valid_from, valid_to, payload_json, reported_at, updated_at)
        VALUES (?, ?, 'active', 'reported', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(disruption_id) DO UPDATE SET lifecycle_status='active', verification='reported', revision=excluded.revision, valid_from=excluded.valid_from, valid_to=excluded.valid_to, payload_json=excluded.payload_json, updated_at=excluded.updated_at
        WHERE road_disruptions.revision=?`)
        .bind(entry.disruptionId, entry.reportedBy, revision, entry.validFrom ?? null, entry.validTo ?? null, payload, entry.reportedAt, now, revision - 1),
      db.prepare(`INSERT INTO road_disruption_history (disruption_id, revision, actor, action, payload_json, changed_at) VALUES (?, ?, ?, 'reported', ?, ?)`)
        .bind(entry.disruptionId, revision, actor, payload, now),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'road_disruption_reported', 'road-network', ?, ?)`)
        .bind(`road_disruption_reported:${entry.disruptionId}:${revision}`, JSON.stringify({ disruptionId: entry.disruptionId, revision, actor }), now),
    ]);
    saved.push(entry);
  }
  return saved;
}

export async function transitionRoadDisruption(disruptionId: string, expectedRevision: number, action: "verify" | "resolve" | "reject", actor: string, isAdmin: boolean): Promise<RoadDisruptionRegistryEntry> {
  await ensureOperationalSchema();
  if (!isAdmin) throw new Error("只有管理员可以核验或解除道路中断");
  const db = await database();
  const row = await db.prepare(`SELECT revision, payload_json FROM road_disruptions WHERE disruption_id=?`).bind(disruptionId)
    .first<{ revision: number; payload_json: string }>();
  if (!row) throw new Error("道路中断记录不存在");
  if (Number(row.revision) !== expectedRevision) throw new Error(`道路中断版本冲突：当前为 ${row.revision}，请求为 ${expectedRevision}`);
  const current = JSON.parse(row.payload_json) as RoadDisruptionRegistryEntry;
  if (action === "verify" && current.lifecycleStatus !== "active") throw new Error("只有有效记录可以核验");
  if ((action === "resolve" || action === "reject") && current.lifecycleStatus !== "active") return current;
  if (action === "verify" && current.verification === "verified") return current;
  const now = new Date().toISOString();
  const revision = expectedRevision + 1;
  const next: RoadDisruptionRegistryEntry = {
    ...current,
    revision,
    updatedAt: now,
    verification: action === "verify" ? "verified" : current.verification,
    lifecycleStatus: action === "resolve" ? "resolved" : action === "reject" ? "rejected" : "active",
    verifiedAt: action === "verify" ? now : current.verifiedAt,
    verifiedBy: action === "verify" ? actor : current.verifiedBy,
    resolvedAt: action === "resolve" || action === "reject" ? now : current.resolvedAt,
    resolvedBy: action === "resolve" || action === "reject" ? actor : current.resolvedBy,
  };
  const payload = JSON.stringify(next);
  const [result] = await db.batch([
    db.prepare(`UPDATE road_disruptions SET lifecycle_status=?, verification=?, revision=?, valid_from=?, valid_to=?, payload_json=?, updated_at=? WHERE disruption_id=? AND revision=?`)
      .bind(next.lifecycleStatus, next.verification, revision, next.validFrom ?? null, next.validTo ?? null, payload, now, disruptionId, expectedRevision),
    db.prepare(`INSERT INTO road_disruption_history (disruption_id, revision, actor, action, payload_json, changed_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM road_disruptions WHERE disruption_id=? AND revision=? AND payload_json=?)`)
      .bind(disruptionId, revision, actor, action, payload, now, disruptionId, revision, payload),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, ?, 'road-network', ?, ? WHERE EXISTS (SELECT 1 FROM road_disruptions WHERE disruption_id=? AND revision=? AND payload_json=?)`)
      .bind(`road_disruption_${action}:${disruptionId}:${revision}`, `road_disruption_${action}`, JSON.stringify({ disruptionId, revision, actor }), now, disruptionId, revision, payload),
  ]);
  if (affectedRows(result) === 0) throw new Error("道路中断已被其他请求更新，请刷新后重试");
  return next;
}

export async function operationalHealth() {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM canonical_events) AS events, (SELECT COUNT(*) FROM satellite_tasks WHERE status != 'cancelled') AS tasks, (SELECT COUNT(*) FROM satellite_orbits WHERE last_success_at IS NOT NULL) AS orbits, (SELECT COUNT(*) FROM road_disruptions WHERE lifecycle_status='active') AS disruptions`).first<{ events: number; tasks: number; orbits: number; disruptions: number }>();
  return { database: "ok" as const, events: Number(row?.events ?? 0), tasks: Number(row?.tasks ?? 0), orbits: Number(row?.orbits ?? 0), disruptions: Number(row?.disruptions ?? 0) };
}

export async function createWebSessionRecord(record: WebSessionRecord & { sessionHash: string }, maximumSessions = 5) {
  await ensureOperationalSchema();
  const db = await database();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`DELETE FROM web_sessions WHERE expires_at <= ?`).bind(now),
    db.prepare(`INSERT INTO web_sessions (session_hash, username, role, auth_version, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.sessionHash, record.username, record.role, record.authVersion, record.createdAt, record.lastSeenAt, record.expiresAt),
  ]);
  await db.prepare(`DELETE FROM web_sessions WHERE username = ? AND session_hash NOT IN (SELECT session_hash FROM web_sessions WHERE username = ? ORDER BY last_seen_at DESC LIMIT ?)`)
    .bind(record.username, record.username, maximumSessions).run();
}

export async function getWebSessionRecord(sessionHash: string, idleCutoff: string): Promise<WebSessionRecord | null> {
  await ensureOperationalSchema();
  const db = await database();
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT username, role, auth_version, created_at, last_seen_at, expires_at FROM web_sessions WHERE session_hash = ? AND expires_at > ? AND last_seen_at > ?`)
    .bind(sessionHash, now, idleCutoff)
    .first<{ username: string; role: string; auth_version: string; created_at: string; last_seen_at: string; expires_at: string }>();
  if (!row || !["viewer", "operator", "admin"].includes(row.role)) {
    await db.prepare(`DELETE FROM web_sessions WHERE session_hash = ?`).bind(sessionHash).run();
    return null;
  }
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    await db.prepare(`UPDATE web_sessions SET last_seen_at = ? WHERE session_hash = ?`).bind(now, sessionHash).run();
  }
  return {
    username: row.username,
    role: row.role as WebSessionRecord["role"],
    authVersion: row.auth_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export async function revokeWebSessionRecord(sessionHash: string) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`DELETE FROM web_sessions WHERE session_hash = ?`).bind(sessionHash).run();
}

export async function listSatelliteOrbitCache(): Promise<SatelliteOrbitCacheRecord[]> {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT norad_id, payload_json, last_attempt_at, last_success_at, last_error FROM satellite_orbits ORDER BY norad_id`).all<{ norad_id: number; payload_json: string; last_attempt_at: string; last_success_at: string | null; last_error: string | null }>();
  return result.results.map((row) => {
    let tle: SatelliteTleRecord | undefined;
    try {
      const parsed = JSON.parse(row.payload_json) as SatelliteTleRecord;
      if (parsed?.noradId === Number(row.norad_id) && parsed.tleLine1 && parsed.tleLine2) tle = parsed;
    } catch {
      // A malformed cache row is exposed as unavailable and replaced on refresh.
    }
    return {
      noradId: Number(row.norad_id),
      tle,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  });
}

export async function recordSatelliteOrbitSuccess(tle: SatelliteTleRecord) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO satellite_orbits (norad_id, payload_json, last_attempt_at, last_success_at, last_error) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(norad_id) DO UPDATE SET payload_json=excluded.payload_json, last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at, last_error=NULL`)
    .bind(tle.noradId, JSON.stringify(tle), tle.fetchedAt, tle.fetchedAt).run();
}

export async function recordSatelliteOrbitFailure(noradId: number, attemptedAt: string, error: string) {
  await ensureOperationalSchema();
  const db = await database();
  await db.prepare(`INSERT INTO satellite_orbits (norad_id, payload_json, last_attempt_at, last_success_at, last_error) VALUES (?, '{}', ?, NULL, ?)
    ON CONFLICT(norad_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_error=excluded.last_error`)
    .bind(noradId, attemptedAt, error.replace(/[\r\n]+/g, " ").slice(0, 240)).run();
}

export async function listOperationalChanges(after: string, afterId = "", limit = 200) {
  await ensureOperationalSchema();
  const db = await database();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const result = await db.prepare(`SELECT id, change_type, master_event_id, payload_json, created_at FROM operational_changes WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at, id LIMIT ?`)
    .bind(after, after, afterId, safeLimit).all<{ id: string; change_type: string; master_event_id: string; payload_json: string; created_at: string }>();
  return result.results.flatMap((row) => {
    try { return [{ id: row.id, type: row.change_type, masterEventId: row.master_event_id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }]; }
    catch { return []; }
  });
}

async function hasActiveEvidence(db: DatabaseLike, masterEventId: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM event_evidence e LEFT JOIN event_tombstones t ON t.source=e.source AND t.source_event_id=e.source_event_id WHERE e.master_event_id=? AND t.source IS NULL`)
    .bind(masterEventId).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

async function quarantineInvalidOperationalRecords(db: DatabaseLike) {
  const now = new Date().toISOString();
  let cursor = "";
  while (true) {
    const rows = await db.prepare(`SELECT id, payload_json FROM canonical_events WHERE lifecycle_status IN ('active', 'monitoring') AND id > ? ORDER BY id LIMIT ?`)
      .bind(cursor, operationalQueryBatchSize).all<{ id: string; payload_json: string }>();
    if (!rows.results.length) break;
    cursor = rows.results[rows.results.length - 1].id;
    for (const row of rows.results) {
      let event: DisasterEvent;
      try { event = JSON.parse(row.payload_json) as DisasterEvent; } catch { continue; }
      if (!eventHasInvalidIdentity(event)) continue;
      const tasks = await db.prepare(`SELECT task_id, owner, status, revision, payload_json FROM satellite_tasks WHERE master_event_id=? AND status IN ('candidate','reviewed','scheduled','submitted')`)
        .bind(row.id).all<LifecycleTaskRow>();
      const statements: DatabaseStatement[] = [
        db.prepare(`INSERT INTO event_quarantine (master_event_id, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?) ON CONFLICT(master_event_id) DO UPDATE SET reason=excluded.reason, payload_json=excluded.payload_json, quarantined_at=excluded.quarantined_at`)
          .bind(row.id, "invalid source identity", row.payload_json, now),
        db.prepare(`UPDATE canonical_events SET lifecycle_status='resolved', observation_expires_at=?, synced_at=? WHERE id=?`).bind(now, now, row.id),
        db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_quarantined', ?, ?, ?)`)
          .bind(`event_quarantined:${row.id}:${now}`, row.id, JSON.stringify({ reason: "invalid source identity", event }), now),
      ];
      for (const task of tasks.results) statements.push(...lifecycleTaskTransitionStatements(db, task, row.id, now, "主事件身份异常并已隔离"));
      await db.batch(statements);
    }
    if (rows.results.length < operationalQueryBatchSize) break;
  }
}

function affectedRows(result: unknown) {
  const value = result as { changes?: number; meta?: { changes?: number } } | null;
  return value?.changes ?? value?.meta?.changes ?? 1;
}

function distinctEvidenceSources(evidence: Array<{ source: string }>) {
  return new Set(evidence.map((item) => item.source.split(" · ")[0].trim())).size;
}

function lifecycleTaskTransitionStatements(db: DatabaseLike, task: LifecycleTaskRow, masterEventId: string, changedAt: string, reason: string) {
  const nextStatus = task.status === "submitted" ? "cancellation_requested" : "cancelled";
  const revision = Number(task.revision) + 1;
  let previousPayload: Record<string, unknown> = {};
  try { previousPayload = JSON.parse(task.payload_json) as Record<string, unknown>; } catch { /* retain normalized columns when legacy JSON is damaged */ }
  const cancellationRequestId = nextStatus === "cancellation_requested" ? `CANCEL-${task.task_id}-${revision}` : undefined;
  const payload = {
    ...previousPayload,
    status: nextStatus,
    revision,
    updatedAt: changedAt,
    externalStatusReason: reason,
    ...(cancellationRequestId ? { cancellationRequestId, cancellationRequestedAt: changedAt } : { cancelledAt: changedAt, cancellationReason: reason }),
  };
  const changeType = nextStatus === "cancellation_requested" ? "task_cancellation_requested" : "task_cancelled";
  const statements: DatabaseStatement[] = [
    db.prepare(`UPDATE satellite_tasks SET status=?, payload_json=?, updated_at=?, revision=? WHERE task_id=? AND status=? AND revision=?`)
      .bind(nextStatus, JSON.stringify(payload), changedAt, revision, task.task_id, task.status, task.revision),
    db.prepare(`INSERT OR IGNORE INTO task_revision_history (task_id, revision, owner, actor, from_status, to_status, reason, payload_json, changed_at)
      SELECT task_id, revision, owner, 'event-lifecycle', ?, status, ?, payload_json, updated_at FROM satellite_tasks WHERE task_id=? AND revision=?`)
      .bind(task.status, reason, task.task_id, revision),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM satellite_tasks WHERE task_id=? AND status=? AND revision=?)`)
      .bind(`${changeType}:${task.task_id}:${revision}`, changeType, masterEventId, JSON.stringify({ taskId: task.task_id, previousStatus: task.status, status: nextStatus, revision, cancellationRequestId, reason }), changedAt, task.task_id, nextStatus, revision),
  ];
  if (nextStatus === "cancelled") statements.push(
    db.prepare(`INSERT INTO task_cancellation_intents (task_id, owner, cancelled_at, actor, reason)
      SELECT ?, ?, ?, 'event-lifecycle', ? WHERE EXISTS (SELECT 1 FROM satellite_tasks WHERE task_id=? AND status='cancelled' AND revision=?)
      ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner, cancelled_at=excluded.cancelled_at, actor=excluded.actor, reason=excluded.reason`)
      .bind(task.task_id, task.owner, changedAt, reason, task.task_id, revision),
  );
  return statements;
}
