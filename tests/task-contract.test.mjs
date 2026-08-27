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
    latitude: 31.5, longitude: 120.3, aoiType: "source", sourceGeometry: { type: "Polygon", coordinates: [[[120.2, 31.4], [120.4, 31.4], [120.4, 31.6], [120.2, 31.4]]] }, aoiRadiusKm: 20, aoiWidthKm: 40, aoiHeightKm: 40,
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
  assert.deepEqual(validateSatelliteTask(task, { requireApproved: true, requirePayload: true }), { ok: true });
  task.sensors = [];
  assert.equal(validateSatelliteTask(task, { requireApproved: true }).ok, true, "candidate drafts may be persisted before payload selection");
  assert.equal(validateSatelliteTask(task, { requireApproved: true, requirePayload: true }).ok, false);
  task.status = "reviewed";
  assert.equal(validateSatelliteTask(task).ok, false, "reviewed tasks always require a payload");
});

test("persists an unapproved candidate draft but blocks calculation and reviewed status", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.aoiApproval = "review_required";
  task.aoiType = "circle";
  assert.equal(validateSatelliteTask(task).ok, true, "candidate drafts may be saved before AOI review");
  assert.match(validateSatelliteTask(task, { requireApproved: true }).errors.join(" "), /尚未通过 AOI 审批/);
  task.status = "reviewed";
  assert.equal(validateSatelliteTask(task).ok, false, "reviewed tasks must have an explicit AOI approval");
});

test("validates the operator-selected SAR imaging modes independently of optical payloads", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.sarImagingModes = ["spotlight", "tops_1"];
  assert.equal(validateSatelliteTask(task).ok, true);
  task.sarImagingModes = ["spotlight", "spotlight"];
  assert.equal(validateSatelliteTask(task).ok, false);
  task.sarImagingModes = ["unknown"];
  assert.equal(validateSatelliteTask(task).ok, false);
  task.sarImagingModes = [];
  assert.equal(validateSatelliteTask(task).ok, false);
  task.sensors = ["光学"];
  assert.equal(validateSatelliteTask(task).ok, true);
  task.sarImagingModes = ["stripmap"];
  assert.equal(validateSatelliteTask(task).ok, false);
});

test("accepts bounded custom Polygon and MultiPolygon AOIs", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.aoiApproval = "operator_confirmed";
  task.approvalReason = "操作员在地图核对并绘制灾害边界";
  task.aoiType = "polygon";
  task.customGeometry = { type: "Polygon", coordinates: [[[120, 31], [121, 31], [121, 32], [120, 31]]] };
  assert.equal(validateSatelliteTask(task).ok, true);
  task.aoiType = "multi";
  assert.equal(validateSatelliteTask(task).ok, false);
  task.customGeometry = { type: "MultiPolygon", coordinates: [[[[120, 31], [121, 31], [121, 32], [120, 31]]], [[[122, 31], [123, 31], [123, 32], [122, 31]]]] };
  assert.equal(validateSatelliteTask(task).ok, true);
});

test("source-verified AOI cannot be replaced with operator geometry", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.aoiType = "circle";
  assert.equal(validateSatelliteTask(task, { requireApproved: true }).ok, false);
  task.aoiApproval = "operator_confirmed";
  task.approvalReason = "值班员依据洪水范围图扩大观测区";
  assert.equal(validateSatelliteTask(task, { requireApproved: true }).ok, true);
});

test("accepts bounded official cyclone forecasts and rejects malformed forecast coordinates", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.cycloneForecast = {
    official: true,
    source: "JMA",
    sourceUrl: "https://www.jma.go.jp/bosai/typhoon/",
    issuedAt: "2026-08-14T00:00:00Z",
    forecastValidUntil: "2026-08-15T00:00:00Z",
    track: [
      { forecastAt: "2026-08-14T00:00:00Z", latitude: 20, longitude: 130, leadHours: 0 },
      { forecastAt: "2026-08-15T00:00:00Z", latitude: 21, longitude: 132, leadHours: 24 },
    ],
    trackGeometry: { type: "LineString", coordinates: [[130, 20], [132, 21]] },
    impactBasis: "uncertainty_only",
    note: "test",
  };
  assert.equal(validateSatelliteTask(task).ok, true);
  task.cycloneForecast.track[1].longitude = 999;
  assert.equal(validateSatelliteTask(task).ok, false);
});

test("requires a selected cyclone opportunity to match its canonical hourly forecast slice", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.hazard = "cyclone";
  task.cycloneTrackingTarget = "center";
  task.opportunityId = "ASSUMED-TRACKING";
  task.closestApproachAt = new Date(Date.parse(task.imagingStart) + 1_800_000).toISOString();
  task.timeIndexedAoi = [{
    validFrom: task.imagingStart,
    validTo: task.imagingEnd,
    leadHours: 12,
    center: [130, 20],
    centerBasis: "official_node",
    windGeometry: { type: "Polygon", coordinates: [[[129.9, 19.9], [130.1, 19.9], [130, 20.1], [129.9, 19.9]]] },
  }];
  assert.match(validateSatelliteTask(task).errors.join(" "), /未绑定逐时预测片/);
  Object.assign(task, {
    trackingValidFrom: task.imagingStart,
    trackingValidTo: task.imagingEnd,
    trackingLeadHours: 12,
    trackingCenterLatitude: 20,
    trackingCenterLongitude: 130,
    trackingCenterBasis: "official_node",
  });
  assert.equal(validateSatelliteTask(task).ok, true);
  task.trackingCenterLongitude = 131;
  assert.match(validateSatelliteTask(task).errors.join(" "), /不匹配/);
});

