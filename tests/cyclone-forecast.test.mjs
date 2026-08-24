import assert from "node:assert/strict";
import test from "node:test";

async function forecastTools() {
  return import(new URL("../lib/cyclone-forecast.ts", import.meta.url));
}

test("NHC official KML yields hourly centers, quadrant wind fields, uncertainty cone and the lowest 34 kt footprint", async () => {
  const { buildHourlyCycloneImpactField, parseNhcConeKml, parseNhcTrackKml, parseNhcWindRadiiKml } = await forecastTools();
  const trackKml = `<kml><Placemark><description>Advisory Information Maximum Wind: 40 knots Minimum Pressure: 1000 mb</description><Point><coordinates>-130,15</coordinates></Point></Placemark><Placemark><description>24 hr Forecast Maximum Wind: 50 knots</description><Point><coordinates>-132,16</coordinates></Point></Placemark></kml>`;
  const track = parseNhcTrackKml(trackKml, "2026-08-14T00:00:00Z", { latitude: 15, longitude: -130 });
  assert.equal(track.track.length, 2);
  assert.equal(track.track[1].leadHours, 24);
  assert.equal(track.track[1].forecastAt, "2026-08-15T00:00:00.000Z");
  assert.deepEqual(track.trackGeometry.coordinates, [[-130, 15], [-132, 16]]);

  const polygon = "<Polygon><outerBoundaryIs><LinearRing><coordinates>-131,14 -129,14 -129,16 -131,14</coordinates></LinearRing></outerBoundaryIs></Polygon>";
  assert.equal(parseNhcConeKml(`<kml><Placemark>${polygon}</Placemark></kml>`).type, "Polygon");
  const secondPolygon = "<Polygon><outerBoundaryIs><LinearRing><coordinates>-133,15 -131,15 -131,17 -133,15</coordinates></LinearRing></outerBoundaryIs></Polygon>";
  const radii = parseNhcWindRadiiKml(`<kml><Placemark><name>34 kt 0 hr</name>${polygon}</Placemark><Placemark><name>34 kt 24 hr</name>${secondPolygon}</Placemark><Placemark><name>50 kt 0 hr</name>${polygon}</Placemark></kml>`, track.track);
  assert.equal(radii.thresholdKnots, 34);
  assert.ok(["Polygon", "MultiPolygon"].includes(radii.geometry.type));
  assert.equal(radii.timeSlices.length, 2);
  assert.ok(radii.timeSlices[0].windFields[0].quadrantsKm.northeast > 0);
  const field = buildHourlyCycloneImpactField(track.track, radii.timeSlices, parseNhcConeKml(`<kml><Placemark>${polygon}</Placemark></kml>`));
  assert.equal(field.frames.length, 25);
  assert.equal(field.frames[1].centerBasis, "interpolated_official_track");
  assert.equal(field.frames[12].windFields[0].basis, "interpolated_official_fields");
  assert.equal(field.uncertaintyBasis, "official_advisory_envelope");
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
  assert.equal(result.impactField.frames.length, 25);
  assert.equal(result.impactField.frames[0].windFields[0].basis, "official_circular_extent");
  assert.equal(result.impactField.frames[24].uncertaintyRadiusKm, 120.38);
  assert.match(result.note, /不等同于受灾范围/);
});

test("geodesic circles remain valid across the international date line", async () => {
  const { circleRing } = await forecastTools();
  const ring = circleRing(15, 179.8, 300_000);
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(ring.every(([longitude, latitude]) => longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90));
  assert.ok(ring.some(([longitude]) => longitude < -179));
});

test("NHC 0..360 cones retain all date-line vertices and omit artificial map seams", async () => {
  const { parseNhcConeKml } = await forecastTools();
  const { antimeridianOutlineGeometry } = await import(new URL("../lib/geo-geometry.ts", import.meta.url));
  const cone = parseNhcConeKml(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>179,10 189,10 189,20 179,20 179,10</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`);
  assert.equal(cone.type, "MultiPolygon");
  const points = cone.coordinates.flat(2);
  assert.ok(points.some(([longitude]) => longitude < -170));
  assert.ok(points.some(([longitude]) => longitude >= 179));
  assert.ok(points.every(([longitude, latitude]) => longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90));

  const outline = antimeridianOutlineGeometry(cone, -171);
  assert.equal(outline?.type, "MultiLineString");
  assert.ok(outline.coordinates.flatMap((line) => line).every(([longitude]) => longitude >= -181 && longitude <= -171));
  assert.ok(outline.coordinates.every((line) => line.every((point, index) => index === 0 || !(Math.abs(Math.abs(point[0]) - 180) < 1e-7 && Math.abs(Math.abs(line[index - 1][0]) - 180) < 1e-7))));
});

test("task AOI slices are clipped to the imaging window and split at the date line", async () => {
  const { cycloneTaskAoiSlices } = await forecastTools();
  const forecast = {
    official: true,
    source: "test",
    sourceUrl: "https://example.com/",
    issuedAt: "2026-08-18T00:00:00Z",
    forecastValidUntil: "2026-08-18T03:00:00Z",
    track: [],
    trackGeometry: { type: "LineString", coordinates: [] },
    impactBasis: "forecast_wind_radii",
    note: "test",
    impactField: {
      temporalResolutionHours: 1,
      interpolation: "linear_between_official_nodes",
      uncertaintyBasis: "not_available",
      note: "test",
      frames: [0, 1, 2].map((leadHours) => ({
        forecastAt: new Date(Date.parse("2026-08-18T00:00:00Z") + leadHours * 3_600_000).toISOString(),
        leadHours,
        latitude: 15,
        longitude: 179.8,
        centerBasis: leadHours === 0 ? "official_node" : "interpolated_official_track",
        windFields: [{ thresholdKnots: 34, basis: "official_circular_extent", quadrantsKm: { northeast: 120, southeast: 120, southwest: 120, northwest: 120 } }],
      })),
    },
  };
  const slices = cycloneTaskAoiSlices(forecast, "2026-08-18T00:30:00Z", "2026-08-18T02:30:00Z");
  assert.equal(slices.length, 3);
  assert.equal(slices[0].validFrom, "2026-08-18T00:30:00.000Z");
  assert.equal(slices.at(-1).validTo, "2026-08-18T02:30:00.000Z");
  assert.equal(slices[0].windGeometry.type, "MultiPolygon");
});

test("task AOI slices retain hourly forecast centers without wind radii or uncertainty", async () => {
  const { cycloneTaskAoiSlices } = await forecastTools();
  const forecast = {
    impactField: {
      frames: [0, 1, 2].map((leadHours) => ({
        forecastAt: new Date(Date.parse("2026-08-18T00:00:00Z") + leadHours * 3_600_000).toISOString(),
        leadHours,
        latitude: 15 + leadHours,
        longitude: 120 + leadHours,
        centerBasis: leadHours === 0 ? "official_node" : "interpolated_official_track",
        windFields: [],
      })),
    },
  };
  const slices = cycloneTaskAoiSlices(forecast, "2026-08-18T00:00:00Z", "2026-08-18T03:00:00Z");
  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((slice) => slice.center), [[120, 15], [121, 16], [122, 17]]);
  assert.ok(slices.every((slice) => slice.windGeometry === undefined && slice.uncertaintyGeometry === undefined));
});
