import assert from "node:assert/strict";
import test from "node:test";

async function amap() {
  return import(new URL("../lib/amap-routing.ts", import.meta.url));
}

test("requires a server-side 32-character Amap Web Service key", async () => {
  const { amapConfiguration } = await amap();
  assert.equal(amapConfiguration({}).ready, false);
  assert.equal(amapConfiguration({ AMAP_WEB_SERVICE_KEY: "short" }).ready, false);
  const configured = amapConfiguration({ AMAP_WEB_SERVICE_KEY: "a".repeat(32) });
  assert.equal(configured.ready, true);
  assert.equal(configured.config.origin, "https://restapi.amap.com");
});

test("builds bounded HTTPS coordinate and driving requests", async () => {
  const { buildAmapCoordinateConversionUrl, buildAmapDrivingUrl, buildAmapGeocodeUrl } = await amap();
  const config = { key: "a".repeat(32), origin: "https://restapi.amap.com" };
  const conversion = new URL(buildAmapCoordinateConversionUrl(config, [[120.3, 31.5], [120.4, 31.6]]));
  assert.equal(conversion.protocol, "https:");
  assert.equal(conversion.searchParams.get("coordsys"), "gps");
  assert.equal(conversion.searchParams.get("locations"), "120.300000,31.500000|120.400000,31.600000");
  const driving = new URL(buildAmapDrivingUrl(config, [120.3, 31.5], [120.4, 31.6], 33));
  assert.equal(driving.pathname, "/v5/direction/driving");
  assert.equal(driving.searchParams.get("strategy"), "33");
  assert.equal(driving.searchParams.get("ferry"), "1");
  assert.equal(driving.searchParams.get("show_fields"), "cost,tmcs,polyline");
  const geocode = new URL(buildAmapGeocodeUrl(config, "西藏日喀则市吉隆县吉隆口岸", "日喀则市"));
  assert.equal(geocode.pathname, "/v3/geocode/geo");
  assert.equal(geocode.searchParams.get("address"), "西藏日喀则市吉隆县吉隆口岸");
});

test("normalizes Amap geocoded place coordinates to WGS84", async () => {
  const { parseAmapGeocodes } = await amap();
  const results = parseAmapGeocodes({ status: "1", geocodes: [{ formatted_address: "西藏自治区日喀则市吉隆县吉隆口岸", district: "吉隆县", level: "兴趣点", location: "85.379735,28.276811" }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].formattedAddress, "西藏自治区日喀则市吉隆县吉隆口岸");
  assert.deepEqual(results[0].coordinate, [85.377307, 28.280317]);
});

test("parses Amap road geometry, cost and traffic without leaking provider coordinates", async () => {
  const { parseAmapDriving } = await amap();
  const route = parseAmapDriving({
    status: "1",
    route: {
      paths: [{
        distance: "12600",
        restriction: "0",
        cost: { duration: "1200", tolls: "3.5", traffic_lights: "8" },
        steps: [
          { road_name: "太湖大道", polyline: "120.300000,31.500000;120.350000,31.520000", tmcs: [{ tmc_status: "畅通", tmc_distance: "7000" }] },
          { road_name: "蠡湖大道", polyline: "120.350000,31.520000;120.400000,31.550000", tmcs: [{ tmc_status: "拥堵", tmc_distance: "5600" }] },
        ],
      }],
    },
  }, 33);
  assert.equal(route.label, "躲避拥堵路线");
  assert.equal(route.distanceKm, 12.6);
  assert.equal(route.estimatedMinutes, 20);
  assert.equal(route.traffic.smoothKm, 7);
  assert.equal(route.traffic.congestedKm, 5.6);
  assert.deepEqual(route.roadNames, ["太湖大道", "蠡湖大道"]);
  assert.ok(route.coordinates.length >= 2);
  assert.notEqual(route.coordinates[0][0], 120.3, "GCJ-02 should be normalized before it reaches the WGS84 map");
});

test("round-trips WGS84 and GCJ-02 control points within a few metres", async () => {
  const { gcj02ToWgs84, wgs84ToGcj02 } = await amap();
  const original = [120.31191, 31.49117];
  const restored = gcj02ToWgs84(wgs84ToGcj02(original));
  assert.ok(Math.abs(restored[0] - original[0]) < 0.00002);
  assert.ok(Math.abs(restored[1] - original[1]) < 0.00002);
});

test("builds and parses up to three walking alternatives", async () => {
  const { buildAmapRouteUrl, parseAmapRouteAlternatives } = await amap();
  const config = { key: "a".repeat(32), origin: "https://restapi.amap.com" };
  const url = new URL(buildAmapRouteUrl(config, [120.3, 31.5], [120.31, 31.51], "walking"));
  assert.equal(url.pathname, "/v5/direction/walking");
  assert.equal(url.searchParams.get("alternative_route"), "3");
  const payload = {
    status: "1",
    route: { paths: [
      { distance: "1700", cost: { duration: "1200" }, steps: [{ road_name: "步行道", polyline: "120.300000,31.500000;120.310000,31.510000" }] },
      { distance: "1900", cost: { duration: "1350" }, steps: [{ road_name: "河滨路", polyline: "120.300000,31.500000;120.305000,31.508000;120.310000,31.510000" }] },
    ] },
  };
  const routes = parseAmapRouteAlternatives(payload, "walking");
  assert.equal(routes.length, 2);
  assert.equal(routes[0].mode, "walking");
  assert.equal(routes[0].label, "步行候选 1");
  assert.equal(routes[0].estimatedMinutes, 20);
});
