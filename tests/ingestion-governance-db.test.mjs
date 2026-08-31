import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stores immutable source payloads and returns the nearest read-only replay snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-ingestion-governance-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const database = await import(new URL("../db/operational.ts", import.meta.url));
    const capturedAt = "2026-08-31T04:00:00.000Z";
    await database.persistIngestionArtifacts({
      refreshId: "refresh-test-1",
      sources: [{
        sourceId: "source-1234abcd", name: "测试官方源", tier: "基础", role: "事件", authorityClass: "official",
        setupUrl: "https://example.test/docs", pollIntervalMinutes: 5, latencySloMinutes: 30,
        updateSemantics: "按事件编号更新", geometrySemantics: "官方事件点", licenseNote: "保留归属",
        state: "online", lastAttemptAt: capturedAt, durationMs: 120, count: 1, message: "在线",
      }],
      fetches: [{
        runId: "run-test-1", refreshId: "refresh-test-1", sourceId: "source-1234abcd",
        requestedUrl: "https://example.test/feed", fetchedAt: capturedAt, durationMs: 100, httpStatus: 200, ok: true,
        payloadSha256: "a".repeat(64), contentType: "application/json", bodyText: "{\"ok\":true}", byteLength: 11,
        storedByteLength: 11, truncated: false, errorMessage: null,
      }],
      snapshot: {
        snapshotId: "snapshot-test-1", refreshId: "refresh-test-1", capturedAt, payloadSha256: "b".repeat(64),
        eventCount: 1, sourceCount: 1, payload: { events: [{ id: "event-1" }], sourceStatus: [{ name: "测试官方源" }], fetchedAt: capturedAt },
      },
    });
    const registry = await database.listSourceRegistry("source-1234abcd");
    assert.equal(registry.sources.length, 1);
    assert.equal(registry.runs.length, 1);
    assert.equal(registry.sources[0].consecutiveFailures, 0);
    const payload = await database.getSourcePayloadPreview("a".repeat(64));
    assert.equal(payload?.bodyText, "{\"ok\":true}");
    const snapshot = await database.getIngestionSnapshot("2026-08-31T04:30:00.000Z");
    assert.equal(snapshot?.snapshotId, "snapshot-test-1");
    assert.deepEqual(snapshot?.payload.events, [{ id: "event-1" }]);
    assert.equal(await database.getIngestionSnapshot("2026-08-31T03:59:59.000Z"), null);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => { if (error?.code !== "EBUSY") throw error; });
  }
});
