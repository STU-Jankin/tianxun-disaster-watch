import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const canonicalEvents = sqliteTable("canonical_events", {
  id: text("id").primaryKey(),
  hazard: text("hazard").notNull(),
  title: text("title").notNull(),
  lifecycleStatus: text("lifecycle_status").notNull(),
  severity: text("severity").notNull(),
  geometryType: text("geometry_type").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  locationQuality: text("location_quality").notNull(),
  locationAccuracyKm: real("location_accuracy_km").notNull(),
  confidenceScore: integer("confidence_score").notNull(),
  occurredAt: text("occurred_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  observationExpiresAt: text("observation_expires_at").notNull(),
  payloadJson: text("payload_json").notNull(),
  syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("canonical_events_hazard_status_idx").on(table.hazard, table.lifecycleStatus),
  index("canonical_events_updated_idx").on(table.updatedAt),
]);

export const eventEvidence = sqliteTable("event_evidence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  masterEventId: text("master_event_id").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  observedAt: text("observed_at").notNull(),
  role: text("role").notNull(),
}, (table) => [
  uniqueIndex("event_evidence_source_event_uidx").on(table.masterEventId, table.source, table.sourceEventId),
  index("event_evidence_master_idx").on(table.masterEventId),
]);

export const satelliteTasks = sqliteTable("satellite_tasks", {
  taskId: text("task_id").primaryKey(),
  eventId: text("event_id").notNull(),
  masterEventId: text("master_event_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  priority: integer("priority").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  aoiType: text("aoi_type").notNull(),
  aoiJson: text("aoi_json").notNull(),
  sensorsJson: text("sensors_json").notNull(),
  imagingStart: text("imaging_start").notNull(),
  imagingEnd: text("imaging_end").notNull(),
  aoiApproval: text("aoi_approval").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("satellite_tasks_status_priority_idx").on(table.status, table.priority),
  index("satellite_tasks_event_idx").on(table.masterEventId),
]);

export const taskStatusHistory = sqliteTable("task_status_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  note: text("note").notNull().default(""),
  changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("task_status_history_task_idx").on(table.taskId, table.changedAt)]);
