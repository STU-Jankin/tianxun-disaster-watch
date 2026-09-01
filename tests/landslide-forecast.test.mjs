import assert from "node:assert/strict";
import test from "node:test";

async function forecastTools() {
  return import(new URL(`../lib/landslide-forecast.ts?test=${Date.now()}-${Math.random()}`, import.meta.url));
}

function hourlyPayload(start = "2026-08-30T12:00") {
  const startMs = Date.parse(`${start}Z`);
  const time = Array.from({ length: 120 }, (_, index) => new Date(startMs + index * 3_600_000).toISOString().slice(0, 16));
  const precipitation = Array.from({ length: 120 }, () => 0);
  precipitation.fill(1.7, 48, 72);
  precipitation.fill(2.5, 72, 96);
  precipitation.fill(0.25, 96, 120);
  return {
    latitude: 29.5,
    longitude: 90.5,
    hourly: {
      time,
      precipitation,
      soil_moisture_9_to_27cm: Array.from({ length: 120 }, () => 0.31),
      soil_moisture_27_to_81cm: Array.from({ length: 120 }, () => 0.39),
    },
  };
}

test("builds bounded key-free Open-Meteo forecast and climatology URLs", async () => {
  const { buildOpenMeteoLandslideForecastUrl, buildOpenMeteoLandslideClimatologyUrl } = await forecastTools();
  const forecast = new URL(buildOpenMeteoLandslideForecastUrl(29.5, 90.5));
  assert.equal(forecast.origin, "https://api.open-meteo.com");
  assert.equal(forecast.searchParams.get("past_hours"), "48");
  assert.equal(forecast.searchParams.get("forecast_hours"), "72");
  assert.match(forecast.searchParams.get("hourly"), /soil_moisture_27_to_81cm/);
  const history = new URL(buildOpenMeteoLandslideClimatologyUrl(29.5, 90.5, { start: "2015-01-01", end: "2024-12-31" }));
  assert.equal(history.origin, "https://archive-api.open-meteo.com");
  assert.equal(history.searchParams.get("daily"), "precipitation_sum");
});

test("parses hourly forecast and rejects discontinuous time axes", async () => {
  const { parseOpenMeteoLandslideForecast } = await forecastTools();
  const parsed = parseOpenMeteoLandslideForecast(hourlyPayload());
  assert.equal(parsed.times.length, 120);
  assert.equal(parsed.soilMoistureFraction[0], 0.35);
  const broken = hourlyPayload();
  broken.hourly.time[60] = broken.hourly.time[59];
  assert.throws(() => parseOpenMeteoLandslideForecast(broken), /时间轴不连续/);
});

test("requires a long local rainfall baseline before calculating P95", async () => {
  const { parseOpenMeteoLandslideClimatology } = await forecastTools();
  assert.throws(() => parseOpenMeteoLandslideClimatology({ daily: { precipitation_sum: [1, 2, 3] } }), /3000天/);
  const values = Array.from({ length: 3_650 }, (_, index) => index % 100);
  const parsed = parseOpenMeteoLandslideClimatology({ daily: { precipitation_sum: values } });
  assert.equal(parsed.validDayCount, 3_650);
  assert.ok(parsed.dailyP95Mm >= 94 && parsed.dailyP95Mm <= 95);
});

test("produces transparent 24/48/72 hour trigger levels without calling them probabilities", async () => {
  const { buildLandslideForecast, parseOpenMeteoLandslideForecast } = await forecastTools();
  const result = buildLandslideForecast({
    series: parseOpenMeteoLandslideForecast(hourlyPayload()),
    climatology: { dailyP95Mm: 40, validDayCount: 3_650 },
    terrain: {
      state: "flat",
      provider: "Open-Meteo Elevation · Copernicus DEM",
      message: "test terrain",
      maximumSlopeDeg: 22,
      sourceUrl: "https://open-meteo.com/en/docs/elevation-api",
      attribution: "Copernicus DEM GLO-90 · Open-Meteo",
    },
    radiusKm: 10,
    fetchedAt: "2026-09-01T12:30:00.000Z",
    baselinePeriod: { start: "2015-01-01", end: "2024-12-31" },
  });
  assert.deepEqual(result.horizons.map((item) => item.leadHours), [24, 48, 72]);
  assert.equal(result.horizons[0].triggerLevel, "elevated");
  assert.equal(result.horizons[1].triggerLevel, "high");
  assert.equal(result.horizons[2].confidence, "low");
  assert.ok(result.horizons.every((item) => item.automaticDispatchAllowed === false));
  assert.match(result.note, /不输出滑坡概率/);
  assert.match(result.dataBoundary, /不是空间概率栅格/);
});

test("refuses to classify when terrain or climatology inputs are missing", async () => {
  const { buildLandslideForecast, parseOpenMeteoLandslideForecast } = await forecastTools();
  const result = buildLandslideForecast({
    series: parseOpenMeteoLandslideForecast(hourlyPayload()),
    climatology: null,
    terrain: { state: "unavailable", provider: "Open-Meteo Elevation · Copernicus DEM", message: "terrain unavailable" },
    radiusKm: 10,
    fetchedAt: "2026-09-01T12:30:00.000Z",
  });
  assert.ok(result.horizons.every((item) => item.triggerLevel === "unclassified"));
});