test("enforces auditable task state transitions", async () => {
  const { canTransitionTask } = await contract();
  assert.equal(canTransitionTask(null, "candidate"), true);
  assert.equal(canTransitionTask("candidate", "submitted"), false);
  assert.equal(canTransitionTask("candidate", "reviewed"), true);
  assert.equal(canTransitionTask("submitted", "acquired"), true);
  assert.equal(canTransitionTask("completed", "candidate"), false);
});

test("rejects self-intersecting and world-scale AOIs", async () => {
  const { validateSatelliteTask } = await contract();
  const task = validTask();
  task.aoiApproval = "operator_confirmed";
  task.approvalReason = "人工绘制";
  task.aoiType = "polygon";
  task.customGeometry = { type: "Polygon", coordinates: [[[120, 30], [122, 32], [120, 32], [122, 30], [120, 30]]] };
  assert.equal(validateSatelliteTask(task).ok, false);
  task.customGeometry = { type: "Polygon", coordinates: [[[-170, -70], [170, -70], [170, 70], [-170, 70], [-170, -70]]] };
  assert.equal(validateSatelliteTask(task).ok, false);
});

test("accepts bounded landslide SAR planning fields and rejects contradictory payloads", async () => {
  const { unknownTaskFields, validateSatelliteTask } = await contract();
  const task = validTask();
  task.orbitDirectionPreference = "ascending";
  task.referenceAcquisitionRequired = true;
  task.sarAnalysisMode = "amplitude_change_and_insar_pair";
  assert.deepEqual(unknownTaskFields(task), []);
  assert.equal(validateSatelliteTask(task).ok, true);
  task.orbitDirectionPreference = "polar";
  assert.equal(validateSatelliteTask(task).ok, false);
  task.orbitDirectionPreference = "descending";
  task.sensors = ["高分辨率光学"];
  assert.equal(validateSatelliteTask(task).ok, false);
});

test("accepts bounded orbit-only provenance but forbids direct execution", async () => {
  const { unknownTaskFields, validateSatelliteTask } = await contract();
  const task = validTask();
  Object.assign(task, {
    simulationLevel: "orbit_only",
    satelliteNoradId: 51832,
    closestApproachAt: new Date(Date.now() + 4_000_000).toISOString(),
    closestSubpointLatitude: 31.2,
    closestSubpointLongitude: 120.1,
    minimumGroundTrackDistanceKm: 82.4,
    orbitSearchRadiusKm: 350,
    opportunityOrbitDirection: "ascending",
  });
  assert.deepEqual(unknownTaskFields(task), []);
  assert.equal(validateSatelliteTask(task).ok, true);
  task.status = "scheduled";
  assert.equal(validateSatelliteTask(task).ok, false);
  task.status = "candidate";
  task.orbitSearchRadiusKm = 5_000;
  assert.equal(validateSatelliteTask(task).ok, false);
});

test("allows assumed sensor trials for review but forbids scheduling them", async () => {
  const { unknownTaskFields, validateSatelliteTask } = await contract();
  const task = validTask();
  task.simulationLevel = "assumed_sensor";
  task.opportunityLookSide = "right";
  task.opportunityCoveragePercent = 100;
  task.opportunitySpatialResolutionM = 3;
  task.opportunitySceneCrossTrackKm = 25;
  task.opportunitySceneAlongTrackKm = 25;
  task.sensorParameterStatus = "provisional_assumption";
  task.opportunityFootprint = { type: "Polygon", coordinates: [[[120, 30], [120.2, 30], [120.2, 30.2], [120, 30.2], [120, 30]]] };
  assert.deepEqual(unknownTaskFields(task), []);
  assert.equal(validateSatelliteTask(task).ok, true);
  task.status = "reviewed";
  assert.equal(validateSatelliteTask(task).ok, true);
  task.status = "scheduled";
  assert.equal(validateSatelliteTask(task).ok, false);
  assert.match(validateSatelliteTask(task).errors.join(" "), /不得直接排程或下发/);
  task.status = "candidate";
  task.opportunityId = "ASSUMED-51832-20260820000000-STRIPMAP";
  task.instrumentId = "ty-csar-v2";
  task.orbitVersion = "celestrak:51832:2026-08-20T00:00:00.000Z:payload:ty-csar-v2";
  assert.equal(validateSatelliteTask(task).ok, true);
  task.orbitVersion = "celestrak:51832:2026-08-20T00:00:00.000Z";
  assert.equal(validateSatelliteTask(task).ok, false);
  assert.match(validateSatelliteTask(task).errors.join(" "), /载荷参数版本缺失或不匹配/);
  task.orbitVersion = "celestrak:51832:2026-08-20T00:00:00.000Z:payload:ty-csar-v2";
  task.opportunityFootprint = { type: "Polygon", coordinates: [[[120, 30], [121, 31]]] };
  assert.equal(validateSatelliteTask(task).ok, false);
});
