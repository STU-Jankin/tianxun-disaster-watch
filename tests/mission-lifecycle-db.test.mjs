import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.TIANXUN_SQLITE_PATH = join(await mkdtemp(join(tmpdir(), "tianxun-mission-loop-")), "operational.sqlite");

test("persists the execution, STAC product, and independent AOI review loop", async () => {
  const {
    ensureOperationalSchema, recordMissionExecutionReceipt, listMissionExecutionReceipts,
    upsertObservationProduct, listObservationProducts, createAoiWorkPackagesFromTask,
    transitionStoredAoiWorkPackage, listAoiWorkPackages,
  } = await import(new URL("../db/operational.ts", import.meta.url));
  const { normalizeExecutionReceiptInput } = await import(new URL("../lib/mission-execution.ts", import.meta.url));
  const { normalizeObservationProductInput } = await import(new URL("../lib/stac-products.ts", import.meta.url));
  const { DatabaseSync } = await import("node:sqlite");
  await ensureOperationalSchema();
  const now = new Date(Date.now() - 5_000).toISOString();
  const task = {
    taskId: "mission-loop-task", eventId: "source-event", masterEventId: "master-event", entityKey: "event:flood:test", title: "闭环测试任务", status: "reviewed", revision: 1,
    priority: 88, latitude: 31.5, longitude: 120.3, aoiType: "rectangle", aoiWidthKm: 40, aoiHeightKm: 30, aoiRadiusKm: 0, aoiLengthKm: 0, aoiBearingDeg: 0,
    imagingStart: now, imagingEnd: new Date(Date.now() + 3_600_000).toISOString(), aoiApproval: "operator_confirmed", sensors: ["SAR"], createdAt: now, updatedAt: now,
  };
  const sqlite = new DatabaseSync(process.env.TIANXUN_SQLITE_PATH);
  sqlite.prepare(`INSERT INTO satellite_tasks (task_id,event_id,master_event_id,owner,title,status,priority,latitude,longitude,aoi_type,aoi_json,sensors_json,imaging_start,imaging_end,aoi_approval,payload_json,created_at,updated_at,revision,event_revision,aoi_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(task.taskId, task.eventId, task.masterEventId, "alice", task.title, task.status, task.priority, task.latitude, task.longitude, task.aoiType, "{}", JSON.stringify(task.sensors), task.imagingStart, task.imagingEnd, task.aoiApproval, JSON.stringify(task), now, now, 1, "event-revision", "aoi-hash");
  sqlite.close();

  const packages = await createAoiWorkPackagesFromTask({ taskId: task.taskId, widthKm: 25, heightKm: 25 }, "alice");
  assert.ok(packages.length >= 2);
  const claimed = await transitionStoredAoiWorkPackage(packages[0].packageId, 1, "claim", "alice", "", true);
  const submitted = await transitionStoredAoiWorkPackage(claimed.packageId, 2, "submit", "alice", "", true);
  const approved = await transitionStoredAoiWorkPackage(submitted.packageId, 3, "approve", "bob", "复核边界无误", true);
  assert.equal(approved.status, "approved");
  assert.equal((await listAoiWorkPackages({ taskId: task.taskId })).find((item) => item.packageId === approved.packageId)?.reviewer, "bob");

  const receipt = (toStatus, expectedRevision, payload) => normalizeExecutionReceiptInput({ taskId: task.taskId, provider: "test-executor", externalTaskId: "external-task-1", toStatus, expectedRevision, occurredAt: now, payload });
  await recordMissionExecutionReceipt(receipt("scheduled", 1, { scheduleId: "schedule-1" }), "executor", true);
  await recordMissionExecutionReceipt(receipt("submitted", 2, { dispatchId: "dispatch-1" }), "executor", true);
  await recordMissionExecutionReceipt(receipt("acquired", 3, { acquisitionId: "acquisition-1" }), "executor", true);
  assert.equal((await listMissionExecutionReceipts({ taskId: task.taskId })).length, 3);

  const productInput = normalizeObservationProductInput({
    itemId: "stac-item-1", taskId: task.taskId, collectionId: "tianxun-test", productLevel: "L2", qualityStatus: "passed", acquiredAt: now,
    geometry: { type: "Polygon", coordinates: [[[120, 31], [120.5, 31], [120.5, 31.5], [120, 31.5], [120, 31]]] },
    platform: "TY-39", instruments: ["CSAR"], assets: { data: { href: "https://example.test/stac-item-1.tif" } },
  });
  const product = await upsertObservationProduct(productInput, "executor", true);
  assert.equal(product.stac.stac_version, "1.0.0");
  assert.equal((await listObservationProducts({ taskId: task.taskId }))[0].itemId, "stac-item-1");
});
