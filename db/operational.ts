import type { DisasterEvent } from "../lib/disasters";
import { canTransitionTask } from "../lib/task-contract";

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

  constructor(private readonly prepareStatement: () => NodePreparedStatement) {}

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
    `CREATE TABLE IF NOT EXISTS satellite_tasks (task_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, master_event_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, aoi_type TEXT NOT NULL, aoi_json TEXT NOT NULL, sensors_json TEXT NOT NULL, imaging_start TEXT NOT NULL, imaging_end TEXT NOT NULL, aoi_approval TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_status_priority_idx ON satellite_tasks (status, priority)`,
    `CREATE INDEX IF NOT EXISTS satellite_tasks_event_idx ON satellite_tasks (master_event_id)`,
    `CREATE TABLE IF NOT EXISTS task_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS task_status_history_task_idx ON task_status_history (task_id, changed_at)`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_insert AFTER INSERT ON satellite_tasks BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, NULL, NEW.status, 'task created'); END`,
    `CREATE TRIGGER IF NOT EXISTS satellite_tasks_history_update AFTER UPDATE OF status ON satellite_tasks WHEN OLD.status != NEW.status BEGIN INSERT INTO task_status_history (task_id, from_status, to_status, note) VALUES (NEW.task_id, OLD.status, NEW.status, 'status changed'); END`,
    `CREATE TABLE IF NOT EXISTS event_tombstones (source TEXT NOT NULL, source_event_id TEXT NOT NULL, reason TEXT NOT NULL, resolved_at TEXT NOT NULL, PRIMARY KEY (source, source_event_id))`,
  ];
  schemaReady = database().then((db) => db.batch(statements.map((statement) => db.prepare(statement))))
    .then(() => undefined)
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
    const acceptedEvents = events.flatMap((event) => {
      const evidence = event.evidence.filter((item) => !blockedEvidence.has(`${item.source}|${item.sourceEventId}`));
      if (!evidence.length) return [];
      return [{ ...event, evidence, evidenceCount: evidence.length }];
    });
    const statements = acceptedEvents.flatMap((event) => [
      db.prepare(`INSERT INTO canonical_events (id, hazard, title, lifecycle_status, severity, geometry_type, latitude, longitude, location_quality, location_accuracy_km, confidence_score, occurred_at, updated_at, observation_expires_at, payload_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hazard=excluded.hazard, title=excluded.title, lifecycle_status=excluded.lifecycle_status, severity=excluded.severity, geometry_type=excluded.geometry_type, latitude=excluded.latitude, longitude=excluded.longitude, location_quality=excluded.location_quality, location_accuracy_km=excluded.location_accuracy_km, confidence_score=excluded.confidence_score, occurred_at=excluded.occurred_at, updated_at=excluded.updated_at, observation_expires_at=excluded.observation_expires_at, payload_json=excluded.payload_json, synced_at=excluded.synced_at`)
        .bind(event.masterEventId, event.hazard, event.title, event.lifecycleStatus, event.severity, event.geometryType, event.latitude, event.longitude, event.locationQuality, event.locationAccuracyKm, event.confidenceScore, event.occurredAt, event.updatedAt, event.observationExpiresAt, JSON.stringify(event), syncMarker),
      ...event.evidence.map((item) => db.prepare(`INSERT INTO event_evidence (master_event_id, source, source_url, source_event_id, observed_at, role) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(master_event_id, source, source_event_id) DO UPDATE SET source_url=excluded.source_url, observed_at=excluded.observed_at, role=excluded.role`)
        .bind(event.masterEventId, item.source, item.sourceUrl, item.sourceEventId, item.observedAt, item.role)),
    ]);
    for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
    await db.prepare(`UPDATE canonical_events SET lifecycle_status = CASE WHEN observation_expires_at <= ? THEN 'archived' ELSE 'monitoring' END WHERE synced_at < ? AND lifecycle_status IN ('active', 'monitoring')`)
      .bind(syncMarker, syncMarker).run();
    return true;
  } catch (error) {
    console.error("canonical event persistence unavailable", error);
    return false;
  }
}

export async function listSatelliteTasks() {
  await ensureOperationalSchema();
  const db = await database();
  const result = await db.prepare(`SELECT payload_json FROM satellite_tasks WHERE status != 'cancelled' ORDER BY priority DESC, updated_at DESC`).all<{ payload_json: string }>();
  return result.results.map((row) => JSON.parse(row.payload_json) as TaskRecord);
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
  const result = await db.prepare(`SELECT lifecycle_status, payload_json FROM canonical_events WHERE lifecycle_status IN ('active', 'monitoring') AND observation_expires_at > ? ORDER BY updated_at DESC LIMIT 1000`)
    .bind(new Date().toISOString()).all<{ lifecycle_status: DisasterEvent["lifecycleStatus"]; payload_json: string }>();
  return result.results.flatMap((row) => {
    try {
      const event = JSON.parse(row.payload_json) as DisasterEvent;
      return [{ ...event, lifecycleStatus: row.lifecycle_status }];
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
  try {
    return { lifecycleStatus: row.lifecycle_status, observationExpiresAt: row.observation_expires_at, event: JSON.parse(row.payload_json) as DisasterEvent };
  } catch {
    return null;
  }
}

export async function upsertSatelliteTask(task: TaskRecord) {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT status FROM satellite_tasks WHERE task_id = ?`).bind(task.taskId).first<{ status: string }>();
  if (!canTransitionTask(existing?.status ?? null, task.status)) throw new Error(`不允许的任务状态转换：${existing?.status ?? "new"} -> ${task.status}`);
  const updatedAt = new Date().toISOString();
  const payload = { ...task, updatedAt };
  const aoi = JSON.stringify({ type: task.aoiType, sourceGeometry: task.sourceGeometry, radiusKm: task.aoiRadiusKm, widthKm: task.aoiWidthKm, heightKm: task.aoiHeightKm, lengthKm: task.aoiLengthKm, bearingDeg: task.aoiBearingDeg });
  const save = existing
    ? db.prepare(`UPDATE satellite_tasks SET event_id=?, master_event_id=?, title=?, status=?, priority=?, latitude=?, longitude=?, aoi_type=?, aoi_json=?, sensors_json=?, imaging_start=?, imaging_end=?, aoi_approval=?, payload_json=?, updated_at=? WHERE task_id=? AND status=?`)
      .bind(task.eventId, task.masterEventId, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), updatedAt, task.taskId, existing.status)
    : db.prepare(`INSERT INTO satellite_tasks (task_id, event_id, master_event_id, title, status, priority, latitude, longitude, aoi_type, aoi_json, sensors_json, imaging_start, imaging_end, aoi_approval, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(task.taskId, task.eventId, task.masterEventId, task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, aoi, JSON.stringify(task.sensors ?? []), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(payload), task.createdAt, updatedAt);
  const result = await save.run();
  if (existing && affectedRows(result) === 0) throw new Error("任务已被其他请求更新，请刷新后重试");
  return payload;
}

export async function deleteSatelliteTask(taskId: string) {
  await ensureOperationalSchema();
  const db = await database();
  const existing = await db.prepare(`SELECT status FROM satellite_tasks WHERE task_id = ?`).bind(taskId).first<{ status: string }>();
  if (!existing) return false;
  if (!canTransitionTask(existing.status, "cancelled")) throw new Error(`不允许取消状态为 ${existing.status} 的任务`);
  const result = await db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = ?`).bind(new Date().toISOString(), taskId, existing.status).run();
  if (affectedRows(result) === 0) throw new Error("任务已被其他请求更新，请刷新后重试");
  return true;
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
      const taskRows = await db.prepare(`SELECT task_id, status FROM satellite_tasks WHERE master_event_id = ? AND status IN ('candidate', 'reviewed', 'scheduled', 'submitted')`)
        .bind(row.master_event_id).all<{ task_id: string; status: string }>();
      const now = new Date().toISOString();
      const statements: DatabaseStatement[] = [
        db.prepare(`UPDATE canonical_events SET lifecycle_status = 'resolved', observation_expires_at = ?, synced_at = ? WHERE id = ?`).bind(now, now, row.master_event_id),
      ];
      for (const task of taskRows.results) {
        statements.push(db.prepare(`UPDATE satellite_tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = ?`).bind(now, task.task_id, task.status));
      }
      await db.batch(statements);
      resolved += 1;
    }
  }
  return resolved;
}

function affectedRows(result: unknown) {
  const value = result as { changes?: number; meta?: { changes?: number } } | null;
  return value?.changes ?? value?.meta?.changes ?? 1;
}
