import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps operational identity reconciliation bounded as the event archive grows", async () => {
  const source = await readFile(new URL("../db/operational.ts", import.meta.url), "utf8");
  const persistencePath = source.slice(
    source.indexOf("export async function persistCanonicalEvents"),
    source.indexOf("async function pruneOperationalDataIfDue"),
  );

  assert.match(source, /source_event_id IN \(\$\{placeholders\}\)/);
  assert.match(source, /resolveClaimAliases\(db, canonicalEvents\.map/);
  assert.match(source, /AND id > \? ORDER BY id LIMIT \?/);
  assert.doesNotMatch(persistencePath, /SELECT source, source_event_id FROM event_tombstones`\)\.all/);
  assert.doesNotMatch(source, /GROUP BY c\.id, c\.hazard, c\.payload_json/);
});
