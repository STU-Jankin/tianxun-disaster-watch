import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("isolates task reads, updates and cancellation by owner while allowing admin recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-owner-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const { deleteSatelliteTask, getSatelliteTask, listSatelliteTasks, listTaskRevisionHistory, upsertSatelliteTask } = await import(new URL("../db/operational.ts", import.meta.url));
    const now = new Date();
    const task = {
      taskId: `TASK-OWNER-${Date.now()}`,
      eventId: "EV-OWNER",
      masterEventId: "ME-OWNER",
      title: "owned task",
      status: "candidate",
      priority: 70,
      latitude: 31.5,
      longitude: 120.3,
      aoiType: "circle",
      aoiRadiusKm: 10,
      sensors: [],
      imagingStart: new Date(now.getTime() + 3_600_000).toISOString(),
      imagingEnd: new Date(now.getTime() + 7_200_000).toISOString(),
      aoiApproval: "operator_confirmed",
      createdAt: now.toISOString(),
      revision: 0,
    };
    const saved = await upsertSatelliteTask(task, undefined, "alice");
    assert.equal(saved.revision, 1);
    assert.equal((await listSatelliteTasks("alice")).length, 1);
    assert.deepEqual((await listTaskRevisionHistory(task.taskId, "alice")).map((item) => [item.revision, item.actor, item.toStatus]), [[1, "alice", "candidate"]]);
    assert.equal((await listTaskRevisionHistory(task.taskId, "bob")).length, 0);
    assert.equal((await listSatelliteTasks("bob")).length, 0);
    assert.equal(await getSatelliteTask(task.taskId, "bob"), null);
    await assert.rejects(() => deleteSatelliteTask(task.taskId, 1, "bob"), /不属于当前操作员/);
    await assert.rejects(() => upsertSatelliteTask({ ...saved, title: "forged" }, undefined, "bob"), /不属于当前操作员/);
    assert.equal((await deleteSatelliteTask(task.taskId, 1, "admin", "administrative cancellation", true)).state, "cancelled");
    assert.equal((await listSatelliteTasks("alice")).length, 0);
    assert.deepEqual((await listTaskRevisionHistory(task.taskId)).map((item) => [item.revision, item.actor, item.toStatus]), [[1, "alice", "candidate"], [2, "admin", "cancelled"]]);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== "EBUSY") throw error;
    });
  }
});
