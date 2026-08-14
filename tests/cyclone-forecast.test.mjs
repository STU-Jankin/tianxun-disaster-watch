import assert from "node:assert/strict";
import test from "node:test";

async function forecastTools() {
  return import(new URL("../lib/cyclone-forecast.ts", import.meta.url));
}

test("NHC official KML yields forecast nodes, uncertainty cone and the lowest 34 kt wind footprint", async () => {
  const { parseNhcConeKml, parseNhcTrackKml, parseNhcWindRadiiKml } = await forecastTools();
  const trackKml = `<kml><Placemark><description>Advisory Information Maximum Wind: 40 knots Minimum Pressure: 1000 mb</description><Point><coordinates>-130,15</coordinates></Point></Placemark><Placemark><description>24 hr Forecast Maximum Wind: 50 knots</description><Point><coordinates>-132,16</coordinates></Point></Placemark></kml>`;
  const track = parseNhcTrackKml(trackKml, "2026-08-14T00:00:00Z", { latitude: 15, longitude: -130 });
  assert.equal(track.track.length, 2);
  assert.equal(track.track[1].leadHours, 24);
  assert.equal(track.track[1].forecastAt, "2026-08-15T00:00:00.000Z");
  assert.deepEqual(track.trackGeometry.coordinates, [[-130, 15], [-132, 16]]);

  const polygon = "<Polygon><outerBoundaryIs><LinearRing><coordinates>-131,14 -129,14 -129,16 -131,14</coordinates></LinearRing></outerBoundaryIs></Polygon>";
  assert.equal(parseNhcConeKml(`<kml><Placemark>${polygon}</Placemark></kml>`).type, "Polygon");
  const radii = parseNhcWindRadiiKml(`<kml><Placemark><name>50</name>${polygon}</Placemark><Placemark><name>34</name>${polygon}</Placemark></kml>`);
  assert.equal(radii.thresholdKnots, 34);
  assert.equal(radii.geometry.type, "Polygon");
});

test("JMA specifications preserve lat/lon order and separate 70% forecast circles from current wind extent", async () => {
  const { buildJmaCycloneForecast } = await forecastTools();
  const specifications = [
    { part: "title", issue: { UTC: "2026-08-14T03:45:00Z" }, typhoonNumber: "2617" },
    { part: { en: "Analysis" }, advancedHours: 0, position: { deg: [29, 154.1] }, validtime: { UTC: "2026-08-14T03:00:00Z" }, maximumWind: { sustained: { kt: "35" } }, pressure: "994" },
    { part: { en: "Forecast" }, advancedHours: 24, position: { deg: [28.8, 156.2] }, validtime: { UTC: "2026-08-15T03:00:00Z" }, probabilityCircleRadius: { km: 120 }, maximumWind: { sustained: { kt: "35" } }, pressure: "996" },
  ];
  const forecastPayload = [
    { part: "title" },
    { advancedHours: 0, center: [29, 154.1], galeWarningArea: { center: [29, 154.39], radius: 305580 } },
    { advancedHours: 24, center: [28.8, 156.2], probabilityCircle: { radius: 120380 } },
  ];
  const result = buildJmaCycloneForecast(specifications, forecastPayload, "https://www.jma.go.jp/bosai/typhoon/");
  assert.equal(result.track[0].latitude, 29);
  assert.equal(result.track[0].longitude, 154.1);
  assert.deepEqual(result.trackGeometry.coordinates[1], [156.2, 28.8]);
  assert.equal(result.uncertaintyGeometry.type, "Polygon");
  assert.equal(result.impactGeometry.type, "Polygon");
  assert.equal(result.impactBasis, "current_wind_extent");
  assert.match(result.note, /不等同于受灾范围/);
});

test("geodesic circles remain valid across the international date line", async () => {
  const { circleRing } = await forecastTools();
  const ring = circleRing(15, 179.8, 300_000);
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(ring.every(([longitude, latitude]) => longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90));
  assert.ok(ring.some(([longitude]) => longitude < -179));
});
