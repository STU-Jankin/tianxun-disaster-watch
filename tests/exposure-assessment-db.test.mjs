import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists one current exposure assessment with its event and AOI versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-exposure-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const database = await import(new URL("../db/operational.ts", import.meta.url));
    const assessment = {
      masterEventId: "ME-exposure-test",
      eventRevision: "event-v1",
      aoiHash: "aoi-v1",
      status: "partial",
      aoi: { geometry: { type: "Polygon", coordinates: [[[120, 30], [120.1, 30], [120.1, 30.1], [120, 30.1], [120, 30]]] }, areaKm2: 100, bbox: [120, 30, 120.1, 30.1], basis: "official_event_geometry", label: "来源事件范围", crossesAntimeridian: false },
      population: { state: "ready", provider: "WorldPop", year: 2026, resolution: "100m", totalPopulation: 5000, populationDensityPerKm2: 50, message: "模型估计" },
      osm: { state: "unavailable", provider: "OpenStreetMap · Overpass", facilityCounts: {}, facilities: [], facilitiesTruncated: false, message: "offline" },
      riskInput: { index: 48, basis: "WorldPop 模型估计" },
      computedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-09-07T00:00:00.000Z",
      updatedBy: "operator-a",
      limitations: ["不是损失评估"],
      modelVersion: "tianxun-exposure-screening-v1",
    };
    await database.upsertEventExposureAssessment(assessment);
    assert.deepEqual(await database.getEventExposureAssessment(assessment.masterEventId), assessment);
    await database.upsertEventExposureAssessment({ ...assessment, eventRevision: "event-v2", status: "complete", updatedBy: "operator-b" });
    const updated = await database.getEventExposureAssessment(assessment.masterEventId);
    assert.equal(updated.eventRevision, "event-v2");
    assert.equal(updated.status, "complete");
    assert.equal(updated.updatedBy, "operator-b");

    const osmCache = {
      cacheKey: "china_daily:exposure:aoi-v1",
      queryKind: "exposure",
      dataProfile: "china_daily",
      payload: { state: "ready", mappedBuildingCount: 120 },
      fetchedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-09-01T02:00:00.000Z",
      osmBaseTimestamp: "2026-08-30T20:00:00.000Z",
    };
    assert.equal(await database.upsertOsmQueryCache(osmCache), true);
    assert.deepEqual(await database.getOsmQueryCache(osmCache.cacheKey, "exposure"), osmCache);
    assert.equal(await database.upsertOsmQueryCache({ ...osmCache, cacheKey: "oversized", payload: { encodedIds: "x".repeat(2 * 1024 * 1024) } }), false);
    assert.equal(await database.getOsmQueryCache("oversized", "exposure"), null);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => { if (error?.code !== "EBUSY") throw error; });
  }
});
