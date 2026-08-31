import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExecutionReceiptInput, taskPatchFromExecutionReceipt } from "../lib/mission-execution.ts";
import { buildStacItem, geometryBbox, normalizeObservationProductInput } from "../lib/stac-products.ts";
import { partitionAoiGeometry, transitionAoiWorkPackage } from "../lib/aoi-work-packages.ts";
import { buildExternallySelectedSchedule, runSchedulingComparison, schedulingOpportunityRef } from "../lib/mission-scheduler.ts";

test("normalizes an execution receipt and derives auditable task provenance", () => {
  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  const input = normalizeExecutionReceiptInput({
    taskId: "task-1", provider: "simulation-executor", externalTaskId: "external-1", expectedRevision: 3,
    toStatus: "submitted", occurredAt, payload: { dispatchId: "dispatch-1" },
  });
  const task = taskPatchFromExecutionReceipt({ status: "scheduled", taskId: "task-1" }, input);
  assert.equal(task.status, "submitted");
  assert.equal(task.dispatchId, "dispatch-1");
  assert.equal(task.dispatchAcceptedAt, occurredAt);
  assert.throws(() => taskPatchFromExecutionReceipt({ status: "candidate" }, input), /不允许的任务执行状态转换/);
});

test("builds a STAC 1.0 item with protected mission links", () => {
  const acquiredAt = new Date(Date.now() - 1_000).toISOString();
  const input = normalizeObservationProductInput({
    itemId: "item-1", taskId: "task-1", collectionId: "tianxun-sar", productLevel: "L2", qualityStatus: "passed", acquiredAt,
    geometry: { type: "Polygon", coordinates: [[[120, 30], [121, 30], [121, 31], [120, 31], [120, 30]]] },
    platform: "TY-39", instruments: ["CSAR"], assets: { data: { href: "https://example.test/item-1.tif", type: "image/tiff; application=geotiff" } },
    properties: { "tianxun:task_id": "tampered", cloud_cover: 0 },
  });
  const item = buildStacItem(input, { taskId: "task-1", masterEventId: "event-1" });
  assert.equal(item.stac_version, "1.0.0");
  assert.equal(item.properties["tianxun:task_id"], "task-1");
  assert.deepEqual(geometryBbox(input.geometry), [120, 30, 121, 31]);
  assert.throws(() => normalizeObservationProductInput({ ...input, assets: { data: { href: "http://unsafe.example.test/a.tif" } } }), /只允许 HTTPS/);
});

test("tiles AOI conservatively and enforces independent review", () => {
  const geometry = { type: "Polygon", coordinates: [[[120, 30], [120.4, 30], [120.4, 30.4], [120, 30.4], [120, 30]]] };
  const tiles = partitionAoiGeometry(geometry, { widthKm: 25, heightKm: 25, maximumPackages: 20 });
  assert.ok(tiles.length >= 2 && tiles.length <= 20);
  const now = new Date().toISOString();
  const open = { packageId: "aoi-1", masterEventId: "event-1", sourceTaskId: "task-1", owner: "alice", title: "tile", geometry: tiles[0], aoiHash: "hash", status: "open", assignee: "", reviewer: "", priority: 80, reviewNote: "", revision: 1, createdAt: now, updatedAt: now };
  const claimed = transitionAoiWorkPackage(open, "claim", "alice");
  const submitted = transitionAoiWorkPackage(claimed, "submit", "alice");
  assert.throws(() => transitionAoiWorkPackage(submitted, "approve", "alice"), /不能自审/);
  const approved = transitionAoiWorkPackage(submitted, "approve", "bob");
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewer, "bob");
});

test("revalidates externally selected schedule references and conflicts", () => {
  const makeProblem = (taskId, satelliteId, start, end) => ({
    schemaVersion: "tianxun.planning.problem/v1", problemId: `problem-${taskId}`, generatedAt: new Date().toISOString(),
    task: { taskId, eventId: `event-${taskId}`, masterEventId: `master-${taskId}`, revision: 1, title: taskId, hazard: "flood", priority: 80, requiredRevisits: 1, dynamicTarget: false, requirements: { orbitDirection: "either", referenceAcquisitionRequired: false } },
    horizon: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" },
    opportunities: [{ opportunityId: `opp-${taskId}`, satelliteId, start, end, simulationLevel: "sensor_model", engineeringConstraintsVerified: true, assessment: { decision: "eligible", eligibleForTrialSchedule: true, eligibleForDispatch: true, findings: [] } }],
  });
  const first = makeProblem("one", "TY-39", "2026-09-01T01:00:00.000Z", "2026-09-01T01:10:00.000Z");
  const second = makeProblem("two", "TY-40", "2026-09-01T01:00:00.000Z", "2026-09-01T01:10:00.000Z");
  const refs = [schedulingOpportunityRef(first.problemId, "opp-one"), schedulingOpportunityRef(second.problemId, "opp-two")];
  const schedule = buildExternallySelectedSchedule([first, second], refs);
  assert.equal(schedule.algorithm.id, "external_or_tools_cp_sat_v1");
  assert.equal(schedule.assignments.length, 2);
  assert.throws(() => buildExternallySelectedSchedule([first], ["unknown"]), /未知/);
  assert.equal(runSchedulingComparison([first]).optimized.assignments.length, 1);
});
