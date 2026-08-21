import assert from "node:assert/strict";
import test from "node:test";

async function routing() {
  return import(new URL("../lib/response-routing.ts", import.meta.url));
}

function event(overrides = {}) {
  return {
    id: "event-1",
    masterEventId: "master-1",
    title: "测试洪水",
    hazard: "flood",
    latitude: 0,
    longitude: 0,
    updatedAt: "2026-08-20T00:00:00Z",
    geometry: { type: "Polygon", coordinates: [[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]]] },
    locationAccuracyKm: 1,
    dispatchEligibility: "ready",
    ...overrides,
  };
}

test("hard-blocks a route that enters a hazard after starting outside", async () => {
  const { planResponseScenario } = await routing();
  const scenario = planResponseScenario(event(), {
    eventRevision: "a".repeat(64),
    origin: [-0.3, 0],
    destination: [0.3, 0],
    departureAt: "2026-08-20T01:00:00Z",
  });
  const direct = scenario.routes.find((route) => route.label === "最短几何路径");
  assert.equal(direct.status, "blocked");
  assert.ok(direct.exposureKm > 0);
  assert.match(direct.note, /禁止作为可用路线/);
});

test("labels a monotonic exit from an affected origin as limited, never safe", async () => {
  const { planResponseScenario } = await routing();
  const scenario = planResponseScenario(event(), {
    eventRevision: "b".repeat(64),
    origin: [0, 0],
    destination: [0.3, 0],
    departureAt: "2026-08-20T01:00:00Z",
  });
  const direct = scenario.routes.find((route) => route.label === "最短几何路径");
  assert.equal(direct.status, "limited");
  assert.match(direct.note, /不能标记为安全路线/);
});

test("forbids a safe determination beyond official cyclone time coverage", async () => {
  const { planResponseScenario } = await routing();
  const cyclone = event({
    hazard: "cyclone",
    geometry: { type: "Point", coordinates: [0, 0] },
    cycloneForecast: {
      official: true,
      source: "test",
      sourceUrl: "https://example.com",
      issuedAt: "2026-08-20T00:00:00Z",
      forecastValidUntil: "2026-08-20T02:00:00Z",
      track: [],
      trackGeometry: { type: "LineString", coordinates: [] },
      impactBasis: "forecast_wind_radii",
      note: "test",
      impactField: {
        temporalResolutionHours: 1,
        interpolation: "linear_between_official_nodes",
        uncertaintyBasis: "not_available",
        note: "test",
        frames: [0, 1].map((leadHours) => ({
          forecastAt: `2026-08-20T0${leadHours}:00:00Z`,
          leadHours,
          latitude: 0,
          longitude: 0,
          centerBasis: "official_node",
          windFields: [{ thresholdKnots: 34, basis: "official_circular_extent", quadrantsKm: { northeast: 20, southeast: 20, southwest: 20, northwest: 20 } }],
        })),
      },
    },
  });
  const scenario = planResponseScenario(cyclone, {
    eventRevision: "c".repeat(64),
    origin: [1, 1],
    destination: [1.2, 1.2],
    departureAt: "2026-08-20T05:00:00Z",
  });
  assert.ok(scenario.routes.every((route) => route.status === "unverified"));
  assert.ok(scenario.routes.every((route) => /超出4D影响场有效期/.test(route.note)));
});

test("exports replayable GeoJSON with provenance and route status", async () => {
  const { planResponseScenario, responseScenarioGeoJson } = await routing();
  const scenario = planResponseScenario(event(), {
    eventRevision: "d".repeat(64),
    origin: [-0.3, 0.3],
    destination: [0.3, 0.3],
    departureAt: "2026-08-20T01:00:00Z",
  });
  const geojson = responseScenarioGeoJson(scenario);
  assert.equal(geojson.type, "FeatureCollection");
  assert.equal(geojson.features.length, 5);
  assert.equal(geojson.features[2].properties.eventRevision, "d".repeat(64));
  assert.ok(["clear", "limited", "blocked", "unverified"].includes(geojson.features[2].properties.status));
});

test("evaluates real Amap road geometry against the same hazard field and preserves provenance", async () => {
  const { planRoadResponseScenario, responseScenarioGeoJson } = await routing();
  const scenario = planRoadResponseScenario(event(), {
    eventRevision: "e".repeat(64),
    origin: [-0.3, 0],
    destination: [0.3, 0],
    departureAt: "2026-08-20T01:00:00Z",
    roadRouting: {
      state: "ready",
      provider: "高德地图",
      mode: "driving",
      fetchedAt: "2026-08-20T00:55:00Z",
      sourceCoordinateSystem: "GCJ-02",
      normalizedCoordinateSystem: "WGS84_APPROX",
      note: "test",
      routes: [{
        routeId: "amap-32-1",
        label: "高德推荐路线",
        mode: "driving",
        strategy: 32,
        coordinates: [[-0.3, 0], [0, 0], [0.3, 0]],
        distanceKm: 66.8,
        estimatedMinutes: 90,
        restriction: false,
        tollsYuan: 0,
        trafficLights: 3,
        roadNames: ["测试道路"],
        traffic: { unknownKm: 0, smoothKm: 66.8, slowKm: 0, congestedKm: 0, severeCongestionKm: 0 },
      }],
    },
  });
  assert.equal(scenario.router, "amap_multimodal_v1");
  assert.equal(scenario.travelTimeBasis, "provider_traffic_estimate");
  assert.equal(scenario.routes[0].status, "blocked");
  assert.equal(scenario.routes[0].roadProvider, "高德地图");
  assert.equal(scenario.routes[0].originSnapKm, 0);
  assert.match(scenario.routes[0].note, /基础设施暴露查询/);
  const geojson = responseScenarioGeoJson(scenario);
  assert.equal(geojson.features[2].properties.roadProvider, "高德地图");
  assert.equal(geojson.features[2].properties.coordinateNormalization, "WGS84_APPROX");
});

