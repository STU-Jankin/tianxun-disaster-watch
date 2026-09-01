import assert from "node:assert/strict";
import test from "node:test";
import { buildGroundTrack, propagateTle } from "../lib/orbit-simulation.ts";

const line1 = "1 25544U 98067A   24213.62031250  .00016717  00000+0  30289-3 0  9991";
const line2 = "2 25544  51.6400  40.0000 0005000  80.0000 280.0000 15.50000000400000";
const at = new Date("2024-08-01T15:00:00Z");

test("propagates a finite TLE ground position with altitude and direction", () => {
  const position = propagateTle(line1, line2, at);
  assert.ok(position);
  assert.ok(position.latitude >= -90 && position.latitude <= 90);
  assert.ok(position.longitude >= -180 && position.longitude <= 180);
  assert.ok(position.altitudeKm > 100 && position.altitudeKm < 2_000);
  assert.ok(["ascending", "descending"].includes(position.direction));
});

test("splits ground-track polylines at the antimeridian", () => {
  const track = buildGroundTrack(line1, line2, at, 45, 100, 60);
  assert.ok(track.past.length > 0);
  assert.ok(track.future.length > 0);
  for (const segment of [...track.past, ...track.future]) {
    for (let index = 1; index < segment.length; index += 1) assert.ok(Math.abs(segment[index][1] - segment[index - 1][1]) <= 180);
  }
});

const stk11References = [
  {
    noradId: 51832,
    tle: ["1 51832U 22019J   26243.62048257  .00002867  00000+0  13335-3 0  9994", "2 51832  97.3367 304.4692 0007768 336.8155  23.2729 15.20723664249267"],
    samples: [
      ["2026-09-01T00:00:00.000Z", -80.3464956754718, 13.4977265510624, 529.046079256709],
      ["2026-09-03T02:00:00.000Z", 25.1652429414389, 118.089270591617, 512.125007932429],
    ],
  },
  {
    noradId: 56846,
    tle: ["1 56846U 23081A   26243.57551460  .00005668  00000+0  23538-3 0  9991", "2 56846  97.3635 312.3318 0001071  83.5658 276.5702 15.24216828179497"],
    samples: [
      ["2026-09-01T00:00:00.000Z", 11.9685407497383, 154.136737478541, 495.401593321085],
      ["2026-09-03T02:00:00.000Z", 70.939192028544, -79.267754730586, 504.576738263753],
    ],
  },
  {
    noradId: 61231,
    tle: ["1 61231U 24173E   26243.51410359  .00001272  00000+0  63714-4 0  9991", "2 61231  97.4117 314.2688 0001579  90.4656 269.6760 15.19170796107198"],
    samples: [
      ["2026-09-01T00:00:00.000Z", 43.7989522795843, 161.698593011447, 514.210930619685],
      ["2026-09-03T02:00:00.000Z", 2.21396069934708, -55.7236453415308, 510.948530625965],
    ],
  },
  {
    noradId: 64048,
    tle: ["1 64048U 25103A   26243.59301490  .00001598  00000+0  79184-4 0  9996", "2 64048  97.4116 314.7347 0001682  88.2251 271.9176 15.19176548 71529"],
    samples: [
      ["2026-09-01T00:00:00.000Z", 63.6387964418144, -40.1717476178689, 518.230158483247],
      ["2026-09-03T02:00:00.000Z", -67.8461641708366, -36.5221679805279, 534.895393361399],
    ],
  },
  {
    noradId: 69100,
    tle: ["1 69100U 26106D   26243.45539103  .00001807  00000+0  10469-3 0  9996", "2 69100  97.5065 324.2460 0001691  88.0653 272.0772 15.13467790 16353"],
    samples: [
      ["2026-09-01T00:00:00.000Z", 81.3280699572475, -74.6174501820374, 537.926823767815],
      ["2026-09-03T02:00:00.000Z", -82.5116376194186, 49.0720521997862, 555.141592455015],
    ],
  },
];

test("matches the archived STK 11 SGP4/WGS72 reference while keeping it out of runtime orbit input", () => {
  for (const reference of stk11References) {
    for (const [timestamp, latitude, longitude, altitudeKm] of reference.samples) {
      const position = propagateTle(reference.tle[0], reference.tle[1], new Date(timestamp));
      assert.ok(position, `NORAD ${reference.noradId} should propagate at ${timestamp}`);
      assert.ok(groundDistanceKm(position.latitude, position.longitude, latitude, longitude) <= 0.0005, `NORAD ${reference.noradId} should remain within 0.5 m of STK at ${timestamp}`);
      assert.ok(Math.abs(position.altitudeKm - altitudeKm) <= 0.001, `NORAD ${reference.noradId} altitude should remain within 1 m of STK at ${timestamp}`);
    }
  }
});

function groundDistanceKm(latitude1, longitude1, latitude2, longitude2) {
  const radiusKm = 6371.0088;
  const radians = (value) => value * Math.PI / 180;
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = radians(((longitude2 - longitude1 + 180) % 360 + 360) % 360 - 180);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
