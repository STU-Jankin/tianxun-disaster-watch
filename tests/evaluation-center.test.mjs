import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDetectionBenchmarks } from "../lib/evaluation-center.ts";

const benchmark = (overrides = {}) => ({
  caseId: "benchmark-verified-001",
  title: "权威核验地震样本",
  hazard: "earthquake",
  objective: "event_detection",
  occurredAt: "2026-09-01T00:15:00.000Z",
  latitude: 31,
  longitude: 120,
  locationToleranceKm: 30,
  eventTimeToleranceHours: 2,
  acceptedLeadMinutes: 0,
  detectionDeadlineMinutes: 60,
  expectedSeverity: "orange",
  provenanceUrl: "https://example.test/official/1",
  notes: "",
  verificationStatus: "verified",
  createdBy: "tester",
  createdAt: "2026-09-01T02:00:00.000Z",
  updatedAt: "2026-09-01T02:00:00.000Z",
  ...overrides,
});

const forecastBenchmark = (overrides = {}) => benchmark({
  caseId: "benchmark-forecast-001",
  title: "权威核验泥石流样本",
  hazard: "landslide",
  objective: "landslide_forecast",
  hazardSubtype: "debris_flow",
  occurredAt: "2026-09-01T12:00:00.000Z",
  latitude: 29.5,
  longitude: 90.5,
  locationToleranceKm: 20,
  eventTimeToleranceHours: 24,
  acceptedLeadMinutes: 1_440,
  detectionDeadlineMinutes: 60,
  minimumForecastRiskPercent: 80,
  requiredSource: "NASA LHASA",
  expectedSeverity: undefined,
  ...overrides,
});

const forecastEvent = (overrides = {}) => event({
  id: "lhasa-event-1",
  masterEventId: "ME-lhasa-event-1",
  title: "NASA LHASA 高滑坡风险区 · 92%",
  hazard: "landslide",
  occurredAt: "2026-08-31T12:00:00.000Z",
  latitude: 29.5,
  longitude: 90.5,
  phenomenonStage: "forecast",
  validFrom: "2026-08-31T12:00:00.000Z",
  validTo: "2026-09-01T12:00:00.000Z",
  geometry: { type: "Polygon", coordinates: [[[90, 29], [91, 29], [91, 30], [90, 30], [90, 29]]] },
  severity: "orange",
  source: "NASA LHASA",
  sourceSeverity: "LHASA 92%",
  magnitude: 92,
  magnitudeUnit: "%",
  evidence: [{ source: "NASA LHASA" }],
  ...overrides,
});

const event = (overrides = {}) => ({
  id: "event-1",
  masterEventId: "ME-earthquake-1",
  title: "测试地震",
  hazard: "earthquake",
  occurredAt: "2026-09-01T00:16:00.000Z",
  latitude: 31.05,
  longitude: 120.05,
  severity: "yellow",
  source: "权威测试源",
  evidence: [{ source: "权威测试源" }],
  ...overrides,
});

test("scores verified detections without inventing precision", () => {
  const report = evaluateDetectionBenchmarks({
    runId: "evaluation-run-1",
    computedAt: "2026-09-01T02:00:00.000Z",
    cases: [benchmark()],
    candidatesByCase: {
      "benchmark-verified-001": [{ snapshotId: "snapshot-1", capturedAt: "2026-09-01T00:30:00.000Z", event: event() }],
    },
    snapshotTimes: ["2026-09-01T00:00:00.000Z", "2026-09-01T00:30:00.000Z", "2026-09-01T01:00:00.000Z", "2026-09-01T01:30:00.000Z"],
    sourceReliability: [{ sourceId: "source-1", name: "测试源", attempts: 4, successfulAttempts: 3, successRatePercent: 75, averageDurationMs: 100 }],
  });
  assert.equal(report.metrics.recallPercent, 100);
  assert.equal(report.metrics.precisionAvailable, false);
  assert.equal(report.results[0].status, "detected");
  assert.equal(report.results[0].latencyMinutes, 15);
  assert.equal(report.results[0].severityMet, false);
  assert.ok(report.results[0].locationErrorKm > 0);
});

