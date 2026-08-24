import assert from "node:assert/strict";
import test from "node:test";

test("builds immutable planning packages with 4D cyclone features and CSV injection protection", async () => {
  const { buildTaskExportArtifact } = await import(new URL("../lib/task-export.ts", import.meta.url));
  const geometry = { type: "Polygon", coordinates: [[[120, 30], [121, 30], [121, 31], [120, 30]]] };
  const task = {
    taskId: "TASK-EXPORT-1",
    masterEventId: "ME-1",
    title: "=FORMULA()",
    hazard: "cyclone",
    status: "reviewed",
    priority: 90,
    latitude: 30.5,
    longitude: 120.5,
    aoiType: "polygon",
    customGeometry: geometry,
    sensors: ["SAR"],
    sarImagingModes: ["spotlight", "tops_1"],
    imagingStart: "2026-08-20T00:00:00.000Z",
    imagingEnd: "2026-08-20T02:00:00.000Z",
    eventRevision: "a".repeat(64),
    aoiHash: "b".repeat(64),
    orbitDirectionPreference: "ascending",
    referenceAcquisitionRequired: true,
    sarAnalysisMode: "amplitude_change_and_insar_pair",
    simulationLevel: "orbit_only",
    satelliteNoradId: 51832,
    closestApproachAt: "2026-08-20T00:45:00.000Z",
    minimumGroundTrackDistanceKm: 84.2,
    orbitSearchRadiusKm: 350,
    opportunityOrbitDirection: "ascending",
    timeIndexedAoi: [{
      validFrom: "2026-08-20T00:00:00.000Z",
      validTo: "2026-08-20T01:00:00.000Z",
      leadHours: 1,
      center: [120.5, 30.5],
      centerBasis: "official_node",
      thresholdKnots: 34,
      windGeometry: geometry,
      uncertaintyGeometry: geometry,
    }],
  };
  const generatedAt = "2026-08-20T00:00:00.000Z";
  const geojson = buildTaskExportArtifact([task], "geojson", "operator-a", generatedAt);
  const parsed = JSON.parse(geojson.body);
  assert.equal(parsed.tianxunManifest.executionAuthority, "planning-export-only");
  assert.equal(parsed.features.length, 3);
  assert.deepEqual(parsed.features.map((feature) => feature.properties.geometryRole), ["planning_aoi", "cyclone_4d_impact", "cyclone_4d_impact"]);
  assert.equal(geojson.snapshotDigest.length, 64);
  assert.equal(buildTaskExportArtifact([task], "geojson", "operator-a", generatedAt).packageId, geojson.packageId);

  const csv = buildTaskExportArtifact([task], "csv", "operator-a", generatedAt);
  assert.match(csv.body, /'=FORMULA\(\)/);
  assert.match(csv.body, /sar_imaging_modes/);
  assert.match(csv.body, /spotlight\|tops_1/);
  assert.match(csv.body, /orbit_direction_preference,reference_acquisition_required,sar_analysis_mode/);
  assert.match(csv.body, /ascending,true,amplitude_change_and_insar_pair/);
  assert.match(csv.body, /orbit_only,51832,2026-08-20T00:45:00.000Z,84.2,350,ascending/);
});

test("exports an assumed-sensor footprint as a separate GeoJSON feature", async () => {
  const { buildTaskExportArtifact } = await import(new URL("../lib/task-export.ts", import.meta.url));
  const aoi = { type: "Polygon", coordinates: [[[120, 30], [120.1, 30], [120.1, 30.1], [120, 30]]] };
  const footprint = { type: "Polygon", coordinates: [[[119.9, 29.9], [120.2, 29.9], [120.2, 30.2], [119.9, 30.2], [119.9, 29.9]]] };
  const task = {
    taskId: "TASK-FOOTPRINT-1", masterEventId: "ME-2", title: "SAR试算", hazard: "flood", status: "reviewed", priority: 80,
    latitude: 30.05, longitude: 120.05, aoiType: "polygon", customGeometry: aoi, sensors: ["SAR"],
    imagingStart: "2026-08-20T00:00:00.000Z", imagingEnd: "2026-08-20T01:00:00.000Z", eventRevision: "c".repeat(64), aoiHash: "d".repeat(64),
    simulationLevel: "assumed_sensor", opportunityLookSide: "left", opportunityCoveragePercent: 100, opportunitySpatialResolutionM: 10,
    opportunitySceneCrossTrackKm: 100, opportunitySceneAlongTrackKm: 100, sensorParameterStatus: "provisional_assumption", opportunityFootprint: footprint,
  };
  const artifact = buildTaskExportArtifact([task], "geojson", "operator-a", "2026-08-20T00:00:00.000Z");
  const parsed = JSON.parse(artifact.body);
  assert.deepEqual(parsed.features.map((feature) => feature.properties.geometryRole), ["planning_aoi", "assumed_sensor_footprint"]);
  assert.deepEqual(parsed.features[1].geometry, footprint);
  assert.equal("opportunityFootprint" in parsed.features[0].properties, false);
});
