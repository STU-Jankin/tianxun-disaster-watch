import assert from "node:assert/strict";
import test from "node:test";
import { buildSatelliteOrbitSnapshot, fetchTrackedSatelliteTles, parseTleResponse, trackedSarSatellites } from "../lib/satellite-orbits.ts";
import { sarPayloadProfiles } from "../lib/satellite-payloads.ts";

function checkedLine(value) {
  const base = value.padEnd(68, " ").slice(0, 68);
  let checksum = 0;
  for (const character of base) {
    if (/\d/.test(character)) checksum += Number(character);
    else if (character === "-") checksum += 1;
  }
  return `${base}${checksum % 10}`;
}

function tle(noradId, epoch = "26230.50000000") {
  return [
    `PUBLIC-${noradId}`,
    checkedLine(`1 ${String(noradId).padStart(5, "0")}U 22019J   ${epoch}  .00000000  00000-0  00000-0 0  999`),
    checkedLine(`2 ${String(noradId).padStart(5, "0")}  97.3400 120.0000 0010000  10.0000 350.0000 15.2000000012345`),
  ].join("\n");
}

test("validates catalog identity, checksums and TLE epoch", () => {
  const record = parseTleResponse(tle(51832), 51832, new Date("2026-08-19T00:00:00Z"));
  assert.equal(record.noradId, 51832);
  assert.equal(record.providerName, "PUBLIC-51832");
  assert.equal(record.epoch, "2026-08-18T12:00:00.000Z");
  assert.throws(() => parseTleResponse(tle(51832), 56846), /NORAD编号/);
  const valid = tle(51832);
  const badChecksum = `${valid.slice(0, -1)}${valid.at(-1) === "0" ? "1" : "0"}`;
  assert.throws(() => parseTleResponse(badChecksum, 51832), /校验和/);
});

test("refreshes the configured fleet independently so one missing orbit cannot erase prior data", async () => {
  const redirectModes = [];
  const fetchImpl = async (url, init) => {
    redirectModes.push(init.redirect);
    const id = Number(new URL(url).searchParams.get("CATNR"));
    if (id === 69100) return new Response("No GP data found", { status: 404 });
    return new Response(tle(id), { status: 200, headers: { "Content-Type": "text/plain" } });
  };
  const results = await fetchTrackedSatelliteTles(fetchImpl, new Date("2026-08-19T00:00:00Z"));
  assert.equal(results.length, trackedSarSatellites.length);
  assert.equal(results.filter((item) => item.tle).length, trackedSarSatellites.length - 1);
  assert.match(results.find((item) => item.satellite.noradId === 69100)?.error ?? "", /HTTP 404/);
  assert.deepEqual([...new Set(redirectModes)], ["manual"]);
});

test("marks old elements stale while retaining their last valid TLE", () => {
  const old = parseTleResponse(tle(51832, "26200.00000000"), 51832, new Date("2026-08-18T00:00:00Z"));
  const snapshot = buildSatelliteOrbitSnapshot([{ noradId: 51832, tle: old, lastAttemptAt: "2026-08-19T00:00:00Z", lastSuccessAt: "2026-08-18T00:00:00Z", lastError: "latest refresh failed" }], new Date("2026-08-19T00:00:00Z"));
  const satellite = snapshot.find((item) => item.noradId === 51832);
  assert.equal(satellite?.orbitStatus, "stale");
  assert.equal(satellite?.tleLine1, old.tleLine1);
  assert.equal(snapshot.find((item) => item.noradId === 58918)?.identityStatus, "unverified");
});

test("binds TY-50 to the user-provided XSAR profile and keeps CSAR parameters independent", () => {
  const ty50 = trackedSarSatellites.find((item) => item.noradId === 69100);
  assert.equal(ty50?.commonName, "TY-50");
  assert.equal(ty50?.commonCode, "电建一号");
  assert.equal(ty50?.payloadProfileId, "ty-xsar-v1");
  const xsar = sarPayloadProfiles["ty-xsar-v1"];
  const csar = sarPayloadProfiles["ty-csar-v2"];
  assert.equal(xsar.payloadType, "XSAR");
  assert.equal(xsar.frequencyBand, "X");
  assert.deepEqual(xsar.lookSides, ["left", "right"]);
  assert.deepEqual(xsar.incidenceAngleDeg, { min: 17, max: 50 });
  assert.equal(xsar.parameterStatus, "user_provided");
  assert.deepEqual(xsar.polarizations, ["VV"]);
  assert.deepEqual(xsar.productLevels, []);
  assert.deepEqual(
    xsar.imagingModes.map(({ id, resolutionM, nominalSceneCrossTrackKm, nominalSceneAlongTrackKm }) => ({ id, resolutionM, nominalSceneCrossTrackKm, nominalSceneAlongTrackKm })),
    [
      { id: "spotlight", resolutionM: 0.5, nominalSceneCrossTrackKm: 5, nominalSceneAlongTrackKm: 5 },
      { id: "stripmap", resolutionM: 3, nominalSceneCrossTrackKm: 30, nominalSceneAlongTrackKm: 30 },
      { id: "tops_1", resolutionM: 15, nominalSceneCrossTrackKm: 100, nominalSceneAlongTrackKm: 100 },
      { id: "tops_2", resolutionM: 30, nominalSceneCrossTrackKm: 240, nominalSceneAlongTrackKm: 240 },
    ],
  );
  assert.equal(csar.imagingModes[0].resolutionLabel, "1×0.5 m");
  assert.deepEqual(csar.imagingModes[0].resolutionDimensionsM, [1, 0.5]);
  assert.deepEqual(csar.productLevels.map(({ level, code }) => ({ level, code })), [{ level: "L1", code: "SLC" }, { level: "L2", code: "ORG" }]);
  const snapshot = buildSatelliteOrbitSnapshot([], new Date("2026-08-19T00:00:00Z"));
  assert.equal(snapshot.find((item) => item.noradId === 69100)?.payloadProfile?.id, "ty-xsar-v1");
});
