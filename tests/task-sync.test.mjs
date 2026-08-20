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

test("task sync retains operator-authored Polygon and MultiPolygon AOIs", () => {
  const customGeometry = { type: "Polygon", coordinates: [[[120, 30], [121, 30], [121, 31], [120, 30]]] };
  const compact = compactSatelliteTaskForSync({ taskId: "task-2", masterEventId: "master-2", aoiType: "polygon", customGeometry });
  assert.deepEqual(compact.customGeometry, customGeometry);
});
