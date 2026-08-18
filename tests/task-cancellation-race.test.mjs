import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a cancellation intent prevents a late create from resurrecting a task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-cancel-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const { deleteSatelliteTask, listSatelliteTaskCancellationIds, upsertSatelliteTask } = await import(new URL("../db/operational.ts", import.meta.url));
    const taskId = `TASK-RACE-${Date.now()}`;
    const cancelled = await deleteSatelliteTask(taskId, 0, "test", "cancel-before-create");
    assert.equal(cancelled.state, "cancellation_recorded");
    await assert.rejects(() => upsertSatelliteTask({
      taskId,
      eventId: "EV-1",
      masterEventId: "ME-1",
      title: "race",
      status: "candidate",
      priority: 50,
      latitude: 31.5,
      longitude: 120.3,
      aoiType: "circle",
      aoiRadiusKm: 10,
      sensors: [],
      imagingStart: new Date(Date.now() + 3_600_000).toISOString(),
      imagingEnd: new Date(Date.now() + 7_200_000).toISOString(),
      aoiApproval: "operator_confirmed",
      createdAt: new Date().toISOString(),
      revision: 0,
    }), /任务已取消/);
    assert.ok((await listSatelliteTaskCancellationIds()).includes(taskId));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== "EBUSY") throw error;
      // Windows keeps node:sqlite open until the isolated test process exits.
    });
  }
});
