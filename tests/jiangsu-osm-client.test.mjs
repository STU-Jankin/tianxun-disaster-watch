import assert from "node:assert/strict";
import test from "node:test";
import { isJiangsuOsmCandidate, parseJiangsuOsmExposure, resolveJiangsuOsmRuntimeConfig } from "../lib/jiangsu-osm.ts";

test("requires a complete and secure Jiangsu OSM endpoint configuration", () => {
  assert.equal(resolveJiangsuOsmRuntimeConfig({}), null);
  assert.throws(() => resolveJiangsuOsmRuntimeConfig({ JIANGSU_OSM_API_URL: "https://example.com/v1/exposure" }), /同时配置/);
  const config = resolveJiangsuOsmRuntimeConfig({ JIANGSU_OSM_API_URL: "http://127.0.0.1:8791/v1/exposure", JIANGSU_OSM_API_TOKEN: "secret", JIANGSU_OSM_ALLOW_PRIVATE_ENDPOINT: "true" });
  assert.equal(config?.endpoint.toString(), "http://127.0.0.1:8791/v1/exposure");
});

test("selects Jiangsu AOIs and validates aggregate exposure responses", () => {
  assert.equal(isJiangsuOsmCandidate({ type: "Polygon", coordinates: [[[120.2, 31.4], [120.4, 31.4], [120.4, 31.6], [120.2, 31.4]]] }), true);
  const parsed = parseJiangsuOsmExposure({
    supported: true,
    sourceTimestamp: "2026-08-31T20:21:06Z",
    generatedAt: "2026-09-01T01:00:00Z",
    gridSizeDegrees: 0.01,
    mappedBuildingCount: 20,
    mappedRoadWayCount: 5,
    mappedKeyFacilityCount: 1,
    facilityCounts: { health: 1 },
    facilities: [{ id: "node:1", kind: "health", name: "医院", latitude: 31.5, longitude: 120.3, osmType: "node", osmId: 1 }],
  });
  assert.equal(parsed.supported, true);
  if (parsed.supported) {
    assert.equal(parsed.mappedBuildingCount, 20);
    assert.equal(parsed.facilities[0].name, "医院");
  }
});
