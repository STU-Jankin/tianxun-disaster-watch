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
  owner: text("owner").notNull().default("legacy"),
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
  revision: integer("revision").notNull().default(1),
  eventRevision: text("event_revision").notNull().default(""),
  aoiHash: text("aoi_hash").notNull().default(""),
}, (table) => [
  index("satellite_tasks_status_priority_idx").on(table.status, table.priority),
  index("satellite_tasks_event_idx").on(table.masterEventId),
  index("satellite_tasks_owner_status_idx").on(table.owner, table.status),
]);

export const taskCancellationIntents = sqliteTable("task_cancellation_intents", {
  taskId: text("task_id").primaryKey(),
  owner: text("owner").notNull().default("legacy"),
  cancelledAt: text("cancelled_at").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason").notNull(),
}, (table) => [index("task_cancellation_intents_owner_time_idx").on(table.owner, table.cancelledAt)]);

export const taskExportPackages = sqliteTable("task_export_packages", {
  packageId: text("package_id").primaryKey(),
  format: text("format").notNull(),
  taskIdsJson: text("task_ids_json").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
});

export const satelliteOrbits = sqliteTable("satellite_orbits", {
  noradId: integer("norad_id").primaryKey(),
  payloadJson: text("payload_json").notNull().default("{}"),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
}, (table) => [index("satellite_orbits_success_idx").on(table.lastSuccessAt)]);

export const taskStatusHistory = sqliteTable("task_status_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  note: text("note").notNull().default(""),
  changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("task_status_history_task_idx").on(table.taskId, table.changedAt)]);

export const taskRevisionHistory = sqliteTable("task_revision_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull(),
  revision: integer("revision").notNull(),
  owner: text("owner").notNull(),
  actor: text("actor").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason").notNull(),
  payloadJson: text("payload_json").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [
  uniqueIndex("task_revision_history_task_revision_uidx").on(table.taskId, table.revision),
  index("task_revision_history_owner_time_idx").on(table.owner, table.changedAt),
]);

export const eventTombstones = sqliteTable("event_tombstones", {
  source: text("source").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  reason: text("reason").notNull(),
  resolvedAt: text("resolved_at").notNull(),
}, (table) => [uniqueIndex("event_tombstones_source_event_uidx").on(table.source, table.sourceEventId)]);

export const eventSourceClaims = sqliteTable("event_source_claims", {
  source: text("source").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  masterEventId: text("master_event_id").notNull(),
  hazard: text("hazard").notNull(),
  claimedAt: text("claimed_at").notNull(),
}, (table) => [uniqueIndex("event_source_claims_source_event_uidx").on(table.source, table.sourceEventId)]);

export const eventQuarantine = sqliteTable("event_quarantine", {
  masterEventId: text("master_event_id").primaryKey(),
  reason: text("reason").notNull(),
  payloadJson: text("payload_json").notNull(),
  quarantinedAt: text("quarantined_at").notNull(),
});

