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
  assert.match(csv.body, /orbit_direction_preference,reference_acquisition_required,sar_analysis_mode/);
  assert.match(csv.body, /ascending,true,amplitude_change_and_insar_pair/);
  assert.match(csv.body, /orbit_only,51832,2026-08-20T00:45:00.000Z,84.2,350,ascending/);
});
