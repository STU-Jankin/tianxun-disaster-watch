import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExposureAoi,
  exposureAssessmentStatus,
  exposureRiskInput,
  parseOverpassExposure,
  parseWorldPopTask,
  partitionExposureGeometry,
  prepareOverpassExposureQuery,
  worldPopRequestPlan,
} from "../lib/exposure-assessment.ts";
import { assessImpactRisk } from "../lib/impact-risk.ts";

function pointEvent(overrides = {}) {
  return {
    id: "event-1",
    masterEventId: "ME-event-1",
    entityKey: "entity-1",
    title: "测试滑坡",
    hazard: "landslide",
    latitude: 30,
    longitude: 102,
    locationAccuracyKm: 2,
    geometry: { type: "Point", coordinates: [102, 30] },
    severity: "orange",
    sourceSeverity: "Orange",
    confidenceScore: 90,
    geometryType: "Point",
    locationQuality: "precise",
    ...overrides,
  };
}

test("derives a labelled hazard buffer and prepares a bounded polygon Overpass query", () => {
  const aoi = buildExposureAoi(pointEvent());
  assert.equal(aoi.basis, "derived_screening_buffer");
  assert.match(aoi.label, /10 km/);
  assert.ok(aoi.areaKm2 > 300 && aoi.areaKm2 < 320);
  const plan = prepareOverpassExposureQuery(aoi);
  assert.equal(plan.state, "ready");
  assert.match(plan.query, /\(poly:"/);
  assert.doesNotMatch(plan.query, /\(30,102,/);
  assert.match(plan.queryBasis, /AOI 外环/);
});

test("uses official polygon geometry when available and enforces provider area limits", () => {
  const event = pointEvent({
    geometryType: "Polygon",
    geometry: { type: "Polygon", coordinates: [[[102, 30], [102.1, 30], [102.1, 30.1], [102, 30.1], [102, 30]]] },
  });
  const aoi = buildExposureAoi(event);
  assert.equal(aoi.basis, "official_event_geometry");
  assert.ok(aoi.areaKm2 > 100);
  assert.equal(prepareOverpassExposureQuery({ ...aoi, areaKm2: 2_501 }).state, "skipped");
  const chinaPlan = prepareOverpassExposureQuery({ ...aoi, areaKm2: 31_326 }, { maximumAreaKm2: 50_000, serviceLabel: "中国 OSM 日更镜像", queryTimeoutSeconds: 45 });
  assert.equal(chinaPlan.state, "ready");
  assert.match(chinaPlan.query, /\[timeout:45\]/);
});

test("partitions a large official impact polygon without changing its total area", () => {
  const event = pointEvent({
    geometryType: "Polygon",
    geometry: { type: "Polygon", coordinates: [[[100, 20], [104, 20], [104, 23], [100, 23], [100, 20]]] },
  });
  const aoi = buildExposureAoi(event);
  assert.ok(aoi.areaKm2 > 100_000);
  const worldPopPlan = worldPopRequestPlan(aoi, 2026);
  assert.equal(worldPopPlan.state, "ready");
  assert.ok(worldPopPlan.chunks.length >= 3);
  assert.ok(worldPopPlan.chunks.every((chunk) => chunk.areaKm2 <= 50_000));
  const chunks = partitionExposureGeometry(aoi.geometry, 45_000);
  assert.ok(chunks.length >= 3);
  const plans = chunks.map((geometry) => buildExposureAoi(pointEvent({ geometryType: geometry.type, geometry })));
  assert.ok(plans.every((chunk) => chunk.areaKm2 <= 45_000));
  const combinedArea = plans.reduce((sum, chunk) => sum + chunk.areaKm2, 0);
  assert.ok(Math.abs(combinedArea - aoi.areaKm2) / aoi.areaKm2 < 0.005);
});

test("parses ordered Overpass counts and classifies locatable key facilities", () => {
  const result = parseOverpassExposure({
    osm3s: { timestamp_osm_base: "2026-08-31T00:00:00Z" },
    elements: [
      { type: "count", tags: { total: "120" } },
      { type: "count", tags: { total: "45" } },
      { type: "count", tags: { total: "4" } },
      { type: "node", id: 1, lat: 30.1, lon: 102.1, tags: { amenity: "hospital", name: "县医院" } },
      { type: "way", id: 2, center: { lat: 30.2, lon: 102.2 }, tags: { power: "substation" } },
      { type: "relation", id: 3, center: { lat: 30.3, lon: 102.3 }, tags: { man_made: "water_works" } },
    ],
  });
  assert.equal(result.mappedBuildingCount, 120);
  assert.equal(result.mappedRoadWayCount, 45);
  assert.equal(result.mappedKeyFacilityCount, 4);
  assert.deepEqual(result.facilities.map((item) => item.kind), ["health", "power", "water"]);
  assert.equal(result.facilitiesTruncated, true);
  assert.equal(result.osmBaseTimestamp, "2026-08-31T00:00:00Z");
});

test("population parser preserves year and automatic exposure never treats missing OSM as absence", () => {
  const population = parseWorldPopTask({ status: "finished", result: { total_population: 125000, population_density: 860, data_year: 2025, data_source: "WorldPop" } }, 2026, "100m");
  assert.equal(population.state, "ready");
  assert.equal(population.year, 2025);
  const unavailableOsm = { state: "unavailable", provider: "OpenStreetMap · Overpass", facilityCounts: {}, facilities: [], facilitiesTruncated: false, message: "offline" };
  const mappedOsm = { ...unavailableOsm, state: "ready", mappedBuildingCount: 3000, mappedRoadWayCount: 600, mappedKeyFacilityCount: 40 };
  const baseline = exposureRiskInput(population, unavailableOsm);
  const enriched = exposureRiskInput(population, mappedOsm);
  assert.ok(baseline.index > 0);
  assert.ok(enriched.index >= baseline.index);
  assert.match(baseline.basis, /未作为降低暴露度的依据/);
  assert.equal(exposureAssessmentStatus(population, unavailableOsm), "partial");
});

test("automatic exposure feeds screening without a manual review dependency", () => {
  const event = pointEvent();
  const result = assessImpactRisk({ ...event, exposure: { index: 68, basis: "自动人口与设施筛查" } });
  assert.equal(result.exposureIndex, 68);
  assert.equal(result.status, "screening");
  assert.ok(result.missingInputs.includes("承灾体脆弱性模型"));
});

test("WorldPop pending tasks retain their task id for idempotent polling", () => {
  const pending = parseWorldPopTask({ task_id: "task-123", status: "pending" }, 2026, "1km");
  assert.equal(pending.state, "pending");
  assert.equal(pending.taskId, "task-123");
});
