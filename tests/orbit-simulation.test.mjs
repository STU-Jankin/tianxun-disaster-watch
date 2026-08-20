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
