import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("returns the persisted master id and safely rebinds an unsynced task by unique entity key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-rebind-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const { getCanonicalEventForTask, persistCanonicalEvents } = await import(new URL("../db/operational.ts", import.meta.url));
    const event = (masterEventId, id, updatedAt) => ({
      id, masterEventId, entityKey: "cyclone:2026:cp:1", hazard: "cyclone", title: "HU Lala", lifecycleStatus: "active",
      severity: "red", geometryType: "Polygon", latitude: 20.6, longitude: -168.7, locationQuality: "precise",
      locationAccuracyKm: 5, confidenceScore: 90, occurredAt: "2026-08-18T03:00:00Z", updatedAt,
      // This test covers canonical identity rebinding, not lifecycle expiry.
      // Keep the synthetic event active so the assertion does not depend on wall-clock date.
      observationExpiresAt: "2099-08-30T00:00:00Z", evidenceCount: 1,
      evidence: [{ source: "NOAA NHC", sourceUrl: "https://example.test/advisory", sourceEventId: "CP012026", observedAt: updatedAt, role: "forecast" }],
    });
    const first = await persistCanonicalEvents([event("ME-original", "nhc-old", "2026-08-18T03:00:00Z")]);
    assert.equal(first?.[0].masterEventId, "ME-original");
    const refreshed = await persistCanonicalEvents([event("ME-new-client-id", "nhc-new", "2026-08-19T03:00:00Z")]);
    assert.equal(refreshed?.[0].masterEventId, "ME-original");
    const collapsed = await persistCanonicalEvents([
      event("ME-another-current-id", "nhc-current", "2026-08-20T03:00:00Z"),
      event("ME-another-stale-id", "nhc-stale", "2026-08-19T06:00:00Z"),
    ]);
    assert.equal(collapsed?.length, 1);
    assert.equal(collapsed?.[0].id, "nhc-current");
    const staleReplay = await persistCanonicalEvents([event("ME-stale-replay", "nhc-stale-replay", "2026-08-19T05:00:00Z")]);
    assert.equal(staleReplay?.length, 1);
    assert.equal(staleReplay?.[0].id, "nhc-current");
    const rebound = await getCanonicalEventForTask("ME-new-client-id", { eventId: "nhc-new", entityKey: "cyclone:2026:cp:1", hazard: "cyclone" });
    assert.equal(rebound?.event.masterEventId, "ME-original");
    assert.equal(rebound?.event.id, "nhc-current");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== "EBUSY") throw error;
    });
  }
});