test("hard-blocks a road candidate that intersects a verified active destruction report", async () => {
  const { planRoadResponseScenario, responseScenarioGeoJson } = await routing();
  const disruption = {
    disruptionId: "destroyed-bridge",
    label: "测试桥梁垮塌",
    kind: "bridge_failure",
    impact: "blocked",
    verification: "verified",
    affectedModes: ["walking"],
    geometry: { type: "Point", coordinates: [0, 0.3] },
    radiusMeters: 150,
    validFrom: "2026-08-20T00:00:00Z",
    validTo: "2026-08-21T00:00:00Z",
    source: "test",
    importedAt: "2026-08-20T00:30:00Z",
  };
  const scenario = planRoadResponseScenario(event(), {
    eventRevision: "f".repeat(64),
    origin: [-0.3, 0.3],
    destination: [0.3, 0.3],
    departureAt: "2026-08-20T01:00:00Z",
    roadDisruptions: [disruption],
    roadRouting: {
      state: "ready",
      provider: "高德地图",
      mode: "walking",
      fetchedAt: "2026-08-20T00:55:00Z",
      sourceCoordinateSystem: "GCJ-02",
      normalizedCoordinateSystem: "WGS84_APPROX",
      note: "test",
      routes: [{
        routeId: "amap-walking-0-1",
        label: "步行候选 1",
        mode: "walking",
        strategy: 0,
        coordinates: [[-0.3, 0.3], [0, 0.3], [0.3, 0.3]],
        distanceKm: 66.8,
        estimatedMinutes: 600,
        restriction: false,
        tollsYuan: 0,
        trafficLights: 0,
        roadNames: ["测试步行道"],
        traffic: { unknownKm: 0, smoothKm: 0, slowKm: 0, congestedKm: 0, severeCongestionKm: 0 },
      }],
    },
  });
  assert.equal(scenario.travelMode, "walking");
  assert.equal(scenario.roadDisruptionCheckCount, 1);
  assert.equal(scenario.roadDisruptions.length, 1, "only intersecting evidence is retained in the scenario snapshot");
  assert.equal(scenario.routes[0].status, "blocked");
  assert.equal(scenario.routes[0].disruptionConflicts.length, 1);
  assert.match(scenario.routes[0].note, /已核验硬阻断/);
  const geojson = responseScenarioGeoJson(scenario);
  assert.equal(geojson.features.at(-1).properties.role, "road_disruption");
  assert.equal(geojson.features.at(-1).properties.verification, "verified");
});

test("downgrades a hazard-clear road route when OSM inventory shows an infrastructure crossing", async () => {
  const { planRoadResponseScenario, responseScenarioGeoJson } = await routing();
  const feature = {
    infrastructureId: "osm-way-99",
    osmType: "way",
    osmId: 99,
    kind: "bridge",
    label: "桥梁 · 测试桥",
    geometry: { type: "LineString", coordinates: [[0, 0.29], [0, 0.31]] },
    highway: "primary",
    bridgeTag: "yes",
    sourceUrl: "https://www.openstreetmap.org/way/99",
    attribution: "© OpenStreetMap contributors · ODbL",
  };
  const scenario = planRoadResponseScenario(event(), {
    eventRevision: "1".repeat(64),
    origin: [-0.3, 0.3],
    destination: [0.3, 0.3],
    departureAt: "2026-08-20T01:00:00Z",
    infrastructure: {
      state: "ready",
      provider: "OpenStreetMap · Overpass",
      fetchedAt: "2026-08-20T00:58:00Z",
      queryBbox: [0.29, -0.31, 0.31, 0.31],
      queryAreaKm2: 150,
      features: [feature],
      crossingsByRoute: { "amap-32-1": [{ ...feature, distanceToRouteMeters: 0 }] },
      attribution: "© OpenStreetMap contributors · ODbL",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      note: "OSM inventory only",
    },
    roadRouting: {
      state: "ready",
      provider: "高德地图",
      mode: "driving",
      fetchedAt: "2026-08-20T00:55:00Z",
      sourceCoordinateSystem: "GCJ-02",
      normalizedCoordinateSystem: "WGS84_APPROX",
      note: "test",
      routes: [{
        routeId: "amap-32-1",
        label: "高德推荐路线",
        mode: "driving",
        strategy: 32,
        coordinates: [[-0.3, 0.3], [0, 0.3], [0.3, 0.3]],
        distanceKm: 66.8,
        estimatedMinutes: 90,
        restriction: false,
        tollsYuan: 0,
        trafficLights: 3,
        roadNames: ["测试道路"],
        traffic: { unknownKm: 0, smoothKm: 66.8, slowKm: 0, congestedKm: 0, severeCongestionKm: 0 },
      }],
    },
  });
  assert.equal(scenario.routes[0].status, "unverified");
  assert.equal(scenario.routes[0].infrastructureCrossings.length, 1);
  assert.equal(scenario.infrastructureFeatures.length, 1);
  assert.match(scenario.routes[0].note, /结构和通行状态未知/);
  const geojson = responseScenarioGeoJson(scenario);
  assert.equal(geojson.features.at(-1).properties.role, "infrastructure_exposure");
  assert.equal(geojson.features.at(-1).properties.structuralStatus, "unknown");
});
