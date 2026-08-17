import type { DisasterEvent } from "../lib/disasters";
import { canTransitionTask } from "../lib/task-contract";
import { eventHasInvalidIdentity, isValidSourceEventId } from "../lib/event-integrity";
import { evidenceReassignmentSql } from "../lib/operational-sql";

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
    `CREATE TABLE IF NOT EXISTS satellite_tasks (task_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, master_event_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, aoi_type TEXT NOT NULL, aoi_json TEXT NOT NULL, sensors_json TEXT NOT NULL, imaging_start TEXT NOT NULL, imaging_end TEXT NOT NULL, aoi_approval TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, event_revision TEXT NOT NULL DEFAULT '', aoi_hash TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_status_priority_idx ON satellite_tasks (status, priority)`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_event_idx ON satellite_tasks (master_event_id)`,
    `CREATE TABLE IF NOT EXISTS task_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS task_status_history_task_idx ON task_status_history (task_id, changed_at)`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_insert AFTER INSERT ON satellite_tasks BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, NULL, NEW.status, 'task created'); END`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_update AFTER UPDATE OF status ON satellite_tasks WHEN OLD.status != NEW.status BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, OLD.status, NEW.status, 'status changed'); END`,
    `CREATE TABLE IF NOT EXISTS event_tombstones (source TEXT NOT NULL, source_event_id TEXT NOT NULL, reason TEXT NOT NULL, resolved_at TEXT NOT NULL, PRIMARY KEY (source, source_event_id))`,
    `CREATE TABLE IF NOT EXISTS event_source_claims (source TEXT NOT NULL, source_event_id TEXT NOT NULL, master_event_id TEXT NOT NULL, hazard TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (source, source_event_id))`,
    `CREATE TABLE IF NOT EXISTS event_quarantine (master_event_id TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL, quarantined_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS operational_changes (id TEXT PRIMARY KEY NOT NULL, change_type TEXT NOT NULL, master_event_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS operational_changes_created_idx ON operational_changes (created_at, id)`,
  ];
  schemaReady = database().then(async (db) => {
    await db.batch(statements.map((statement) => db.prepare(statement)));
    const columns = await db.prepare(`PRAGMA table_info(satellite_tasks)`).all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    const migrations: DatabaseStatement[] = [];
    if (!names.has("revision")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`));
    if (!names.has("event_revision")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN event_revision TEXT NOT NULL DEFAULT ''`));
    if (!names.has("aoi_hash")) migrations.push(db.prepare(`ALTER TABLE satellite_tasks ADD COLUMN aoi_hash TEXT NOT NULL DEFAULT ''`));
    if (migrations.length) await db.batch(migrations);
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

export async function persistCanonicalEvents(events: DisasterEvent[]) {
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
      const event = { ...originalEvent, masterEventId, evidence: acceptedEvidence, evidenceCount: acceptedEvidence.length };
      acceptedEvidence.forEach((item) => claims.set(`${item.source}|${item.sourceEventId}`, { source: item.source, source_event_id: item.sourceEventId, master_event_id: masterEventId, hazard: event.hazard }));
      acceptedEvents.push(event);
    }
    const statements = acceptedEvents.flatMap((event) => [
      db.prepare(`INSERT INTO canonical_events (id, hazard, title, lifecycle_status, severity, geometry_type, latitude, longitude, location_quality, location_accuracy_km, confidence_score, occurred_at, updated_at, observation_expires_at, payload_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hazard=excluded.hazard, title=excluded.title, lifecycle_status=excluded.lifecycle_status, severity=excluded.severity, geometry_type=excluded.geometry_type, latitude=excluded.latitude, longitude=excluded.longitude, location_quality=excluded.location_quality, location_accuracy_km=excluded.location_accuracy_km, confidence_score=excluded.confidence_score, occurred_at=excluded.occurred_at, updated_at=excluded.updated_at, observation_expires_at=excluded.observation_expires_at, payload_json=excluded.payload_json, synced_at=excluded.synced_at`)
        .bind(event.masterEventId, event.hazard, event.title, event.lifecycleStatus, event.severity, event.geometryType, event.latitude, event.longitude, event.locationQuality, event.locationAccuracyKm, event.confidenceScore, event.occurredAt, event.updatedAt, event.observationExpiresAt, JSON.stringify(event), syncMarker),
      ...event.evidence.map((item) => db.prepare(`INSERT INTO event_evidence (master_event_id, source, source_url, source_event_id, observed_at, role) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(master_event_id, source, source_event_id) DO UPDATE SET source_url=excluded.source_url, observed_at=excluded.observed_at, role=excluded.role`)
        .bind(event.masterEventId, item.source, item.sourceUrl, item.sourceEventId, item.observedAt, item.role)),
      ...event.evidence.map((item) => db.prepare(`INSERT INTO event_source_claims (source, source_event_id, master_event_id, hazard, claimed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, source_event_id) DO NOTHING`)
        .bind(item.source, item.sourceEventId, event.masterEventId, event.hazard, syncMarker)),
    ]);
    for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
    await resolveClaimAliases(db);
    await db.prepare(`UPDATE canonical_events SET lifecycle_status = CASE WHEN observation_expires_at <= ? THEN 'archived' ELSE 'monitoring' END WHERE synced_at < ? AND lifecycle_status IN ('active', 'monitoring')`)
      .bind(syncMarker, syncMarker).run();
    return true;
  } catch (error) {
    console.error("canonical event persistence unavailable", error);
    return false;
  }
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
    const taskRows = await db.prepare(`SELECT task_id, status FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
      .bind(alias.id).all<{ task_id: string; status: string }>();
    const now = new Date().toISOString();
    const reason = `历史别名已收敛到主事件 ${alias.target_id}`;
    let event: unknown = null;
    try { event = JSON.parse(alias.payload_json); } catch { /* keep an auditable null payload */ }
    const statements: DatabaseStatement[] = [
      db.prepare(`UPDATE canonical_events SET lifecycle_status='resolved', observation_expires_at=?, synced_at=? WHERE id=? AND lifecycle_status IN ('active','monitoring')`).bind(now, now, alias.id),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_merged', ?, ?, ?)`)
        .bind(`event_merged:${alias.id}:${now}`, alias.target_id, JSON.stringify({ fromMasterEventId: alias.id, toMasterEventId: alias.target_id, reason, event }), now),
    ];
    for (const task of taskRows.results) {
      statements.push(db.prepare(`UPDATE satellite_tasks SET status='cancelled', updated_at=? WHERE task_id=? AND status=?`).bind(now, task.task_id, task.status));
      statements.push(db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'task_cancelled', ?, ?, ?)`)
        .bind(`task_cancelled:${task.task_id}:${now}`, alias.id, JSON.stringify({ taskId: task.task_id, previousStatus: task.status, reason: `${reason}；旧任务必须重新核对 AOI` }), now));
    }
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
      db.prepare(`SELECT task_id, status FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate','reviewed','scheduled','submitted')`)
        .bind(source.id).all<{ task_id: string; status: string }>(),
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
    for (const task of taskRows.results) {
      statements.push(db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = ?`).bind(now, task.task_id, task.status));
      statements.push(db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'task_cancelled', ?, ?, ?)`)
        .bind(`task_cancelled:${task.task_id}:${now}`, source.id, JSON.stringify({ taskId: task.task_id, previousStatus: task.status, reason: `${reason}；旧任务必须重新核对 AOI` }), now));
    }
    await db.batch(statements);
  }
  return target;
}

