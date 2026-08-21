import assert from "node:assert/strict";
import test from "node:test";

async function disruptions() {
  return import(new URL("../lib/response-disruptions.ts", import.meta.url));
}

test("normalizes auditable road destruction GeoJSON with validity and affected modes", async () => {
  const { normalizeRoadDisruptionGeoJson } = await disruptions();
  const result = normalizeRoadDisruptionGeoJson({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "bridge-7",
      properties: {
        name: "七号桥冲毁",
        kind: "bridge_failure",
        impact: "blocked",
        verification: "verified",
        affectedModes: ["driving", "walking"],
        radiusMeters: 180,
        validFrom: "2026-08-20T01:00:00Z",
        validTo: "2026-08-21T01:00:00Z",
        source: "无锡交通现场核报",
      },
      geometry: { type: "Point", coordinates: [120.3, 31.5] },
    }],
  }, "2026-08-20T02:00:00Z");
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "bridge_failure");
  assert.equal(result[0].verification, "verified");
  assert.deepEqual(result[0].affectedModes, ["driving", "walking"]);
  assert.equal(result[0].radiusMeters, 180);
});

test("rejects malformed disruption validity instead of silently treating it as current", async () => {
  const { normalizeRoadDisruptionGeoJson } = await disruptions();
  assert.throws(() => normalizeRoadDisruptionGeoJson({
    type: "Feature",
    properties: { validFrom: "not-a-date" },
    geometry: { type: "Point", coordinates: [120.3, 31.5] },
  }), /validFrom 时间无效/);
});

test("matches only active disruptions for the selected travel mode", async () => {
  const { activeRoadDisruptionConflicts, normalizeRoadDisruptionGeoJson } = await disruptions();
  const imported = normalizeRoadDisruptionGeoJson({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "当前步行封闭", kind: "closure", affectedModes: ["walking"], validFrom: "2026-08-20T00:00:00Z", validTo: "2026-08-20T04:00:00Z" }, geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", properties: { name: "过期封闭", kind: "closure", affectedModes: ["walking"], validTo: "2026-08-19T00:00:00Z" }, geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", properties: { name: "仅驾车", kind: "closure", affectedModes: ["driving"] }, geometry: { type: "Point", coordinates: [0, 0] } },
    ],
  });
  const route = [[-0.01, 0], [0.01, 0]];
  const conflicts = activeRoadDisruptionConflicts(route, imported, "walking", "2026-08-20T01:00:00Z", 30);
  assert.deepEqual(conflicts.map((item) => item.label), ["当前步行封闭"]);
});
