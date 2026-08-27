import assert from "node:assert/strict";
import test from "node:test";
import { mergeTaskVersions, sameOperatorTaskContent } from "../lib/task-version-conflict.ts";

test("automatically merges disjoint local and remote task edits", () => {
  const base = { taskId: "task-1", revision: 1, updatedAt: "base", eventRevision: "event-1", aoiHash: "aoi-1", imagingStart: "10:00", revisitCount: 1 };
  const local = { ...base, imagingStart: "11:00" };
  const remote = { ...base, revision: 2, updatedAt: "remote", revisitCount: 2 };
  const result = mergeTaskVersions(base, local, remote);
  assert.deepEqual(result.conflictingFields, []);
  assert.equal(result.merged.imagingStart, "11:00");
  assert.equal(result.merged.revisitCount, 2);
  assert.equal(result.merged.revision, 2);
  assert.equal(result.merged.updatedAt, "remote");
});

test("retains the current tab value but flags a same-field conflict", () => {
  const base = { taskId: "task-1", revision: 1, incidenceAngleMinDeg: 15 };
  const local = { ...base, incidenceAngleMinDeg: 20 };
  const remote = { ...base, revision: 2, incidenceAngleMinDeg: 25 };
  const result = mergeTaskVersions(base, local, remote);
  assert.deepEqual(result.conflictingFields, ["incidenceAngleMinDeg"]);
  assert.equal(result.merged.incidenceAngleMinDeg, 20);
  assert.equal(result.merged.revision, 2);
});

test("an unbased stale draft is never silently auto-merged", () => {
  const local = { taskId: "task-1", revision: 1, imagingEnd: "12:00" };
  const remote = { taskId: "task-1", revision: 3, imagingEnd: "13:00" };
  const result = mergeTaskVersions(undefined, local, remote);
  assert.equal(result.hasCommonBase, false);
  assert.deepEqual(result.conflictingFields, ["imagingEnd"]);
  assert.equal(result.merged.imagingEnd, "12:00");
  assert.equal(result.merged.revision, 3);
});

test("recognizes the server result of an aborted write while ignoring managed fields", () => {
  const submitted = { taskId: "task-1", revision: 1, updatedAt: "local", eventRevision: "event-1", imagingStart: "11:00" };
  const persisted = { ...submitted, revision: 2, updatedAt: "server" };
  assert.equal(sameOperatorTaskContent(submitted, persisted), true);
  assert.equal(sameOperatorTaskContent(submitted, { ...persisted, imagingStart: "12:00" }), false);
});