export async function listSatelliteTasks() {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE status != 'cancelled' ORDER BY priority DESC, updated_at DESC LIMIT 500`).all<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>();
  return result.results.flatMap((row): TaskRecord[] => {
    try {
      const payload = JSON.parse(row.payload_json) as TaskRecord;
      return [{ ...payload, status: row.status, revision: row.revision, eventRevision: row.event_revision, aoiHash: row.aoi_hash, updatedAt: row.updated_at }];
    } catch { return []; }
  });
}

export async function getSatelliteTask(taskId: string) {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT status, revision, event_revision, aoi_hash, updated_at, payload_json FROM satellite_tasks WHERE task_id = ? AND status != 'cancelled'`)
    .bind(taskId).first<{ status: string; revision: number; event_revision: string; aoi_hash: string; updated_at: string; payload_json: string }>();
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as TaskRecord;
    return { ...payload, status: row.status, revision: row.revision, eventRevision: row.event_revision, aoiHash: row.aoi_hash, updatedAt: row.updated_at };
  } catch { return null; }
}

export async function listSatelliteTaskCancellationIds() {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT task_id FROM satellite_tasks WHERE status = 'cancelled' ORDER BY updated_at DESC LIMIT 5000`).all<{ task_id: string }>();
  return result.results.map((row) => row.task_id);
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
      return [{ ...event, evidence, evidenceCount: evidence.length, lifecycleStatus: row.lifecycle_status }];
    } catch {
      return [];
    }
  });
}

export async function getCanonicalEventForTask(masterEventId: string) {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT lifecycle_status, observation_expires_at, payload_json FROM canonical_events WHERE id = ?`)
    .bind(masterEventId).first<{ lifecycle_status: string; observation_expires_at: string; payload_json: string }>();
  if (!row) return null;
  if (!await hasActiveEvidence(db, masterEventId)) return null;
  try {
    const event = JSON.parse(row.payload_json) as DisasterEvent;
    if (eventHasInvalidIdentity(event)) return null;
    return { lifecycleStatus: row.lifecycle_status, observationExpiresAt: row.observation_expires_at, event };
  } catch {
    return null;
  }
}