test("counts a miss only when the replay window is continuous", () => {
  const complete = evaluateDetectionBenchmarks({
    runId: "evaluation-run-complete",
    computedAt: "2026-09-01T02:00:00.000Z",
    cases: [benchmark()],
    candidatesByCase: {},
    snapshotTimes: ["2026-09-01T00:00:00.000Z", "2026-09-01T00:30:00.000Z", "2026-09-01T01:00:00.000Z", "2026-09-01T01:30:00.000Z"],
  });
  assert.equal(complete.results[0].status, "missed");
  assert.equal(complete.metrics.missedCases, 1);

  const gap = evaluateDetectionBenchmarks({
    runId: "evaluation-run-gap",
    computedAt: "2026-09-01T04:00:00.000Z",
    cases: [benchmark({ detectionDeadlineMinutes: 180 })],
    candidatesByCase: {},
    snapshotTimes: ["2026-09-01T00:00:00.000Z", "2026-09-01T03:30:00.000Z"],
  });
  assert.equal(gap.results[0].status, "insufficient_history");
  assert.equal(gap.metrics.eligibleCases, 0);
  assert.equal(gap.metrics.recallPercent, null);
});

test("keeps draft and not-yet-due cases out of formal recall", () => {
  const report = evaluateDetectionBenchmarks({
    runId: "evaluation-run-pending",
    computedAt: "2026-09-01T00:30:00.000Z",
    cases: [benchmark({ caseId: "benchmark-draft-001", verificationStatus: "draft" }), benchmark({ caseId: "benchmark-pending-001", detectionDeadlineMinutes: 120 })],
    candidatesByCase: {},
    snapshotTimes: ["2026-09-01T00:00:00.000Z", "2026-09-01T00:30:00.000Z"],
  });
  assert.equal(report.results.find((item) => item.caseId === "benchmark-draft-001").status, "draft");
  assert.equal(report.results.find((item) => item.caseId === "benchmark-pending-001").status, "pending");
  assert.equal(report.metrics.eligibleCases, 0);
});

test("evaluates verified landslide forecasts as pre-event geometry hits", () => {
  const report = evaluateDetectionBenchmarks({
    runId: "evaluation-run-forecast",
    computedAt: "2026-09-01T13:00:00.000Z",
    cases: [forecastBenchmark()],
    candidatesByCase: {
      "benchmark-forecast-001": [{ snapshotId: "snapshot-forecast", capturedAt: "2026-08-31T14:00:00.000Z", event: forecastEvent() }],
    },
    snapshotTimes: Array.from({ length: 24 }, (_, index) => new Date(Date.parse("2026-08-31T12:00:00.000Z") + index * 60 * 60_000).toISOString()),
    sourceSuccessTimesByCase: { "benchmark-forecast-001": ["2026-08-31T12:10:00.000Z"] },
  });
  assert.equal(report.metrics.recallPercent, null, "forecast cases must not be mixed into detection recall");
  assert.equal(report.metrics.forecastHitRatePercent, 100);
  assert.equal(report.metrics.medianForecastLeadMinutes, 1_320);
  assert.equal(report.results[0].status, "detected");
  assert.equal(report.results[0].spatialMatch, "geometry_contains");
  assert.equal(report.results[0].forecastRiskPercent, 92);
});

test("does not call a landslide forecast miss when the required source was unavailable", () => {
  const report = evaluateDetectionBenchmarks({
    runId: "evaluation-run-forecast-source-gap",
    computedAt: "2026-09-01T13:00:00.000Z",
    cases: [forecastBenchmark()],
    candidatesByCase: {},
    snapshotTimes: Array.from({ length: 24 }, (_, index) => new Date(Date.parse("2026-08-31T12:00:00.000Z") + index * 60 * 60_000).toISOString()),
    sourceSuccessTimesByCase: {},
  });
  assert.equal(report.results[0].status, "insufficient_history");
  assert.equal(report.metrics.forecastEligibleCases, 0);
});
