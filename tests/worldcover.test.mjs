import assert from "node:assert/strict";
import test from "node:test";

import {
  ESA_WORLDCOVER_SOURCE,
  summarizeWorldCover,
  worldCoverClassLabel,
  worldCoverTileId,
  worldCoverTileUrl,
} from "../lib/worldcover.ts";

test("maps WGS84 coordinates to public 3-degree WorldCover COG tiles", () => {
  assert.equal(worldCoverTileId(108.4, 30.8), "N30E108");
  assert.equal(worldCoverTileId(119.72, 31.2), "N30E117");
  assert.equal(worldCoverTileId(-0.1, -0.1), "S03W003");
  assert.match(worldCoverTileUrl("N30E108"), /ESA_WorldCover_10m_2021_v200_N30E108_Map\.tif$/);
  assert.throws(() => worldCoverTileUrl("../../secret"), /编号无效/);
});

test("summarizes static land cover without turning it into a hazard multiplier", () => {
  const samples = [10, 10, 40, 50, 80].map((classCode, index) => ({
    id: `p-${index}`,
    longitude: 108.4,
    latitude: 30.8,
    classCode,
    classLabel: worldCoverClassLabel(classCode),
    tileId: "N30E108",
  }));
  const profile = summarizeWorldCover(samples, "2026-09-02T00:00:00.000Z");
  assert.equal(profile.provider, ESA_WORLDCOVER_SOURCE);
  assert.equal(profile.dominantClassLabel, "树木覆盖");
  assert.equal(profile.engineeredOrExposedPercent, 40);
  assert.equal(profile.nonSlopeSurfacePercent, 20);
  assert.match(profile.interpretation, /不直接提高或降低/);
});
