import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("task cancellation contract remains versioned, idempotent and payload-consistent", async () => {
  const [dashboard, route, operational] = await Promise.all([
    readFile(new URL("app/dashboard.tsx", root), "utf8"),
    readFile(new URL("app/api/tasks/route.ts", root), "utf8"),
    readFile(new URL("db/operational.ts", root), "utf8"),
  ]);
  assert.match(dashboard, /task\.revision === 0[\s\S]*taskStorageMode === "public-read-only"/);
  assert.match(dashboard, /taskSaveControllers\.current\.get\(taskId\)\?\.abort\(\)/);
  assert.match(dashboard, /revision=\$\{task\.revision\}/);
  assert.doesNotMatch(dashboard, /setTasks\(previous\)/);
  assert.match(route, /\.\.\.result/);
  assert.match(route, /revision 必须是正整数/);
  assert.match(operational, /WHERE task_id = \? AND status = \? AND revision = \?/);
  assert.match(operational, /payload_json = \?, updated_at = \?, revision = \?/);
  assert.match(operational, /task_cancelled:[^`]*revision/);
  assert.match(operational, /state: "already_cancelled"/);
  assert.match(operational, /state: "already_absent"/);
});