export async function upsertSatelliteTask(task: TaskRecord) {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT status, revision FROM satellite_tasks WHERE task_id = ?`).bind(task.taskId).first<{ status: string; revision: number }>();
  if (!canTransitionTask(existing?.status ?? null, task.status)) throw new Error(`不允许的任务状态转换：${existing?.status ?? "new"} -> ${task.status}`);
  const suppliedRevision = Number(task.revision ?? 0);
  if (existing && suppliedRevision !== existing.revision) throw new Error(`任务版本冲突：当前为 ${existing.revision}，请求为 ${suppliedRevision}`);
  if (!existing && suppliedRevision !== 0) throw new Error("新任务 revision 必须为 0");
  const updatedAt = new Date().toISOString();
  const revision = existing ? existing.revision + 1 : 1;
  const payload = { ...task, revision, updatedAt };
  const aoi = JSON.stringify({ type: task.aoiType, sourceGeometry: task.sourceGeometry, customGeometry: task.customGeometry, radiusKm: task.aoiRadiusKm, widthKm: task.aoiWidthKm, heightKm: task.aoiHeightKm, lengthKm: task.aoiLengthKm, bearingDeg: task.aoiBearingDeg });
  const save = existing
    ? db.prepare(`UPDATE satellite_tasks SET event_id=?, master_event_id=?, title=?, status=?, priority=?, latitude=?, longitude=?, aoi_type=?, aoi_json=?, sensors_json=?, imaging_start=?, imaging_end=?, aoi_approval=?, payload_json=?, updated_at=?, revision=?, event_revision=?, aoi_hash=? WHERE task_id=? AND status=? AND revision=?`)
      .bind(task.eventId, task.masterEventId, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), updatedAt, revision, task.eventRevision ?? "", task.aoiHash ?? "", task.taskId, existing.status, existing.revision)
    : db.prepare(`INSERT INTO satellite_tasks (task_id, event_id, master_event_id, title, status, priority, latitude, longitude, aoi_type, aoi_json, sensors_json, imaging_start, imaging_end, aoi_approval, payload_json, created_at, updated_at, revision, event_revision, aoi_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(task.taskId, task.eventId, task.masterEventId, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), task.createdAt, updatedAt, revision, task.eventRevision ?? "", task.aoiHash ?? "");
  const result = await save.run();
  if (existing && affectedRows(result) === 0) throw new Error("任务已被其他请求更新，请刷新后重试");
  return payload;
}

