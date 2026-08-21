import assert from "node:assert/strict";
import test from "node:test";
import { propagateTle } from "../lib/orbit-simulation.ts";
import { representativeAoi, screenTleOpportunities } from "../lib/tle-opportunities.ts";

const line1 = "1 25544U 98067A   24213.62031250  .00016717  00000+0  30289-3 0  9991";
const line2 = "2 25544  51.6400  40.0000 0005000  80.0000 280.0000 15.50000000400000";
const at = new Date("2024-08-01T15:00:00Z");

function satellite() {
  return {
    noradId: 25544,
    interfaceName: "TEST-SAR",
    commonName: "TEST",
    identityStatus: "configured",
    providerName: "TEST",
    tleLine1: line1,
    tleLine2: line2,
    epoch: "2024-08-01T14:53:15.000Z",
    fetchedAt: "2024-08-01T15:00:00.000Z",
    elementAgeHours: 0.1,
    retrievalAgeHours: 0,
    orbitStatus: "current",
    source: "CelesTrak GP",
    sourceUrl: "https://celestrak.org/",
  };
}

test("generates honest TLE-only proximity opportunities near an AOI", () => {
  const position = propagateTle(line1, line2, at);
  assert.ok(position);
  const result = screenTleOpportunities({
    geometry: { type: "Point", coordinates: [position.longitude, position.latitude] },
    imagingStart: new Date(at.getTime() - 20 * 60_000),
    imagingEnd: new Date(at.getTime() + 20 * 60_000),
    satellites: [satellite()],
    orbitDirectionPreference: position.direction,
    searchRadiusKm: 50,
    stepSeconds: 60,
    now: at,
  });
  assert.equal(result.simulationLevel, "orbit_only");
  assert.equal(result.satelliteCount, 1);
  assert.ok(result.windows.length >= 1);
  const closest = result.windows.reduce((best, candidate) => candidate.minimumGroundTrackDistanceKm < best.minimumGroundTrackDistanceKm ? candidate : best);
  assert.ok(closest.minimumGroundTrackDistanceKm < 10);
  assert.equal(closest.satelliteNoradId, 25544);
  assert.equal(closest.orbitDirection, position.direction);
  assert.equal("coveragePercent" in closest, false);
  assert.match(closest.constraintNotes.join(" "), /不代表 SAR 可成像|不是载荷覆盖宽度/);
});

test("uses a circular longitude center for antimeridian AOIs", () => {
  const aoi = representativeAoi({ type: "MultiPolygon", coordinates: [
    [[[179.2, 10], [179.8, 10], [179.8, 11], [179.2, 10]]],
    [[[-179.8, 10], [-179.2, 10], [-179.2, 11], [-179.8, 10]]],
  ] });
  assert.ok(Math.abs(aoi.center.longitude) > 170);
  assert.ok(aoi.radiusKm < 250);
});

test("bounds local screening horizon and excludes stale TLEs", () => {
  assert.throws(() => screenTleOpportunities({
    geometry: { type: "Point", coordinates: [120, 30] },
    imagingStart: at,
    imagingEnd: new Date(at.getTime() + 15 * 24 * 3_600_000),
    satellites: [satellite()],
  }), /不能超过 14 天/);
  assert.throws(() => screenTleOpportunities({
    geometry: { type: "Point", coordinates: [120, 30] },
    imagingStart: at,
    imagingEnd: new Date(at.getTime() + 3_600_000),
    satellites: [{ ...satellite(), orbitStatus: "stale" }],
  }), /没有可用于仿真的当前 TLE/);
});
