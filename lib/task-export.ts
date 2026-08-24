import { aoiFingerprint, stableJson } from "./event-integrity.ts";
import { buildTaskAoi } from "./task-aoi.ts";

export type TaskExportFormat = "json" | "csv" | "geojson";

export function buildTaskExportArtifact(tasks: Record<string, unknown>[], format: TaskExportFormat, actor: string, generatedAt = new Date().toISOString()) {
  const snapshots = tasks.map((task) => ({ ...task, aoi: buildTaskAoi(task) }));
  const snapshotDigest = aoiFingerprint(snapshots);
  const packageId = `TXP-${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${snapshotDigest.slice(0, 12)}`;
  const manifest = {
    schemaVersion: "tianxun.task-package.v2",
    packageId,
    generatedAt,
    generatedBy: actor,
    coordinateReferenceSystem: "EPSG:4326",
    taskCount: snapshots.length,
    snapshotSha256: snapshotDigest,
    executionAuthority: "planning-export-only",
    warning: "该文件是经服务端复核的仿真输入快照，不代表卫星已排程或已下发。",
  };
  let body: string;
  let contentType: string;
  let extension: string;
  if (format === "geojson") {
    body = JSON.stringify({
      type: "FeatureCollection",
      name: packageId,
      tianxunManifest: manifest,
      features: snapshots.flatMap(taskGeoJsonFeatures),
    }, null, 2);
    contentType = "application/geo+json; charset=utf-8";
    extension = "geojson";
  } else if (format === "csv") {
    const rows = snapshots.map((task) => ({
      package_id: packageId,
      task_id: task.taskId,
      master_event_id: task.masterEventId,
      title: task.title,
      hazard: task.hazard,
      priority: task.priority,
      status: task.status,
      latitude_wgs84: task.latitude,
      longitude_wgs84: task.longitude,
      imaging_start_utc: task.imagingStart,
      imaging_end_utc: task.imagingEnd,
      sensors: Array.isArray(task.sensors) ? task.sensors.join("|") : "",
      sar_imaging_modes: Array.isArray(task.sarImagingModes) ? task.sarImagingModes.join("|") : "",
      orbit_direction_preference: task.orbitDirectionPreference,
      reference_acquisition_required: task.referenceAcquisitionRequired,
      sar_analysis_mode: task.sarAnalysisMode,
      simulation_level: task.simulationLevel,
      satellite_norad_id: task.satelliteNoradId,
      closest_approach_utc: task.closestApproachAt,
      minimum_ground_track_distance_km: task.minimumGroundTrackDistanceKm,
      orbit_search_radius_km: task.orbitSearchRadiusKm,
      opportunity_orbit_direction: task.opportunityOrbitDirection,
      opportunity_look_side: task.opportunityLookSide,
      estimated_coverage_percent: task.opportunityCoveragePercent,
      estimated_resolution_m: task.opportunitySpatialResolutionM,
      nominal_scene_cross_track_km: task.opportunitySceneCrossTrackKm,
      nominal_scene_along_track_km: task.opportunitySceneAlongTrackKm,
      sensor_parameter_status: task.sensorParameterStatus,
      event_revision_sha256: task.eventRevision,
      aoi_sha256: task.aoiHash,
      aoi_geojson: stableJson(task.aoi),
      time_indexed_aoi_count: Array.isArray(task.timeIndexedAoi) ? task.timeIndexedAoi.length : 0,
    }));
    const headers = Object.keys(rows[0] ?? {});
    body = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(","))].join("\r\n");
    contentType = "text/csv; charset=utf-8";
    extension = "csv";
  } else {
    body = JSON.stringify({ manifest, tasks: snapshots }, null, 2);
    contentType = "application/json; charset=utf-8";
    extension = "json";
  }
  return { packageId, snapshotDigest, body, contentType, fileName: `${packageId}.${extension}`, generatedAt, taskIds: snapshots.map((task) => String(task.taskId)) };
}

function taskGeoJsonFeatures(task: Record<string, unknown>) {
  const properties = withoutKeys(task, ["aoi", "sourceGeometry", "customGeometry", "timeIndexedAoi", "cycloneForecast", "opportunityFootprint"]);
  const features: Record<string, unknown>[] = [{
    type: "Feature",
    id: task.taskId,
    geometry: task.aoi,
    properties: { ...properties, geometryRole: "planning_aoi" },
  }];
  if (task.opportunityFootprint) features.push({
    type: "Feature",
    id: `${task.taskId}-opportunity-footprint`,
    geometry: task.opportunityFootprint,
    properties: { ...properties, geometryRole: "assumed_sensor_footprint" },
  });
  const slices = Array.isArray(task.timeIndexedAoi) ? task.timeIndexedAoi : [];
  slices.forEach((rawSlice, index) => {
    if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) return;
    const slice = rawSlice as Record<string, unknown>;
    const temporal = {
      taskId: task.taskId,
      geometryRole: "cyclone_4d_impact",
      timeIndex: index,
      validFrom: slice.validFrom,
      validTo: slice.validTo,
      leadHours: slice.leadHours,
      center: slice.center,
      centerBasis: slice.centerBasis,
      thresholdKnots: slice.thresholdKnots,
    };
    if (slice.windGeometry) features.push({ type: "Feature", id: `${task.taskId}-t${index}-wind`, geometry: slice.windGeometry, properties: { ...temporal, field: "wind" } });
    if (slice.uncertaintyGeometry) features.push({ type: "Feature", id: `${task.taskId}-t${index}-uncertainty`, geometry: slice.uncertaintyGeometry, properties: { ...temporal, field: "uncertainty" } });
  });
  return features;
}

function withoutKeys(value: Record<string, unknown>, keys: string[]) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function csvCell(value: unknown) {
  const raw = value == null ? "" : String(value);
  const safe = /^[=+@]/.test(raw) || /^-\D/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
