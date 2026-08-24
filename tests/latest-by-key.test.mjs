import assert from "node:assert/strict";
import test from "node:test";
import { latestByKey } from "../lib/latest-by-key.ts";

test("latestByKey keeps the newest snapshot instead of the last sorted overwrite", () => {
  const records = [
    { key: "same", at: "2026-08-24T02:00:00Z", value: "newest" },
    { key: "same", at: "2026-08-24T01:00:00Z", value: "older" },
    { key: "other", at: "2026-08-24T01:30:00Z", value: "middle" },
  ];
  const result = latestByKey(records, (item) => item.key, (item) => Date.parse(item.at));
  assert.deepEqual(result.map((item) => item.value), ["newest", "middle"]);
});

test("latestByKey does not let a malformed timestamp replace a valid snapshot", () => {
  const result = latestByKey([
    { key: "same", at: "2026-08-24T02:00:00Z", value: "valid" },
    { key: "same", at: "not-a-date", value: "malformed" },
  ], (item) => item.key, (item) => Date.parse(item.at));
  assert.equal(result[0].value, "valid");
});
