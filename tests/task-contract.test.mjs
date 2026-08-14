import assert from "node:assert/strict";
import test from "node:test";

async function contract() {
  return import(new URL("../lib/task-contract.ts", import.meta.url));
}

function validTask() {
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const end = new Date(Date.now() + 7_200_000).toISOString();
  return {
    taskId: "TASK-1", eventId: "EV-1", masterEventId: "ME-1", title: "test", status: "candidate", priority: 80,
    latitude: 31.5, longitude: 120.3, aoiType: "circle", aoiRadiusKm: 20, aoiWidthKm: 40, aoiHeightKm: 40,
    aoiLengthKm: 60, aoiBearingDeg: 0, imagingStart: start, imagingEnd: end, deliveryDeadline: new Date(Date.now() + 10_800_000).toISOString(),
    sensors: ["SAR"], observationTargets: ["淹没范围"], aoiApproval: "source_verified", source: "USGS", createdAt: new Date().toISOString(),
    minimumCoveragePercent: 80, maximumCloudPercent: 30, spatialResolutionMeters: 10, incidenceAngleMinDeg: 20, incidenceAngleMaxDeg: 45, revisitCount: 1,
  };
}

test("rejects impossible task coordinates and time windows", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.latitude = 999;
  task.longitude = 999;
  task.imagingStart = "bad";
  task.imagingEnd = "bad";
  const result = validateSatelliteTask(task);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /纬度|经度|成像时间/);
});

test("requires payload for visibility/export and accepts a complete task", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  assert.deepEqual(validateSatelliteTask(task, { requireApproved: true }), { ok: true });
  task.sensors = [];
  assert.equal(validateSatelliteTask(task, { requireApproved: true }).ok, false);
});

test("enforces auditable task state transitions", async () => {
  const { canTransitionTask } = await contract();
  assert.equal(canTransitionTask(null, "candidate"), true);
  assert.equal(canTransitionTask("candidate", "submitted"), false);
  assert.equal(canTransitionTask("candidate", "reviewed"), true);
  assert.equal(canTransitionTask("submitted", "acquired"), true);
  assert.equal(canTransitionTask("completed", "candidate"), false);
});
