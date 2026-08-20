import assert from "node:assert/strict";
import test from "node:test";

async function weatherTools() {
  return import(new URL("../lib/qweather.ts", import.meta.url));
}

test("QWeather configuration requires a dedicated HTTPS API Host and keeps the API key in headers", async () => {
  const { buildQWeatherForecastUrl, qweatherAuthorizationHeaders, qweatherConfiguration } = await weatherTools();
  const legacy = qweatherConfiguration({ QWEATHER_API_HOST: "devapi.qweather.com", QWEATHER_API_KEY: "synthetic-key" });
  assert.equal(legacy.ready, false);

  const configured = qweatherConfiguration({ QWEATHER_API_HOST: "abc123.def.qweatherapi.com", QWEATHER_API_KEY: "synthetic-key" });
  assert.equal(configured.ready, true);
  assert.ok(configured.config);
  const url = buildQWeatherForecastUrl(configured.config, 31.491, 120.312, 72);
  assert.match(url, /^https:\/\/abc123\.def\.qweatherapi\.com\/v7\/weather\/72h\?/);
  assert.match(url, /location=120\.31%2C31\.49/);
  assert.doesNotMatch(url, /synthetic-key/);
  assert.deepEqual(await qweatherAuthorizationHeaders(configured.config), { "X-QW-Api-Key": "synthetic-key" });
});

test("QWeather parser preserves provenance and derives conservative optical windows", async () => {
  const { parseQWeatherForecast, weatherImagingWindows } = await weatherTools();
  const forecast = parseQWeatherForecast({
    code: "200",
    updateTime: "2026-08-18T08:00+08:00",
    fxLink: "https://www.qweather.com/weather/wuxi-101190201.html",
    hourly: [
      { fxTime: "2026-08-18T01:00Z", temp: "30", text: "多云", icon: "101", windSpeed: "12", windDir: "东南风", humidity: "70", precip: "0", cloud: "25" },
      { fxTime: "2026-08-18T02:00Z", temp: "30", text: "晴", icon: "100", windSpeed: "10", windDir: "东南风", humidity: "68", precip: "0.1", cloud: "20" },
      { fxTime: "2026-08-18T03:00Z", temp: "29", text: "阵雨", icon: "300", windSpeed: "15", windDir: "南风", humidity: "80", precip: "2", cloud: "85" },
    ],
    refer: { sources: ["QWeather"], license: ["QWeather Developers License"] },
  }, { latitude: 31.49, longitude: 120.31 }, "2026-08-18T00:30:00Z");
  assert.equal(forecast.state, "ready");
  assert.equal(forecast.product, "weather-hourly");
  assert.equal(forecast.resolution, "坐标匹配城市/区域");
  assert.equal(forecast.hourly[0].opticalSuitability, "good");
  assert.equal(forecast.hourly[2].opticalSuitability, "poor");
  assert.equal(forecast.sourceUrl, "https://www.qweather.com/weather/wuxi-101190201.html");
  assert.deepEqual(weatherImagingWindows(forecast.hourly, 30), [{
    start: "2026-08-18T01:00:00.000Z",
    end: "2026-08-18T03:00:00.000Z",
    minimumCloudPercent: 20,
    maximumCloudPercent: 25,
    maximumPrecipitationMm: 0.1,
  }]);
});

test("QWeather JWT uses Ed25519 and contains only the documented claims", async () => {
  const { qweatherAuthorizationHeaders } = await weatherTools();
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const base64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
  const headers = await qweatherAuthorizationHeaders({
    origin: "https://abc123.def.qweatherapi.com",
    auth: { type: "jwt", projectId: "PROJECT123", credentialId: "CRED1234", privateKey },
  }, Date.parse("2026-08-18T00:00:00Z"));
  const token = headers.Authorization.slice("Bearer ".length);
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  const decode = (value) => JSON.parse(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"));
  assert.deepEqual(decode(encodedHeader), { alg: "EdDSA", kid: "CRED1234" });
  assert.deepEqual(Object.keys(decode(encodedPayload)).sort(), ["exp", "iat", "sub"]);
  assert.ok(signature.length > 40);
});

test("weather API source enforces authentication, rate limits, caching and a QWeather budget with no-key fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/weather/route.ts", import.meta.url), "utf8");
  for (const guard of ["authorizeApiRequest", "enforceRateLimit", "QWEATHER_DAILY_UNIQUE_LOCATION_LIMIT", "X-Tianxun-Weather-Cache", "latitude.toFixed(2)"]) assert.ok(route.includes(guard));
  for (const fallback of ["fetchMetWeather", "MET Norway", "metWeatherUserAgent"]) assert.ok(route.includes(fallback));
  assert.match(route, /redirect: "manual"/);
  assert.doesNotMatch(route, /redirect: "error"/);
  assert.doesNotMatch(route, /QWEATHER_API_KEY[^\n]*Response/);
});
