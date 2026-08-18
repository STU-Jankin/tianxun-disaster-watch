import assert from "node:assert/strict";
import test from "node:test";

async function metTools() {
  return import(new URL("../lib/met-weather.ts", import.meta.url));
}

test("MET Norway fallback needs no key and normalizes global hourly weather", async () => {
  const { buildMetWeatherUrl, metWeatherUserAgent, parseMetWeatherForecast } = await metTools();
  assert.match(buildMetWeatherUrl(31.491, 120.312), /^https:\/\/api\.met\.no\/weatherapi\/locationforecast\/2\.0\/compact\?/);
  assert.match(metWeatherUserAgent({}), /Tianxun-Disaster-Watch/);
  const forecast = parseMetWeatherForecast({ properties: {
    meta: { updated_at: "2026-08-18T05:16:33Z" },
    timeseries: [
      { time: "2026-08-18T07:00:00Z", data: { instant: { details: { air_temperature: 31.9, cloud_area_fraction: 25, relative_humidity: 60, wind_from_direction: 72, wind_speed: 4.1 } }, next_1_hours: { summary: { symbol_code: "partlycloudy_day" }, details: { precipitation_amount: 0 } } } },
      { time: "2026-08-18T08:00:00Z", data: { instant: { details: { air_temperature: 31.3, cloud_area_fraction: 85, relative_humidity: 64, wind_from_direction: 180, wind_speed: 5 } }, next_1_hours: { summary: { symbol_code: "rain" }, details: { precipitation_amount: 2 } } } },
    ],
  } }, { latitude: 31.491, longitude: 120.312 }, 72, "2026-08-18T06:00:00Z");
  assert.equal(forecast.provider, "MET Norway");
  assert.equal(forecast.hourly[0].windSpeedKmh, 14.8);
  assert.equal(forecast.hourly[0].opticalSuitability, "good");
  assert.equal(forecast.hourly[1].opticalSuitability, "poor");
  assert.match(forecast.note, /不等同于站点实况/);
});
