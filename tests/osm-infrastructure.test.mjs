import assert from "node:assert/strict";
import test from "node:test";

async function infrastructure() {
  return import(new URL("../lib/osm-infrastructure.ts", import.meta.url));
}

test("builds a bounded, anonymous Overpass query for local route infrastructure", async () => {
  const { prepareInfrastructureQuery } = await infrastructure();
  const plan = prepareInfrastructureQuery([{ routeId: "route-1", coordinates: [[120.25, 31.5], [120.31, 31.52]] }]);
  assert.equal(plan.state, "ready");
  assert.ok(plan.areaKm2 < 3_500);
  assert.match(plan.query, /\[out:json\]\[timeout:12\]/);
  assert.match(plan.query, /\["bridge"\]\["bridge"!="no"\]/);
  assert.match(plan.query, /node\["highway"="ford"\]/);
  assert.match(plan.query, /out tags geom qt 500/);
  assert.doesNotMatch(plan.query, /man_made/);
  assert.doesNotMatch(plan.query, /user|uid|meta/);
});

test("refuses a heavy public Overpass request for a wide route envelope", async () => {
  const { prepareInfrastructureQuery } = await infrastructure();
  const plan = prepareInfrastructureQuery([{ routeId: "wide", coordinates: [[119, 30], [121, 32]] }]);
  assert.equal(plan.state, "too_large");
  assert.ok(plan.queryAreaKm2 > 3_500);
  assert.match(plan.message, /未向公共 Overpass|超过公共 Overpass/);
});

test("allows a wider route only when a separately configured service raises the limit", async () => {
  const { prepareInfrastructureQuery } = await infrastructure();
  const plan = prepareInfrastructureQuery([{ routeId: "wide", coordinates: [[119, 30], [121, 32]] }], {
    maximumAreaKm2: 60_000,
    serviceLabel: "中国 OSM 日更镜像",
    queryTimeoutSeconds: 45,
  });
  assert.equal(plan.state, "ready");
  assert.match(plan.query, /\[timeout:45\]/);
});

test("parses only bridge, tunnel and ford inventory without claiming safety", async () => {
  const { parseOverpassBaseTimestamp, parseOverpassInfrastructure } = await infrastructure();
  assert.equal(parseOverpassBaseTimestamp({ osm3s: { timestamp_osm_base: "2026-08-31T00:00:00Z" } }), "2026-08-31T00:00:00Z");
  const features = parseOverpassInfrastructure({ elements: [
    { type: "way", id: 10, tags: { highway: "primary", bridge: "yes", name: "太湖测试桥", maxweight: "20" }, geometry: [{ lon: 120.25, lat: 31.5 }, { lon: 120.26, lat: 31.5 }] },
    { type: "way", id: 11, tags: { highway: "primary", bridge: "no" }, geometry: [{ lon: 120.25, lat: 31.5 }, { lon: 120.26, lat: 31.5 }] },
    { type: "way", id: 12, tags: { highway: "secondary", tunnel: "yes", name: "测试隧道" }, geometry: [{ lon: 120.28, lat: 31.51 }, { lon: 120.29, lat: 31.51 }] },
    { type: "node", id: 13, tags: { highway: "ford", name: "测试涉水点" }, lon: 120.3, lat: 31.52 },
    { type: "node", id: 14, tags: { amenity: "hospital" }, lon: 120.3, lat: 31.52 },
  ] });
  assert.equal(features.length, 3);
  assert.deepEqual(new Set(features.map((feature) => feature.kind)), new Set(["bridge", "tunnel", "ford"]));
  assert.equal(features.find((feature) => feature.osmId === 10).maxweight, "20");
  assert.equal(features.find((feature) => feature.osmId === 10).attribution, "© OpenStreetMap contributors · ODbL");
  assert.equal(features.find((feature) => feature.osmId === 10).sourceUrl, "https://www.openstreetmap.org/way/10");
});

test("matches route crossings with a bounded tolerance and keeps provenance", async () => {
  const { assessInfrastructureRoutes, parseOverpassInfrastructure, prepareInfrastructureQuery } = await infrastructure();
  const plan = prepareInfrastructureQuery([{ routeId: "route-1", mode: "driving", coordinates: [[120.25, 31.5], [120.31, 31.5]] }]);
  assert.equal(plan.state, "ready");
  const features = parseOverpassInfrastructure({ elements: [
    { type: "way", id: 20, tags: { highway: "primary", bridge: "yes", name: "同向相交桥" }, geometry: [{ lon: 120.27, lat: 31.5002 }, { lon: 120.28, lat: 31.5002 }] },
    { type: "way", id: 22, tags: { highway: "footway", bridge: "yes", name: "邻近人行桥" }, geometry: [{ lon: 120.27, lat: 31.5001 }, { lon: 120.28, lat: 31.5001 }] },
    { type: "way", id: 23, tags: { highway: "primary", bridge: "yes", name: "垂直跨线桥" }, geometry: [{ lon: 120.275, lat: 31.4995 }, { lon: 120.275, lat: 31.5005 }] },
    { type: "node", id: 21, tags: { highway: "ford", name: "远处涉水点" }, lon: 120.3, lat: 31.52 },
  ] });
  const assessment = assessInfrastructureRoutes(plan, features, "2026-08-20T00:00:00Z");
  assert.equal(assessment.state, "ready");
  assert.equal(assessment.crossingsByRoute["route-1"].length, 1);
  assert.equal(assessment.crossingsByRoute["route-1"][0].osmId, 20);
  assert.match(assessment.note, /不代表设施当前完好/);
  assert.equal(assessment.sourceUrl, "https://www.openstreetmap.org/copyright");
});

test("rejects duplicate route identifiers and excessive coordinate counts", async () => {
  const { prepareInfrastructureQuery } = await infrastructure();
  assert.throws(() => prepareInfrastructureQuery([
    { routeId: "same", coordinates: [[120, 31], [120.01, 31.01]] },
    { routeId: "same", coordinates: [[120, 31], [120.02, 31.02]] },
  ]), /重复/);
  assert.throws(() => prepareInfrastructureQuery([{ routeId: "huge", coordinates: Array.from({ length: 2_001 }, (_, index) => [120 + index / 100_000, 31]) }]), /点数无效/);
});
