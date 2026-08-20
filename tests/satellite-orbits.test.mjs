import assert from "node:assert/strict";
import test from "node:test";
import { buildSatelliteOrbitSnapshot, fetchTrackedSatelliteTles, parseTleResponse, trackedSarSatellites } from "../lib/satellite-orbits.ts";

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
