import assert from "node:assert/strict";
import test from "node:test";

async function taskAoi() {
  return import(new URL("../lib/task-aoi.ts", import.meta.url));
}

function longitudes(value, result = []) {
  if (!Array.isArray(value)) return result;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    result.push(value[0]);
    return result;
  }
  value.forEach((item) => longitudes(item, result));
  return result;
}

test("splits AOI crossing the international date line", async () => {
  const { buildTaskAoi } = await taskAoi();
  const { validateGeoGeometry } = await import(new URL("../lib/geo-geometry.ts", import.meta.url));
  const geometry = buildTaskAoi({
    aoiType: "circle",
    latitude: 12,
    longitude: 179.8,
    aoiRadiusKm: 100,
  });
  assert.equal(geometry?.type, "MultiPolygon");
  assert.ok(longitudes(geometry?.coordinates).every((longitude) => longitude >= -180 && longitude <= 180));
  assert.equal(validateGeoGeometry(geometry, { rejectUnsplitAntimeridian: true }).ok, true, "date-line split parts may share only their artificial seam");
});

test("keeps ordinary point and rectangle AOIs deterministic", async () => {
  const { buildTaskAoi } = await taskAoi();
  assert.deepEqual(buildTaskAoi({ aoiType: "point", latitude: 31.5, longitude: 120.3, aoiRadiusKm: 0 }), {
    type: "Point",
    coordinates: [120.3, 31.5],
  });
  const geometry = buildTaskAoi({
    aoiType: "rectangle",
    latitude: 31.5,
    longitude: 120.3,
    aoiRadiusKm: 0,
    aoiWidthKm: 40,
    aoiHeightKm: 20,
  });
  assert.equal(geometry?.type, "Polygon");
  assert.equal(geometry?.coordinates[0].length, 5);
});

test("normalizes uploaded Polygon features and multiple AOI feature collections", async () => {
  const { buildTaskAoi, normalizeCustomAoiGeoJson } = await taskAoi();
  const polygon = normalizeCustomAoiGeoJson({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[120, 31], [121, 31], [121, 32]]] } });
  assert.equal(polygon?.type, "Polygon");
  assert.deepEqual(polygon?.coordinates[0][0], polygon?.coordinates[0].at(-1), "open rings are safely closed");
  assert.deepEqual(buildTaskAoi({ aoiType: "polygon", latitude: 0, longitude: 0, customGeometry: polygon }), polygon);

  const multi = normalizeCustomAoiGeoJson({ type: "FeatureCollection", features: [
    { type: "Feature", geometry: polygon },
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[122, 31], [123, 31], [123, 32], [122, 31]]] } },
  ] });
  assert.equal(multi?.type, "MultiPolygon");
  assert.equal(multi?.coordinates.length, 2);
  assert.equal(normalizeCustomAoiGeoJson({ type: "LineString", coordinates: [[120, 31], [121, 32]] }), null);
});

test("rejects an entire FeatureCollection when any feature is invalid", async () => {
  const { normalizeCustomAoiGeoJson } = await taskAoi();
  const mixed = normalizeCustomAoiGeoJson({ type: "FeatureCollection", features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[120, 31], [121, 31], [121, 32], [120, 31]]] } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[120, 31], [121, 32]] } },
  ] });
  assert.equal(mixed, null);
});
