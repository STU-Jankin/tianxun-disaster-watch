import assert from "node:assert/strict";
import test from "node:test";
import { validateGeoGeometry } from "../lib/geo-geometry.ts";
import { buildConservativePlannedSceneFootprint, buildInstantaneousReachableSlice, buildReachableImagingCorridor, groundReachForIncidence } from "../lib/satellite-imaging-geometry.ts";

const line1 = "1 25544U 98067A   24213.62031250  .00016717  00000+0  30289-3 0  9991";
const line2 = "2 25544  51.6400  40.0000 0005000  80.0000 280.0000 15.50000000400000";

test("builds two time-local SAR reachable strips from TLE and incidence limits", () => {
  const result = buildReachableImagingCorridor({
    tleLine1: line1,
    tleLine2: line2,
    start: "2024-08-01T14:59:45.000Z",
    end: "2024-08-01T15:00:15.000Z",
    incidenceAngleMinDeg: 15,
    incidenceAngleMaxDeg: 45,
    lookSides: ["left", "right"],
    stepSeconds: 5,
  });
  assert.ok(result);
  assert.equal(result.geometry.type, "MultiPolygon");
  assert.deepEqual(result.lookSides, ["left", "right"]);
  assert.ok(result.sampleCount >= 2);
  assert.ok(result.nearGroundRangeKm > 0);
  assert.ok(result.farGroundRangeKm > result.nearGroundRangeKm);
  assert.equal(result.basis, "tle_sgp4_incidence_envelope");
  assert.equal(validateGeoGeometry(result.geometry, { maximumAreaKm2: 25_000_000, rejectUnsplitAntimeridian: true }).ok, true);
});

test("builds a moving display slice centered on the selected playback second", () => {
  const result = buildInstantaneousReachableSlice({
    tleLine1: line1,
    tleLine2: line2,
    at: "2024-08-01T15:00:00.000Z",
    incidenceAngleMinDeg: 15,
    incidenceAngleMaxDeg: 45,
    lookSides: ["left", "right"],
    displaySpanSeconds: 4,
  });
  assert.ok(result);
  assert.equal(result.centeredAt, "2024-08-01T15:00:00.000Z");
  assert.equal(result.displaySpanSeconds, 4);
  assert.equal(result.sampledFrom, "2024-08-01T14:59:58.000Z");
  assert.equal(result.sampledTo, "2024-08-01T15:00:02.000Z");
  assert.equal(validateGeoGeometry(result.geometry, { maximumAreaKm2: 25_000_000, rejectUnsplitAntimeridian: true }).ok, true);
});

test("ground reach increases with incidence for a fixed orbit altitude", () => {
  assert.ok(groundReachForIncidence(500, 45) > groundReachForIncidence(500, 15));
});

test("builds a planned scene with the same spherical sampling as the hard incidence boundary", () => {
  const altitudeKm = 420;
  const nearKm = groundReachForIncidence(altitudeKm, 15);
  const farKm = groundReachForIncidence(altitudeKm, 45);
  const result = buildConservativePlannedSceneFootprint({
    tleLine1: line1,
    tleLine2: line2,
    start: "2024-08-01T14:59:55.000Z",
    end: "2024-08-01T15:00:05.000Z",
    lookSide: "right",
    sceneCenterGroundRangeKm: (nearKm + farKm) / 2,
    sceneCrossTrackKm: 50,
    incidenceAngleMinDeg: 15,
    incidenceAngleMaxDeg: 45,
  });
  assert.ok(result);
  assert.equal(result.fullyWithinIncidenceEnvelope, true);
  assert.ok(result.minimumBoundaryMarginKm > 0);
  assert.equal(result.basis, "tle_sgp4_full_scene_edge_check");
  assert.equal(validateGeoGeometry(result.geometry, { maximumAreaKm2: 25_000_000, rejectUnsplitAntimeridian: true }).ok, true);
});
