import test from "node:test";
import assert from "node:assert/strict";

import {
  cycloneTrackingGeometry,
  cycloneTrackingSliceAt,
} from "../lib/cyclone-tracking-target.ts";

const slices = [
  {
    validFrom: "2026-08-24T00:00:00.000Z",
    validTo: "2026-08-24T01:00:00.000Z",
    leadHours: 12,
    center: [122, 19],
    centerBasis: "official_node",
    thresholdKnots: 34,
    windGeometry: { type: "Polygon", coordinates: [[[121, 18], [123, 18], [123, 20], [121, 18]]] },
  },
  {
    validFrom: "2026-08-24T01:00:00.000Z",
    validTo: "2026-08-24T02:00:00.000Z",
    leadHours: 13,
    center: [123.5, 20.25],
    centerBasis: "interpolated_official_track",
    uncertaintyGeometry: { type: "Polygon", coordinates: [[[122, 19], [125, 19], [125, 22], [122, 19]]] },
  },
];

test("map preview resolves the forecast slice at the selected acquisition time", () => {
  const selected = cycloneTrackingSliceAt(slices, "2026-08-24T01:23:00.000Z");
  assert.equal(selected, slices[1]);
  assert.deepEqual(cycloneTrackingGeometry(selected, "center"), {
    type: "Point",
    coordinates: [123.5, 20.25],
  });
  assert.equal(cycloneTrackingGeometry(selected, "uncertainty_area"), slices[1].uncertaintyGeometry);
});

test("an exact hourly boundary belongs only to the new forecast slice", () => {
  assert.equal(cycloneTrackingSliceAt(slices, "2026-08-24T01:00:00.000Z"), slices[1]);
});

test("tracking geometry does not silently fall back to a different target type", () => {
  assert.equal(cycloneTrackingGeometry(slices[1], "wind_field"), null);
});
