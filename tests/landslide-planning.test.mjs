import assert from "node:assert/strict";
import test from "node:test";

async function planning() {
  return import(new URL("../lib/landslide-planning.ts", import.meta.url));
}

test("classifies landslide model, warning and confirmed evidence without treating risk as occurrence", async () => {
  const { deriveLandslideWorkflow } = await planning();
  const base = { hazard: "landslide", source: "USGS Ground Failure", lifecycleStatus: "active", sourcePresence: "current" };
  assert.equal(deriveLandslideWorkflow({ ...base, phenomenonStage: "forecast", dispatchEligibility: "review_required" }).stage, "risk_model");
  assert.equal(deriveLandslideWorkflow({ ...base, phenomenonStage: "warning", dispatchEligibility: "review_required" }).stage, "official_warning");
  assert.equal(deriveLandslideWorkflow({ ...base, phenomenonStage: "observed", dispatchEligibility: "ready" }).stage, "confirmed");
  assert.equal(deriveLandslideWorkflow({ ...base, phenomenonStage: "observed", dispatchEligibility: "ready", sourcePresence: "retained" }).stage, "followup");
  assert.equal(deriveLandslideWorkflow({ ...base, phenomenonStage: "observed", dispatchEligibility: "ready", lifecycleStatus: "resolved" }).stage, "closed");
  assert.equal(deriveLandslideWorkflow({ ...base, hazard: "flood", phenomenonStage: "observed", dispatchEligibility: "ready" }), null);
});

test("builds a bounded 49 point WGS84 terrain grid", async () => {
  const { prepareTerrainSamplingPlan } = await planning();
  const plan = prepareTerrainSamplingPlan({ longitude: 120.2, latitude: 31.5, radiusKm: 3 });
  assert.equal(plan.gridSize, 7);
  assert.equal(plan.points.length, 49);
  assert.equal(plan.spacingKm, 1);
  assert.deepEqual(plan.center, [120.2, 31.5]);
  assert.throws(() => prepareTerrainSamplingPlan({ longitude: 120.2, latitude: 31.5, radiusKm: 21 }), /1–20/);
  assert.throws(() => prepareTerrainSamplingPlan({ longitude: 179.5, latitude: 31.5, radiusKm: 3 }), /日期变更线/);
});

test("derives a conservative MultiPolygon terrain AOI from a sloped grid", async () => {
  const { analyzeTerrainElevations, prepareTerrainSamplingPlan } = await planning();
  const plan = prepareTerrainSamplingPlan({ longitude: 120.2, latitude: 31.5, radiusKm: 3 });
  const elevations = plan.points.map((point) => point.column * 300 + point.row * 40);
  const result = analyzeTerrainElevations(plan, elevations, "2026-08-20T00:00:00.000Z");
  assert.equal(result.state, "ready");
  assert.equal(result.geometry.type, "MultiPolygon");
  assert.equal(result.selectedCellCount, 12);
  assert.ok(result.maximumSlopeDeg > 15);
  assert.equal(result.geometry.coordinates.length, 12);
  assert.match(result.note, /不代表滑坡概率|不代表.*边界/);
});

test("does not invent an AOI for a flat DEM", async () => {
  const { analyzeTerrainElevations, prepareTerrainSamplingPlan } = await planning();
  const plan = prepareTerrainSamplingPlan({ longitude: 120.2, latitude: 31.5, radiusKm: 3 });
  const result = analyzeTerrainElevations(plan, Array(49).fill(100));
  assert.equal(result.state, "flat");
  assert.equal(result.maximumSlopeDeg, 0);
});

test("provides complementary SAR templates with reference imagery requirements", async () => {
  const { landslideSarTemplates } = await planning();
  assert.deepEqual(landslideSarTemplates.map((template) => template.orbitDirectionPreference), ["ascending", "descending"]);
  assert.ok(landslideSarTemplates.every((template) => template.referenceAcquisitionRequired && template.sensors.includes("SAR") && template.revisitCount >= 3));
});
