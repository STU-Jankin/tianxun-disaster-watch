import assert from "node:assert/strict";
import test from "node:test";
import {
  annotatePlanningWindows,
  assessPlanningOpportunity,
  buildMissionPlanningProblem,
  createUnsolvedMissionSchedule,
} from "../lib/mission-planning.ts";

const task = {
  taskId: "TASK-1",
  eventId: "EVENT-1",
  masterEventId: "MASTER-1",
  revision: 3,
  priority: 92,
  revisitCount: 2,
  imagingStart: "2026-08-24T00:00:00.000Z",
  imagingEnd: "2026-08-25T00:00:00.000Z",
  deliveryDeadline: "2026-08-26T00:00:00.000Z",
  minimumCoveragePercent: 80,
  spatialResolutionMeters: 10,
  incidenceAngleMinDeg: 15,
  incidenceAngleMaxDeg: 45,
  orbitDirectionPreference: "ascending",
};

const opportunity = {
  opportunityId: "ASSUMED-51832-20260824120000-TOPS1",
  satelliteId: "TY-CSAR-2",
  instrumentId: "ty-csar-v2",
  imagingMode: "TOPS 1",
  start: "2026-08-24T12:00:00.000Z",
  end: "2026-08-24T12:00:14.000Z",
  simulationLevel: "assumed_sensor",
  coveragePercent: 100,
  spatialResolutionM: 10,
  incidenceAngleDeg: 30,
  orbitDirection: "ascending",
};

test("turns current assumed-SAR opportunities into explicit conditional planning decisions", () => {
  const assessment = assessPlanningOpportunity(task, opportunity);
  assert.equal(assessment.decision, "conditional");
  assert.equal(assessment.eligibleForTrialSchedule, true);
  assert.equal(assessment.eligibleForDispatch, false);
  assert.deepEqual(assessment.findings.map((finding) => finding.code), ["engineering_constraints_unverified"]);
});

test("returns stable blocking reason codes instead of silently accepting invalid opportunities", () => {
  const assessment = assessPlanningOpportunity(task, {
    ...opportunity,
    start: "2026-08-25T01:00:00.000Z",
    end: "2026-08-25T01:01:00.000Z",
    coveragePercent: 40,
    spatialResolutionM: 20,
    incidenceAngleDeg: 50,
    orbitDirection: "descending",
  });
  assert.equal(assessment.decision, "rejected");
  assert.equal(assessment.eligibleForTrialSchedule, false);
  assert.deepEqual(new Set(assessment.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.code)), new Set([
    "outside_task_window",
    "coverage_below_minimum",
    "resolution_above_maximum",
    "incidence_out_of_range",
    "orbit_direction_mismatch",
  ]));
});

test("keeps TLE-only proximity candidates explicitly unverified", () => {
  const assessment = assessPlanningOpportunity(task, {
    opportunityId: "TLE-51832-A",
    satelliteId: "TY-CSAR-2",
    start: "2026-08-24T12:00:00.000Z",
    end: "2026-08-24T12:00:01.000Z",
    simulationLevel: "orbit_only",
    orbitDirection: "ascending",
  });
  assert.equal(assessment.decision, "conditional");
  assert.ok(assessment.findings.some((finding) => finding.code === "sensor_geometry_unverified"));
  assert.ok(assessment.findings.some((finding) => finding.code === "coverage_unverified"));
});

test("binds a dynamic cyclone opportunity to the forecast slice valid at acquisition time", () => {
  const cycloneTask = { ...task, hazard: "cyclone", timeIndexedAoi: [{}] };
  const valid = assessPlanningOpportunity(cycloneTask, {
    ...opportunity,
    closestApproachAt: "2026-08-24T12:00:07.000Z",
    trackingValidFrom: "2026-08-24T11:30:00.000Z",
    trackingValidTo: "2026-08-24T12:30:00.000Z",
  });
  assert.equal(valid.findings.some((finding) => finding.code.startsWith("dynamic_target_")), false);
  const invalid = assessPlanningOpportunity(cycloneTask, opportunity);
  assert.ok(invalid.findings.some((finding) => finding.code === "dynamic_target_unbound" && finding.severity === "blocking"));
  const exactEnd = assessPlanningOpportunity(cycloneTask, {
    ...opportunity,
    closestApproachAt: "2026-08-24T12:30:00.000Z",
    trackingValidFrom: "2026-08-24T11:30:00.000Z",
    trackingValidTo: "2026-08-24T12:30:00.000Z",
  });
  assert.ok(exactEnd.findings.some((finding) => finding.code === "dynamic_target_time_mismatch"));
});

test("builds versioned problem and unsolved schedule contracts with unique opportunity IDs", () => {
  const annotated = annotatePlanningWindows(task, [opportunity], "2026-08-24T10:00:00.000Z");
  assert.equal(annotated.problem.schemaVersion, "tianxun.planning.problem/v1");
  assert.match(annotated.problem.problemId, /^TASK-1:r3:/);
  assert.equal(annotated.summary.conditional, 1);
  assert.equal(annotated.windows[0].constraintAssessment.decision, "conditional");
  const schedule = createUnsolvedMissionSchedule(annotated.problem, { id: "greedy-baseline", version: "0" });
  assert.equal(schedule.schemaVersion, "tianxun.planning.schedule/v1");
  assert.equal(schedule.state, "not_solved");
  assert.equal(schedule.unassigned[0].reason, "not_solved");
  assert.throws(() => buildMissionPlanningProblem({ task, opportunities: [opportunity, opportunity] }), /候选机会ID重复/);
});
