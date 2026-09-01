import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDetectionBenchmarks } from "../lib/evaluation-center.ts";

const benchmark = (overrides = {}) => ({
  caseId: "benchmark-verified-001",
  title: "权威核验地震样本",
  hazard: "earthquake",
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
