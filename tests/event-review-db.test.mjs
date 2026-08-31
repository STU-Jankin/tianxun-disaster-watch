import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists one versioned shared review and an immutable audit history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-event-review-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const database = await import(new URL("../db/operational.ts", import.meta.url));
    const first = await database.saveEventReview({
      masterEventId: "ME-review-test",
      status: "reviewing",
      assignee: "值守一组",
      conclusion: "正在核对来源几何",
      exposure: null,
      vulnerability: null,
      acknowledgeAlert: true,
      alertVersion: "orange|Orange|orange",
      eventRevision: "event-v1",
      expectedRevision: 0,
      actor: "operator-a",
    });
    assert.equal(first.revision, 1);
    assert.equal(first.alertAcknowledgedBy, "operator-a");

    const second = await database.saveEventReview({
      masterEventId: "ME-review-test",
      status: "verified",
      assignee: "值守一组",
      conclusion: "已核对两类独立证据，确认进入持续观测",
      exposure: { index: 75, basis: "人口栅格与关键设施" },
      vulnerability: { index: 55, basis: "分灾种专家曲线" },
      acknowledgeAlert: false,
      alertVersion: "orange|Orange|orange",
      eventRevision: "event-v1",
      expectedRevision: 1,
      actor: "operator-b",
    });
    assert.equal(second.revision, 2);
    assert.equal((await database.getEventReview("ME-review-test"))?.status, "verified");
    const history = await database.listEventReviewHistory("ME-review-test");
    assert.deepEqual(history.map((item) => item.revision), [2, 1]);
    assert.equal(history[0].fromStatus, "reviewing");
    await assert.rejects(() => database.saveEventReview({
      masterEventId: "ME-review-test",
      status: "monitoring",
      assignee: "值守二组",
      conclusion: "",
      exposure: null,
      vulnerability: null,
      acknowledgeAlert: false,
      alertVersion: "orange|Orange|orange",
      eventRevision: "event-v1",
      expectedRevision: 1,
      actor: "operator-c",
    }), /版本冲突/);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => { if (error?.code !== "EBUSY") throw error; });
  }
});
