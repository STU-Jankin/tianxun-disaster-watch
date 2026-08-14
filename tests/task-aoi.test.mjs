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
  const geometry = buildTaskAoi({
    aoiType: "circle",
    latitude: 12,
    longitude: 179.8,
    aoiRadiusKm: 100,
  });
  assert.equal(geometry?.type, "MultiPolygon");
  assert.ok(longitudes(geometry?.coordinates).every((longitude) => longitude >= -180 && longitude <= 180));
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
