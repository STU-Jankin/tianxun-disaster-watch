import assert from "node:assert/strict";
import test from "node:test";
import { groundReachForIncidence, sarLookGeometry, screenConfiguredSarOpportunities } from "../lib/configured-sar-opportunities.ts";
import { propagateTle } from "../lib/orbit-simulation.ts";
import { sarPayloadProfiles } from "../lib/satellite-payloads.ts";

const EARTH_RADIUS_KM = 6371.0088;

function checkedLine(value) {
  const base = value.padEnd(68, " ").slice(0, 68);
  let checksum = 0;
  for (const character of base) {
    if (/\d/.test(character)) checksum += Number(character);
    else if (character === "-") checksum += 1;
  }
  return `${base}${checksum % 10}`;
}

function tle(noradId) {
  return {
    line1: checkedLine(`1 ${String(noradId).padStart(5, "0")}U 22019J   26230.50000000  .00000000  00000-0  00000-0 0  999`),
    line2: checkedLine(`2 ${String(noradId).padStart(5, "0")}  97.3400 120.0000 0010000  10.0000 350.0000 15.2000000012345`),
  };
}

function bearing(latitude1, longitude1, latitude2, longitude2) {
  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;
  const deltaLon = (longitude2 - longitude1) * Math.PI / 180;
  return (Math.atan2(Math.sin(deltaLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)) * 180 / Math.PI + 360) % 360;
}

function destination(latitude, longitude, bearingDeg, distanceKm) {
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearingRad = bearingDeg * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearingRad));
  const lon2 = lon1 + Math.atan2(Math.sin(bearingRad) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: lat2 * 180 / Math.PI, longitude: ((lon2 * 180 / Math.PI + 540) % 360) - 180 };
}

test("round-trips configured ground incidence through spherical Earth geometry", () => {
  for (const incidence of [15, 17, 45, 50]) {
    const distance = groundReachForIncidence(500, incidence);
    const geometry = sarLookGeometry(500, distance);
    assert.ok(Math.abs(geometry.incidenceAngleDeg - incidence) < 1e-8);
    assert.ok(geometry.offNadirAngleDeg < geometry.incidenceAngleDeg);
  }
});

test("creates mode-level assumed sensor opportunities from a current TLE and CSAR profile", () => {
  const centerAt = new Date("2026-08-18T12:00:00.000Z");
  const lines = tle(51832);
  const center = propagateTle(lines.line1, lines.line2, centerAt);
  const before = propagateTle(lines.line1, lines.line2, new Date(centerAt.getTime() - 10_000));
  const after = propagateTle(lines.line1, lines.line2, new Date(centerAt.getTime() + 10_000));
  assert.ok(center && before && after);
  const trackBearing = bearing(before.latitude, before.longitude, after.latitude, after.longitude);
  const target = destination(center.latitude, center.longitude, trackBearing + 90, 300);
  const satellite = {
    noradId: 51832,
    interfaceName: "TY-CSAR-2",
    commonName: "TY-39",
    commonCode: "巢湖一号",
    identityStatus: "configured",
    payloadProfileId: "ty-csar-v2",
    payloadProfile: sarPayloadProfiles["ty-csar-v2"],
    tleLine1: lines.line1,
    tleLine2: lines.line2,
    epoch: centerAt.toISOString(),
    fetchedAt: centerAt.toISOString(),
    orbitStatus: "current",
    source: "CelesTrak GP",
    sourceUrl: "https://example.test/tle",
  };
  const result = screenConfiguredSarOpportunities({
    geometry: { type: "Point", coordinates: [target.longitude, target.latitude] },
    imagingStart: new Date(centerAt.getTime() - 600_000),
    imagingEnd: new Date(centerAt.getTime() + 600_000),
    satellites: [satellite],
    incidenceAngleMinDeg: 15,
    incidenceAngleMaxDeg: 45,
    spatialResolutionMeters: 20,
    minimumCoveragePercent: 80,
    sarImagingModeIds: ["spotlight", "tops_1"],
    now: centerAt,
  });
  assert.equal(result.simulationLevel, "assumed_sensor");
  assert.equal(result.windows.length, 2);
  assert.deepEqual(new Set(result.windows.map((window) => window.imagingMode)), new Set(["聚束模式", "TOPS 1"]));
  for (const window of result.windows) {
    assert.equal(window.parameterStatus, "user_provided");
    assert.match(window.orbitVersion, /:payload:ty-csar-v2$/);
    assert.equal(window.lookSide, "right");
    assert.ok(window.incidenceAngleDeg >= 15 && window.incidenceAngleDeg <= 45);
    assert.equal(window.coveragePercent, 100);
    assert.deepEqual(window.polarizations, ["VV"]);
    assert.deepEqual(window.productLevels.map(({ level, code }) => ({ level, code })), [{ level: "L1", code: "SLC" }, { level: "L2", code: "ORG" }]);
    assert.equal(window.footprintGeometry.type, "Polygon");
    assert.match(window.constraintNotes.join(" "), /不得自动下发/);
  }
});
