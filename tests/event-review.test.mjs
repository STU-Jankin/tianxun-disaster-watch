import assert from "node:assert/strict";
import test from "node:test";

import { canTransitionEventReview, eventAlertVersion, summarizeEventReview } from "../lib/event-review.ts";

test("event review workflow permits deliberate progress and requires reopening a closed review", () => {
  assert.equal(canTransitionEventReview(null, "pending"), true);
  assert.equal(canTransitionEventReview(null, "closed"), false);
  assert.equal(canTransitionEventReview("pending", "verified"), true);
  assert.equal(canTransitionEventReview("verified", "rejected"), false);
  assert.equal(canTransitionEventReview("closed", "reviewing"), true);
});

test("review risk stays undetermined until both cited inputs exist and acknowledgement is version-bound", () => {
  const event = {
    severity: "orange",
    sourceSeverity: "Orange",
    peakSeverity: "orange",
    confidenceScore: 90,
    geometryType: "Polygon",
    locationQuality: "precise",
  };
  const base = {
    masterEventId: "ME-test",
    status: "reviewing",
    assignee: "operator",
    conclusion: "",
    exposure: { index: 80, basis: "人口栅格与医院点位" },
    vulnerability: null,
    alertAcknowledgedAt: "2026-08-31T01:00:00.000Z",
    alertAcknowledgedBy: "operator",
    alertAcknowledgedVersion: eventAlertVersion(event),
    eventRevision: "event-v1",
    revision: 1,
    updatedAt: "2026-08-31T01:00:00.000Z",
    updatedBy: "operator",
  };
  const incomplete = summarizeEventReview(event, base, "event-v1");
  assert.equal(incomplete.impactRisk.status, "screening");
  assert.equal(incomplete.alertAcknowledgedCurrent, true);
  assert.equal(incomplete.stale, false);

  const complete = summarizeEventReview(event, { ...base, vulnerability: { index: 60, basis: "分灾种脆弱性曲线" } }, "event-v2");
  assert.equal(complete.impactRisk.status, "assessed");
  assert.equal(typeof complete.impactRisk.score, "number");
  assert.equal(complete.stale, true);
  assert.equal(summarizeEventReview({ ...event, severity: "red" }, base, "event-v1").alertAcknowledgedCurrent, false);
});