export const operationalChanges = sqliteTable("operational_changes", {
  id: text("id").primaryKey(),
  changeType: text("change_type").notNull(),
  masterEventId: text("master_event_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("operational_changes_created_idx").on(table.createdAt, table.id)]);

export const planningScenarios = sqliteTable("planning_scenarios", {
  scenarioId: text("scenario_id").primaryKey(),
  seriesId: text("series_id").notNull(),
  version: integer("version").notNull(),
  parentScenarioId: text("parent_scenario_id"),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  problemFingerprint: text("problem_fingerprint").notNull(),
  objectiveScore: integer("objective_score").notNull(),
  assignmentCount: integer("assignment_count").notNull(),
  conditionalAssignmentCount: integer("conditional_assignment_count").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("planning_scenarios_series_version_uidx").on(table.seriesId, table.version),
  index("planning_scenarios_owner_time_idx").on(table.owner, table.createdAt),
]);

export const webSessions = sqliteTable("web_sessions", {
  sessionHash: text("session_hash").primaryKey(),
  username: text("username").notNull(),
  role: text("role").notNull(),
  authVersion: text("auth_version").notNull().default(""),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("web_sessions_expiry_idx").on(table.expiresAt),
  index("web_sessions_user_seen_idx").on(table.username, table.lastSeenAt),
]);

export const sourceRegistry = sqliteTable("source_registry", {
  sourceId: text("source_id").primaryKey(),
  name: text("name").notNull(),
  tier: text("tier").notNull(),
  role: text("role").notNull(),
  authorityClass: text("authority_class").notNull(),
  setupUrl: text("setup_url").notNull(),
  pollIntervalMinutes: integer("poll_interval_minutes").notNull(),
  latencySloMinutes: integer("latency_slo_minutes").notNull(),
  updateSemantics: text("update_semantics").notNull(),
  geometrySemantics: text("geometry_semantics").notNull(),
  licenseNote: text("license_note").notNull(),
  state: text("state").notNull(),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastSuccessAt: text("last_success_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastDurationMs: integer("last_duration_ms").notNull().default(0),
  lastCount: integer("last_count").notNull().default(0),
  lastMessage: text("last_message").notNull(),
}, (table) => [
  index("source_registry_state_idx").on(table.state, table.lastAttemptAt),
  index("source_registry_success_idx").on(table.lastSuccessAt),
]);

export const sourcePayloads = sqliteTable("source_payloads", {
  payloadSha256: text("payload_sha256").primaryKey(),
  contentType: text("content_type").notNull(),
  bodyText: text("body_text").notNull(),
  byteLength: integer("byte_length").notNull(),
  storedByteLength: integer("stored_byte_length").notNull(),
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const sourceFetchRuns = sqliteTable("source_fetch_runs", {
  runId: text("run_id").primaryKey(),
  refreshId: text("refresh_id").notNull(),
  sourceId: text("source_id").notNull(),
  requestedUrl: text("requested_url").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  httpStatus: integer("http_status"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  payloadSha256: text("payload_sha256"),
  errorMessage: text("error_message"),
}, (table) => [
  index("source_fetch_runs_source_time_idx").on(table.sourceId, table.fetchedAt),
  index("source_fetch_runs_refresh_idx").on(table.refreshId),
]);

export const ingestionSnapshots = sqliteTable("ingestion_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  refreshId: text("refresh_id").notNull(),
  capturedAt: text("captured_at").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  eventCount: integer("event_count").notNull(),
  sourceCount: integer("source_count").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("ingestion_snapshots_payload_idx").on(table.payloadSha256),
  index("ingestion_snapshots_captured_idx").on(table.capturedAt),
]);

export const eventReviews = sqliteTable("event_reviews", {
  masterEventId: text("master_event_id").primaryKey(),
  status: text("status").notNull(),
  assignee: text("assignee").notNull().default(""),
  conclusion: text("conclusion").notNull().default(""),
  exposureIndex: integer("exposure_index"),
  exposureBasis: text("exposure_basis"),
  vulnerabilityIndex: integer("vulnerability_index"),
  vulnerabilityBasis: text("vulnerability_basis"),
  alertAcknowledgedAt: text("alert_acknowledged_at"),
  alertAcknowledgedBy: text("alert_acknowledged_by"),
  alertAcknowledgedVersion: text("alert_acknowledged_version"),
  eventRevision: text("event_revision").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
}, (table) => [
  index("event_reviews_status_time_idx").on(table.status, table.updatedAt),
  index("event_reviews_assignee_status_idx").on(table.assignee, table.status),
]);

export const eventReviewHistory = sqliteTable("event_review_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  masterEventId: text("master_event_id").notNull(),
  revision: integer("revision").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  payloadJson: text("payload_json").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [
  uniqueIndex("event_review_history_event_revision_uidx").on(table.masterEventId, table.revision),
  index("event_review_history_event_time_idx").on(table.masterEventId, table.changedAt),
]);

export const eventExposureAssessments = sqliteTable("event_exposure_assessments", {
  masterEventId: text("master_event_id").primaryKey(),
  eventRevision: text("event_revision").notNull(),
  aoiHash: text("aoi_hash").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  computedAt: text("computed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedBy: text("updated_by").notNull(),
}, (table) => [
  index("event_exposure_assessments_expiry_idx").on(table.expiresAt, table.computedAt),
  index("event_exposure_assessments_status_idx").on(table.status, table.computedAt),
]);

export const osmQueryCache = sqliteTable("osm_query_cache", {
  cacheKey: text("cache_key").primaryKey(),
  queryKind: text("query_kind").notNull(),
  dataProfile: text("data_profile").notNull(),
  payloadJson: text("payload_json").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  osmBaseTimestamp: text("osm_base_timestamp"),
}, (table) => [
  index("osm_query_cache_kind_profile_idx").on(table.queryKind, table.dataProfile, table.fetchedAt),
  index("osm_query_cache_expiry_idx").on(table.expiresAt),
]);

export const missionExecutionReceipts = sqliteTable("mission_execution_receipts", {
  receiptId: text("receipt_id").primaryKey(),
  taskId: text("task_id").notNull(),
  masterEventId: text("master_event_id").notNull(),
  owner: text("owner").notNull(),
  provider: text("provider").notNull(),
  externalTaskId: text("external_task_id").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  taskRevision: integer("task_revision").notNull(),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: text("received_at").notNull(),
  actor: text("actor").notNull(),
  note: text("note").notNull().default(""),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("mission_execution_receipts_task_time_idx").on(table.taskId, table.occurredAt),
  index("mission_execution_receipts_provider_external_idx").on(table.provider, table.externalTaskId),
]);

export const observationProducts = sqliteTable("observation_products", {
  itemId: text("item_id").primaryKey(),
  taskId: text("task_id").notNull(),
  masterEventId: text("master_event_id").notNull(),
  owner: text("owner").notNull(),
  collectionId: text("collection_id").notNull(),
  productLevel: text("product_level").notNull(),
  qualityStatus: text("quality_status").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  geometryJson: text("geometry_json").notNull(),
  bboxJson: text("bbox_json").notNull(),
  stacJson: text("stac_json").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("observation_products_task_time_idx").on(table.taskId, table.acquiredAt),
  index("observation_products_event_time_idx").on(table.masterEventId, table.acquiredAt),
  index("observation_products_owner_quality_idx").on(table.owner, table.qualityStatus),
]);

export const aoiWorkPackages = sqliteTable("aoi_work_packages", {
  packageId: text("package_id").primaryKey(),
  masterEventId: text("master_event_id").notNull(),
  sourceTaskId: text("source_task_id").notNull(),
  owner: text("owner").notNull(),
  title: text("title").notNull(),
  geometryJson: text("geometry_json").notNull(),
  aoiHash: text("aoi_hash").notNull(),
  status: text("status").notNull(),
  assignee: text("assignee").notNull().default(""),
  reviewer: text("reviewer").notNull().default(""),
  priority: integer("priority").notNull(),
  reviewNote: text("review_note").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("aoi_work_packages_task_status_idx").on(table.sourceTaskId, table.status),
  index("aoi_work_packages_owner_status_idx").on(table.owner, table.status),
  index("aoi_work_packages_assignee_status_idx").on(table.assignee, table.status),
]);

export const aoiWorkPackageHistory = sqliteTable("aoi_work_package_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  packageId: text("package_id").notNull(),
  revision: integer("revision").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  payloadJson: text("payload_json").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [
  uniqueIndex("aoi_work_package_history_revision_uidx").on(table.packageId, table.revision),
  index("aoi_work_package_history_time_idx").on(table.packageId, table.changedAt),
]);

export const evaluationBenchmarkCases = sqliteTable("evaluation_benchmark_cases", {
  caseId: text("case_id").primaryKey(),
  title: text("title").notNull(),
  hazard: text("hazard").notNull(),
  objective: text("objective").notNull().default("event_detection"),
  hazardSubtype: text("hazard_subtype"),
  outcome: text("outcome").notNull().default("event"),
  calibrationGroup: text("calibration_group"),
  occurredAt: text("occurred_at").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  locationToleranceKm: real("location_tolerance_km").notNull(),
  eventTimeToleranceHours: real("event_time_tolerance_hours").notNull(),
  acceptedLeadMinutes: integer("accepted_lead_minutes").notNull().default(0),
  detectionDeadlineMinutes: integer("detection_deadline_minutes").notNull(),
  expectedSeverity: text("expected_severity"),
  requiredSource: text("required_source"),
  minimumForecastRiskPercent: real("minimum_forecast_risk_percent"),
  provenanceUrl: text("provenance_url").notNull(),
  notes: text("notes").notNull().default(""),
  verificationStatus: text("verification_status").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("evaluation_cases_hazard_time_idx").on(table.hazard, table.occurredAt),
  index("evaluation_cases_verification_time_idx").on(table.verificationStatus, table.occurredAt),
]);

export const evaluationRuns = sqliteTable("evaluation_runs", {
  runId: text("run_id").primaryKey(),
  modelVersion: text("model_version").notNull(),
  caseCount: integer("case_count").notNull(),
  eligibleCount: integer("eligible_count").notNull(),
  detectedCount: integer("detected_count").notNull(),
  reportJson: text("report_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("evaluation_runs_created_idx").on(table.createdAt)]);

export const lhasaV1GranuleProbes = sqliteTable("lhasa_v1_granule_probes", {
  caseId: text("case_id").primaryKey(),
  productDate: text("product_date").notNull(),
  status: text("status").notNull(),
  collectionConceptId: text("collection_concept_id").notNull(),
  granuleConceptId: text("granule_concept_id"),
  producerGranuleId: text("producer_granule_id"),
  downloadUrl: text("download_url"),
  granuleSizeMb: real("granule_size_mb"),
  timeStart: text("time_start"),
  timeEnd: text("time_end"),
  message: text("message").notNull(),
  checkedAt: text("checked_at").notNull(),
}, (table) => [
  index("lhasa_v1_granule_probes_status_date_idx").on(table.status, table.productDate),
]);

export const forecastRasterProducts = sqliteTable("forecast_raster_products", {
  productId: text("product_id").primaryKey(),
  sourceId: text("source_id").notNull(),
  productTime: text("product_time").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to").notNull(),
  sourceUrl: text("source_url").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  storageBackend: text("storage_backend").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  sourceWidth: integer("source_width").notNull(),
  sourceHeight: integer("source_height").notNull(),
  groupPixels: integer("group_pixels").notNull(),
  gridWidth: integer("grid_width").notNull(),
  gridHeight: integer("grid_height").notNull(),
  summaryJson: text("summary_json").notNull(),
  archivedAt: text("archived_at").notNull(),
}, (table) => [
  uniqueIndex("forecast_raster_products_source_time_uidx").on(table.sourceId, table.productTime),
  index("forecast_raster_products_time_idx").on(table.productTime, table.sourceId),
]);
