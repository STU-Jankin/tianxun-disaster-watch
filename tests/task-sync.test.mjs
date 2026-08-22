import assert from "node:assert/strict";
import test from "node:test";
import { compactSatelliteTaskForSync } from "../lib/task-sync.ts";

test("task sync omits canonical cyclone products and source geometry", () => {
  const repeatedGeometry = { type: "MultiPolygon", coordinates: Array.from({ length: 120 }, (_, index) => [[[[100 + index / 1000, 20], [100.1, 20], [100.1, 20.1], [100 + index / 1000, 20]]]]) };
  const task = {
    taskId: "task-1", eventId: "event-1", masterEventId: "master-1", entityKey: "cyclone:2026:cp:1", hazard: "cyclone", aoiType: "source", revision: 2, eventRevision: "0123456789abcdef",
    imagingStart: "2026-08-20T00:00:00Z", imagingEnd: "2026-08-20T06:00:00Z", status: "candidate",
    createdAt: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T01:00:00Z", sensors: ["SAR"], observationTargets: ["积水边界"],
    sourceGeometry: repeatedGeometry,
    cycloneForecast: { impactField: { frames: Array.from({ length: 361 }, () => repeatedGeometry) } },
    timeIndexedAoi: Array.from({ length: 361 }, () => ({ windGeometry: repeatedGeometry })),
    forecastAdvisoryId: "canonical", forecastIssuedAt: "canonical", forecastValidUntil: "canonical", aoiHash: "canonical",
  };
  const compact = compactSatelliteTaskForSync(task);
  assert.equal(compact.taskId, "task-1");
  assert.equal(compact.revision, 2);
  assert.equal(compact.entityKey, "cyclone:2026:cp:1");
  for (const field of ["sourceGeometry", "cycloneForecast", "timeIndexedAoi", "forecastAdvisoryId", "forecastIssuedAt", "forecastValidUntil", "aoiHash"]) assert.equal(field in compact, false);
  assert.ok(JSON.stringify(compact).length < 2_000);
});

test("task sync retains operator-authored AOI and bounded orbit-screening provenance", () => {
  const customGeometry = { type: "Polygon", coordinates: [[[120, 30], [121, 30], [121, 31], [120, 30]]] };
  const compact = compactSatelliteTaskForSync({ taskId: "task-2", masterEventId: "master-2", aoiType: "polygon", customGeometry, orbitDirectionPreference: "ascending", referenceAcquisitionRequired: true, sarAnalysisMode: "amplitude_change_and_insar_pair", simulationLevel: "orbit_only", satelliteNoradId: 51832, minimumGroundTrackDistanceKm: 72.5, orbitSearchRadiusKm: 350 });
  assert.deepEqual(compact.customGeometry, customGeometry);
  assert.equal(compact.orbitDirectionPreference, "ascending");
  assert.equal(compact.referenceAcquisitionRequired, true);
  assert.equal(compact.sarAnalysisMode, "amplitude_change_and_insar_pair");
  assert.equal(compact.simulationLevel, "orbit_only");
  assert.equal(compact.satelliteNoradId, 51832);
  assert.equal(compact.minimumGroundTrackDistanceKm, 72.5);
});

test("task sync retains a bounded assumed-sensor footprint for map review", () => {
  const footprint = { type: "Polygon", coordinates: [[[120, 30], [120.2, 30], [120.2, 30.2], [120, 30.2], [120, 30]]] };
  const compact = compactSatelliteTaskForSync({
    taskId: "task-3",
    simulationLevel: "assumed_sensor",
    opportunityLookSide: "right",
    opportunityCoveragePercent: 96.5,
    opportunitySpatialResolutionM: 3,
    opportunitySceneCrossTrackKm: 25,
    opportunitySceneAlongTrackKm: 25,
    sensorParameterStatus: "provisional_assumption",
    opportunityFootprint: footprint,
  });
  assert.deepEqual(compact.opportunityFootprint, footprint);
  assert.equal(compact.opportunityLookSide, "right");
  assert.equal(compact.opportunityCoveragePercent, 96.5);
  assert.equal(compact.opportunitySceneCrossTrackKm, 25);
});
