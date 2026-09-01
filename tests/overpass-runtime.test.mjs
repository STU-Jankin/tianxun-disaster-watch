import assert from "node:assert/strict";
import test from "node:test";

import { overpassCacheKey, resolveOverpassRuntimeConfig } from "../lib/overpass-runtime.ts";

test("keeps the public Overpass profile bounded while covering a standard earthquake AOI", () => {
  const config = resolveOverpassRuntimeConfig({
    OVERPASS_PROFILE: "public",
    OVERPASS_API_URL: "https://overpass-api.de/api/interpreter",
    OVERPASS_MAX_AREA_KM2: "50000",
  });
  assert.equal(config.profile, "public");
  assert.equal(config.maximumAreaKm2, 3_500);
  assert.equal(config.queryTimeoutSeconds, 25);
  assert.equal(config.updateCadence, "upstream");
  assert.match(overpassCacheKey(config, "exposure", "aoi:123"), /^public:exposure:/);
});

test("requires a distinct endpoint before enabling the China daily profile", () => {
  assert.throws(() => resolveOverpassRuntimeConfig({ OVERPASS_PROFILE: "china_daily" }), /必须配置独立/);
  const config = resolveOverpassRuntimeConfig({
    OVERPASS_PROFILE: "china_daily",
    OVERPASS_API_URL: "https://osm-china.example.com/api/interpreter",
    OVERPASS_MAX_AREA_KM2: "50000",
  });
  assert.equal(config.dataScope, "china");
  assert.equal(config.updateCadence, "daily");
  assert.equal(config.maximumAreaKm2, 50_000);
  assert.equal(config.cacheTtlMs, 26 * 60 * 60_000);
});

test("allows an operator-controlled loopback endpoint only with explicit opt-in", () => {
  const environment = {
    OVERPASS_PROFILE: "china_daily",
    OVERPASS_API_URL: "http://127.0.0.1:8080/api/interpreter",
  };
  assert.throws(() => resolveOverpassRuntimeConfig(environment), /显式设置/);
  const config = resolveOverpassRuntimeConfig({ ...environment, OVERPASS_ALLOW_PRIVATE_ENDPOINT: "true" });
  assert.equal(config.endpoint.hostname, "127.0.0.1");
});
