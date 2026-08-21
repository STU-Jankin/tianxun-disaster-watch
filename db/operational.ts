import type { DisasterEvent } from "../lib/disasters.ts";
import type { RoadDisruption, RoadDisruptionRegistryEntry } from "../lib/response-disruptions.ts";
import type { SatelliteOrbitCacheRecord, SatelliteTleRecord } from "../lib/satellite-orbits.ts";
import { canTransitionTask } from "../lib/task-contract.ts";
import { compareEventVersionFreshness, eventHasInvalidIdentity, isValidSourceEventId } from "../lib/event-integrity.ts";
import { evidenceReassignmentSql } from "../lib/operational-sql.ts";

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

let schemaReady: Promise<void> | null = null;
let databaseReady: Promise<DatabaseLike> | null = null;

type DatabaseStatement = {
  bind(...values: unknown[]): DatabaseStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
};

type DatabaseLike = {
  prepare(sql: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<unknown>;
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
    `CREATE TABLE IF NOT EXISTS satellite_orbits (norad_id INTEGER PRIMARY KEY NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', last_attempt_at TEXT NOT NULL, last_success_at TEXT, last_error TEXT)`,
    `CREATE INDEX IF NOT EXISTS satellite_orbits_success_idx ON satellite_orbits (last_success_at)`,
    `CREATE TABLE IF NOT EXISTS road_disruptions (disruption_id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, lifecycle_status TEXT NOT NULL, verification TEXT NOT NULL, revision INTEGER NOT NULL, valid_from TEXT, valid_to TEXT, payload_json TEXT NOT NULL, reported_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS road_disruptions_active_time_idx ON road_disruptions (lifecycle_status, valid_to, updated_at)`,
    `CREATE INDEX IF NOT EXISTS road_disruptions_owner_idx ON road_disruptions (owner, updated_at)`,
    `CREATE TABLE IF NOT EXISTS road_disruption_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, disruption_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS road_disruption_history_revision_uidx ON road_disruption_history (disruption_id, revision)`,
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
    const intentColumns = await db.prepare(`PRAGMA table_info(task_cancellation_intents)`).all<{ name: string }>();
    if (!intentColumns.results.some((column) => column.name === "owner")) await db.prepare(`ALTER TABLE task_cancellation_intents ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy'`).run();
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
    const tombstones = await db.prepare(`SELECT source, source_event_id FROM event_tombstones`).all<{ source: string; source_event_id: string }>();
    const blockedEvidence = new Set(tombstones.results.map((item) => `${item.source}|${item.source_event_id}`));
    const claimsResult = await db.prepare(`SELECT source, source_event_id, master_event_id, hazard FROM event_source_claims`).all<{ source: string; source_event_id: string; master_event_id: string; hazard: string }>();
    const claims = new Map(claimsResult.results.map((item) => [`${item.source}|${item.source_event_id}`, item]));
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
    await resolveClaimAliases(db);
    await db.prepare(`UPDATE canonical_events SET lifecycle_status = CASE WHEN observation_expires_at <= ? THEN 'archived' ELSE 'monitoring' END WHERE synced_at < ? AND lifecycle_status IN ('active', 'monitoring')`)
      .bind(syncMarker, syncMarker).run();
    return await readPersistedCanonicalEvents(db, canonicalEvents);
  } catch (error) {
    console.error("canonical event persistence unavailable", error);
    return null;
  }
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

async function resolveClaimAliases(db: DatabaseLike) {
  const aliases = await db.prepare(`SELECT c.id, c.hazard, c.payload_json, COUNT(e.id) AS evidence_count, COUNT(sc.source_event_id) AS claimed_count, COUNT(DISTINCT sc.master_event_id) AS target_count, MIN(sc.master_event_id) AS target_id
    FROM canonical_events c
    JOIN event_evidence e ON e.master_event_id = c.id
    LEFT JOIN event_source_claims sc ON sc.source = e.source AND sc.source_event_id = e.source_event_id AND sc.hazard = c.hazard
    WHERE c.lifecycle_status IN ('active','monitoring')
    GROUP BY c.id, c.hazard, c.payload_json`)
    .all<{ id: string; hazard: string; payload_json: string; evidence_count: number; claimed_count: number; target_count: number; target_id: string | null }>();

  for (const alias of aliases.results) {
    if (!alias.target_id || alias.target_id === alias.id || Number(alias.evidence_count) === 0 || Number(alias.claimed_count) !== Number(alias.evidence_count) || Number(alias.target_count) !== 1) continue;
    const target = await db.prepare(`SELECT id FROM canonical_events WHERE id = ? AND hazard = ?`).bind(alias.target_id, alias.hazard).first<{ id: string }>();
    if (!target) continue;
    const taskRows = await db.prepare(`SELECT task_id, owner, status, revision, payload_json FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
      .bind(alias.id).all<LifecycleTaskRow>();
    const now = new Date().toISOString();
    const reason = `历史别名已收敛到主事件 ${alias.target_id}`;
    let event: unknown = null;
    try { event = JSON.parse(alias.payload_json); } catch { /* keep an auditable null payload */ }
    const statements: DatabaseStatement[] = [
      db.prepare(`UPDATE canonical_events SET lifecycle_status='resolved', observation_expires_at=?, synced_at=? WHERE id=? AND lifecycle_status IN ('active','monitoring')`).bind(now, now, alias.id),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_merged', ?, ?, ?)`)
        .bind(`event_merged:${alias.id}:${now}`, alias.target_id, JSON.stringify({ fromMasterEventId: alias.id, toMasterEventId: alias.target_id, reason, event }), now),
    ];
    for (const task of taskRows.results) statements.push(...lifecycleTaskTransitionStatements(db, task, alias.id, now, `${reason}；旧任务必须重新核对 AOI`));
    await db.batch(statements);
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
      if (/CAP Update/i.test(reason)) continue;
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
  const rows = await db.prepare(`SELECT id, payload_json FROM canonical_events WHERE lifecycle_status IN ('active', 'monitoring')`).all<{ id: string; payload_json: string }>();
  const now = new Date().toISOString();
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