export async function deleteSatelliteTask(taskId: string, expectedRevision?: number, actor = "api", reason = "操作员取消任务") {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT status, revision, master_event_id, payload_json FROM satellite_tasks WHERE task_id = ?`).bind(taskId).first<{ status: string; revision: number; master_event_id: string; payload_json: string }>();
  if (!existing) return { state: "already_absent" as const, revision: null };
  if (existing.status === "cancelled") return { state: "already_cancelled" as const, revision: existing.revision };
  if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw new Error(`任务版本冲突：当前为 ${existing.revision}，请求为 ${expectedRevision}`);
  if (!canTransitionTask(existing.status, "cancelled")) throw new Error(`不允许取消状态为 ${existing.status} 的任务`);
  const cancelledAt = new Date().toISOString();
  const revision = existing.revision + 1;
  let previousPayload: Record<string, unknown> = {};
  try { previousPayload = JSON.parse(existing.payload_json) as Record<string, unknown>; } catch { /* 旧数据仍按规范化列完成取消。 */ }
  const payload = { ...previousPayload, status: "cancelled", revision, updatedAt: cancelledAt, cancelledAt, cancelledBy: actor, cancellationReason: reason };
  const statements = [
    db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', payload_json = ?, updated_at = ?, revision = ? WHERE task_id = ? AND status = ? AND revision = ?`)
      .bind(JSON.stringify(payload), cancelledAt, revision, taskId, existing.status, existing.revision),
    db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at)
      SELECT ?, 'task_cancelled', ?, ?, ? WHERE changes() > 0`)
      .bind(`task_cancelled:${taskId}:${revision}`, existing.master_event_id, JSON.stringify({ taskId, previousStatus: existing.status, revision, actor, reason }), cancelledAt),
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
      const taskRows = await db.prepare(`SELECT task_id, status FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate', 'reviewed', 'scheduled', 'submitted')`)
        .bind(row.master_event_id).all<{ task_id: string; status: string }>();
      const now = new Date().toISOString();
      const statements: DatabaseStatement[] = [
        db.prepare(`UPDATE canonical_events SET lifecycle_status = 'resolved', observation_expires_at = ?, synced_at = ? WHERE id = ?`).bind(now, now, row.master_event_id),
        db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_resolved', ?, ?, ?)`)
          .bind(`event_resolved:${row.master_event_id}:${now}`, row.master_event_id, JSON.stringify({ reason, event: canonical ? JSON.parse(canonical.payload_json) : null }), now),
      ];
      for (const task of taskRows.results) {
        statements.push(db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = ?`).bind(now, task.task_id, task.status));
        statements.push(db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'task_cancelled', ?, ?, ?)`)
          .bind(`task_cancelled:${task.task_id}:${now}`, row.master_event_id, JSON.stringify({ taskId: task.task_id, previousStatus: task.status, reason }), now));
      }
      await db.batch(statements);
      resolved += 1;
    }
  }
  return resolved;
}

export async function operationalHealth() {
  await ensureOperationalSchema();
  const db = await database();
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM canonical_events) AS events, (SELECT COUNT(*) FROM satellite_tasks WHERE status != 'cancelled') AS tasks`).first<{ events: number; tasks: number }>();
  return { database: "ok" as const, events: Number(row?.events ?? 0), tasks: Number(row?.tasks ?? 0) };
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
    await db.batch([
      db.prepare(`INSERT INTO event_quarantine (master_event_id, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?) ON CONFLICT(master_event_id) DO UPDATE SET reason=excluded.reason, payload_json=excluded.payload_json, quarantined_at=excluded.quarantined_at`)
        .bind(row.id, "invalid source identity", row.payload_json, now),
      db.prepare(`UPDATE canonical_events SET lifecycle_status='resolved', observation_expires_at=?, synced_at=? WHERE id=?`).bind(now, now, row.id),
      db.prepare(`UPDATE satellite_tasks SET status='cancelled', updated_at=? WHERE master_event_id=? AND status IN ('candidate','reviewed','scheduled','submitted')`).bind(now, row.id),
      db.prepare(`INSERT OR IGNORE INTO operational_changes (id, change_type, master_event_id, payload_json, created_at) VALUES (?, 'event_quarantined', ?, ?, ?)`)
        .bind(`event_quarantined:${row.id}:${now}`, row.id, JSON.stringify({ reason: "invalid source identity", event }), now),
    ]);
  }
}

function affectedRows(result: unknown) {
  const value = result as { changes?: number; meta?: { changes?: number } } | null;
  return value?.changes ?? value?.meta?.changes ?? 1;
}
