import assert from "node:assert/strict";
import test from "node:test";

import {
  REGIONAL_LANDSLIDE_SCREENING_PRODUCT,
  REGIONAL_LANDSLIDE_SCREENING_SOURCE,
  attachRegionalTerrainGeometry,
  buildRegionalLandslideScreeningProducts,
  isRegionalLandslideScreeningSource,
  regionalLandslidePilotCells,
} from "../lib/landslide-regional-screening.ts";

const issuedAt = "2026-09-01T06:00:00.000Z";

function forecast(levels, longitude = 108.4, latitude = 30.8) {
  const periods = [24, 48, 72].map((leadHours) => ({
    leadHours,
    validFrom: new Date(Date.parse(issuedAt) + (leadHours - 24) * 3_600_000).toISOString(),
    validTo: new Date(Date.parse(issuedAt) + leadHours * 3_600_000).toISOString(),
    precipitationMm: 80,
    maximumHourlyPrecipitationMm: 12,
    maximumSixHourPrecipitationMm: 45,
    localDailyP95Mm: 60,
    rainfallExceedanceRatio: levels[leadHours] === "high" ? 1.6 : levels[leadHours] === "elevated" ? 1.1 : 0.2,
    antecedent48HourPrecipitationMm: 50,
    antecedentLoadRatio: 0.42,
    soilMoistureFraction: 0.3,
    triggerLevel: levels[leadHours],
    triggerLabel: levels[leadHours],
    confidence: leadHours === 72 ? "low" : "medium",
    automaticDispatchAllowed: false,
    action: "人工复核",
    basis: [],
  }));
  const value = {
    state: "ready",
    product: "tianxun-rainfall-trigger-screening-v1",
    modelStatus: "experimental_unvalidated",
    provider: "test",
    weatherModel: { id: "cma_grapes_global", label: "CMA GRAPES Global", nativeResolutionKm: 15, updateIntervalHours: 6, selectionReason: "test" },
    pilotRegion: null,
    latitude,
    longitude,
    radiusKm: 7.5,
    fetchedAt: issuedAt,
    weatherModelRunAt: null,
    baselinePeriod: { start: "2014-01-01", end: "2023-12-31", validDayCount: 3652 },
    terrain: { state: "ready", maximumSlopeDeg: 25, sourceUrl: "https://open-meteo.com/en/docs/elevation-api", note: "test" },
    inputWarnings: [],
    horizons: periods,
    sourceUrls: { forecast: "https://example.test/forecast", climatology: "https://example.test/climate", terrain: "https://example.test/terrain", method: "https://example.test/method" },
    dataBoundary: "test",
    note: "test",
  };
  return attachRegionalTerrainGeometry(value, {
    type: "Polygon",
    coordinates: [[[longitude - 0.01, latitude - 0.01], [longitude + 0.01, latitude - 0.01], [longitude + 0.01, latitude + 0.01], [longitude - 0.01, latitude + 0.01], [longitude - 0.01, latitude - 0.01]]],
  });
}

test("regional pilot is explicitly bounded to nine unique Chongqing/Jiangsu cells", () => {
  assert.equal(regionalLandslidePilotCells.length, 9);
  assert.equal(new Set(regionalLandslidePilotCells.map((cell) => cell.id)).size, 9);
  assert.deepEqual(new Set(regionalLandslidePilotCells.map((cell) => cell.regionId)), new Set(["chongqing", "jiangsu"]));
  assert.ok(regionalLandslidePilotCells.every((cell) => cell.radiusKm === 7.5));
  assert.ok(regionalLandslidePilotCells.every((cell) => cell.terrainRadiusKm === 3));
});

test("24/48-hour elevated cells become one versionable regional product while 72 hours stays trend-only", () => {
  const cells = regionalLandslidePilotCells.filter((cell) => cell.regionId === "chongqing").slice(0, 2);
  const products = buildRegionalLandslideScreeningProducts([
    { cell: cells[0], forecast: forecast({ 24: "high", 48: "low_signal", 72: "high" }, cells[0].longitude, cells[0].latitude) },
    { cell: cells[1], forecast: forecast({ 24: "elevated", 48: "watch", 72: "elevated" }, cells[1].longitude, cells[1].latitude) },
  ], issuedAt);
  assert.equal(products.length, 1);
  assert.equal(products[0].sourceEventId, "regional-landslide-chongqing-h24");
  assert.equal(products[0].severity, "orange");
  assert.equal(products[0].highCellCount, 1);
  assert.equal(products[0].elevatedCellCount, 1);
  assert.equal(products[0].trend72HourCellCount, 2);
  assert.equal(products[0].geometry.type, "MultiPolygon");
  assert.equal(products[0].geometry.coordinates.length, 2);
  assert.match(products[0].description, new RegExp(REGIONAL_LANDSLIDE_SCREENING_PRODUCT));
  assert.match(products[0].description, /不是滑坡概率/);
  assert.match(products[0].description, /禁止自动告警、自动计算和自动下发/);
});

test("watch/low cells and 72-hour-only signals do not create operational events", () => {
  const cell = regionalLandslidePilotCells[0];
  const products = buildRegionalLandslideScreeningProducts([
    { cell, forecast: forecast({ 24: "watch", 48: "low_signal", 72: "high" }, cell.longitude, cell.latitude) },
  ], issuedAt);
  assert.deepEqual(products, []);
});

test("regional source identity is exact and safe for compound source labels", () => {
  assert.equal(isRegionalLandslideScreeningSource(REGIONAL_LANDSLIDE_SCREENING_SOURCE), true);
  assert.equal(isRegionalLandslideScreeningSource(`${REGIONAL_LANDSLIDE_SCREENING_SOURCE} · CMA GRAPES Global`), true);
  assert.equal(isRegionalLandslideScreeningSource("NASA LHASA"), false);
});
