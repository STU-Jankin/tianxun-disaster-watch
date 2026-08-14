import assert from "node:assert/strict";
import test from "node:test";

async function normalizers() {
  return import(new URL("../lib/source-normalization.ts", import.meta.url));
}

test("FIRMS categorical confidence is not treated as NaN", async () => {
  const { firmsConfidenceScore, firmsHeatSeverity } = await normalizers();
  assert.equal(firmsConfidenceScore("h"), 90);
  assert.equal(firmsConfidenceScore("n"), 60);
  assert.equal(firmsConfidenceScore("l"), 30);
  assert.equal(firmsHeatSeverity(5), "blue");
  assert.equal(firmsHeatSeverity(30), "yellow");
  assert.equal(firmsHeatSeverity(300), "yellow");
});

test("NHC wind thresholds are interpreted in knots", async () => {
  const { cycloneSeverityFromKnots } = await normalizers();
  assert.equal(cycloneSeverityFromKnots(33), "blue");
  assert.equal(cycloneSeverityFromKnots(34), "yellow");
  assert.equal(cycloneSeverityFromKnots(64), "orange");
  assert.equal(cycloneSeverityFromKnots(96), "red");
});

test("track geometry uses the newest timestamp and handles the date line", async () => {
  const { circularGeometryCenter, latestTrackPoint } = await normalizers();
  assert.deepEqual(latestTrackPoint([[120, 20], [121, 21]], ["2026-01-02", "2026-01-01"]), [120, 20]);
  const center = circularGeometryCenter([[179, 10], [-179, 10]]);
  assert.ok(center);
  assert.ok(Math.abs(Math.abs(center[0]) - 180) < 0.01);
  assert.equal(center[1], 10);
});
