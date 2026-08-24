import assert from "node:assert/strict";
import test from "node:test";
import { changesVisibleToViewer } from "../lib/operational-change-visibility.ts";

test("viewer change stream strips operator-only task metadata", () => {
  const [change] = changesVisibleToViewer([{
    id: "change-1",
    type: "task_cancelled",
    masterEventId: "master-1",
    createdAt: "2026-08-24T00:00:00Z",
    payload: { taskId: "task-1", status: "cancelled", revision: 4, reason: "event resolved", owner: "operator@example", payloadJson: "secret-draft" },
  }]);
  assert.deepEqual(change.payload, { taskId: "task-1", status: "cancelled", revision: 4, reason: "event resolved" });
});
