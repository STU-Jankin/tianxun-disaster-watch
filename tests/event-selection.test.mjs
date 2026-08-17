import assert from "node:assert/strict";
import test from "node:test";
import { selectFirmsEvents } from "../lib/event-selection.ts";

function event(id, latitude, longitude, magnitude) {
  return {
    id,
    latitude,
    longitude,
    magnitude,
    severity: magnitude >= 100 ? "orange" : "yellow",
    confidenceScore: 80,
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

test("FIRMS ingestion is bounded while reserving geographically distinct cells", () => {
  const crowded = Array.from({ length: 700 }, (_, index) => event(`crowded-${index}`, 10 + index / 10_000, 110 + index / 10_000, 1_000 - index));
  const remote = event("remote-low-frp", -40, -70, 1);
  const selected = selectFirmsEvents([...crowded, remote], 600);
  assert.equal(selected.length, 600);
  assert.ok(selected.some((item) => item.id === remote.id));
  assert.equal(new Set(selected.map((item) => item.id)).size, 600);
});
