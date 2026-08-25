import assert from "node:assert/strict";
import test from "node:test";
import { buildMissionPlanningProblem } from "../lib/mission-planning.ts";
import { normalizeMissionPlanningProblem, runSchedulingComparison, schedulingOpportunityRef } from "../lib/mission-scheduler.ts";

function planningProblem({ taskId, priority, revisits = 1, opportunities }) {
  return buildMissionPlanningProblem({
    generatedAt: "2026-08-24T00:00:00.000Z",
    task: {
      taskId,
      eventId: `EVENT-${taskId}`,
      masterEventId: `MASTER-${taskId}`,
      revision: 1,
      title: `任务 ${taskId}`,
      hazard: "flood",
      priority,
      revisitCount: revisits,
      imagingStart: "2026-08-24T00:00:00.000Z",
      imagingEnd: "2026-08-24T06:00:00.000Z",
      minimumCoveragePercent: 80,
      spatialResolutionMeters: 10,
      orbitDirectionPreference: "either",
    },
    opportunities: opportunities.map((opportunity) => ({
      simulationLevel: "sensor_model",
      coveragePercent: 100,
      spatialResolutionM: 3,
      engineeringConstraintsVerified: true,
      ...opportunity,
    })),
  });
}

test("prioritizes the higher-value task when the same satellite windows conflict", () => {
  const high = planningProblem({ taskId: "HIGH", priority: 95, opportunities: [{ opportunityId: "HIGH-1", satelliteId: "TY-39", start: "2026-08-24T01:00:00.000Z", end: "2026-08-24T01:05:00.000Z" }] });
  const low = planningProblem({ taskId: "LOW", priority: 40, opportunities: [{ opportunityId: "LOW-1", satelliteId: "TY-39", start: "2026-08-24T01:04:00.000Z", end: "2026-08-24T01:08:00.000Z" }] });
  const result = runSchedulingComparison([low, high], { transitionBufferSeconds: 120 });
  assert.deepEqual(result.greedy.assignments.map((assignment) => assignment.taskId), ["HIGH"]);
  assert.deepEqual(result.optimized.assignments.map((assignment) => assignment.taskId), ["HIGH"]);
  assert.equal(result.optimized.unassigned[0].taskId, "LOW");
});

test("keeps independent satellites and non-conflicting revisits in one schedule", () => {
  const revisit = planningProblem({
    taskId: "REVISIT",
    priority: 80,
    revisits: 2,
    opportunities: [
      { opportunityId: "R-1", satelliteId: "TY-39", start: "2026-08-24T01:00:00.000Z", end: "2026-08-24T01:02:00.000Z" },
      { opportunityId: "R-2", satelliteId: "TY-39", start: "2026-08-24T02:00:00.000Z", end: "2026-08-24T02:02:00.000Z" },
    ],
  });
  const parallel = planningProblem({ taskId: "PARALLEL", priority: 60, opportunities: [{ opportunityId: "P-1", satelliteId: "TY-40", start: "2026-08-24T01:00:30.000Z", end: "2026-08-24T01:03:00.000Z" }] });
  const result = runSchedulingComparison([revisit, parallel], { transitionBufferSeconds: 120 });
  assert.equal(result.optimized.summary.assignmentCount, 3);
  assert.equal(result.optimized.summary.unsatisfiedTaskCount, 0);
  assert.ok(result.optimized.objectiveScore >= result.greedy.objectiveScore);
});

test("honors locked, excluded and task-level satellite or mode rules", () => {
  const high = planningProblem({ taskId: "RULE-HIGH", priority: 95, opportunities: [{ opportunityId: "HIGH-1", satelliteId: "TY-39", imagingMode: "聚束模式", start: "2026-08-24T01:00:00.000Z", end: "2026-08-24T01:05:00.000Z" }] });
  const low = planningProblem({ taskId: "RULE-LOW", priority: 40, opportunities: [
    { opportunityId: "LOW-39", satelliteId: "TY-39", imagingMode: "聚束模式", start: "2026-08-24T01:04:00.000Z", end: "2026-08-24T01:08:00.000Z" },
    { opportunityId: "LOW-40", satelliteId: "TY-40", imagingMode: "条带模式", start: "2026-08-24T02:00:00.000Z", end: "2026-08-24T02:04:00.000Z" },
  ] });
  const lockedRef = schedulingOpportunityRef(low.problemId, "LOW-39");
  const result = runSchedulingComparison([high, low], { manualRules: { lockedOpportunityRefs: [lockedRef] } });
  assert.equal(result.optimized.assignments.find((assignment) => assignment.opportunityId === "LOW-39")?.manuallyLocked, true);
  assert.equal(result.optimized.assignments.some((assignment) => assignment.opportunityId === "HIGH-1"), false);

  const forced = runSchedulingComparison([low], { manualRules: {
    excludedOpportunityRefs: [schedulingOpportunityRef(low.problemId, "LOW-39")],
    forcedSatelliteByTask: { "RULE-LOW": "TY-40" },
    forcedImagingModeByTask: { "RULE-LOW": "条带模式" },
  } });
  assert.deepEqual(forced.optimized.assignments.map((assignment) => assignment.opportunityId), ["LOW-40"]);
});

test("rejects contradictory or conflicting manual locks", () => {
  const first = planningProblem({ taskId: "LOCK-A", priority: 70, opportunities: [{ opportunityId: "A-1", satelliteId: "TY-39", start: "2026-08-24T01:00:00.000Z", end: "2026-08-24T01:05:00.000Z" }] });
  const second = planningProblem({ taskId: "LOCK-B", priority: 70, opportunities: [{ opportunityId: "B-1", satelliteId: "TY-39", start: "2026-08-24T01:04:00.000Z", end: "2026-08-24T01:08:00.000Z" }] });
  const firstRef = schedulingOpportunityRef(first.problemId, "A-1");
  const secondRef = schedulingOpportunityRef(second.problemId, "B-1");
  assert.throws(() => runSchedulingComparison([first], { manualRules: { lockedOpportunityRefs: [firstRef], excludedOpportunityRefs: [firstRef] } }), /不能同时锁定和排除/);
  assert.throws(() => runSchedulingComparison([first, second], { manualRules: { lockedOpportunityRefs: [firstRef, secondRef] } }), /锁定机会之间存在/);
});

test("revalidates returned planning problems and detects content tampering", () => {
  const problem = buildMissionPlanningProblem({
    generatedAt: "2026-08-24T00:00:00.000Z",
    task: {
      taskId: "CONDITIONAL",
      eventId: "EVENT-C",
      masterEventId: "MASTER-C",
      revision: 4,
      title: "条件任务",
      hazard: "wildfire",
      priority: 70,
      revisitCount: 1,
      imagingStart: "2026-08-24T00:00:00.000Z",
      imagingEnd: "2026-08-24T06:00:00.000Z",
    },
    opportunities: [{
      opportunityId: "C-1",
      satelliteId: "TY-42",
      start: "2026-08-24T03:00:00.000Z",
      end: "2026-08-24T03:01:00.000Z",
      simulationLevel: "assumed_sensor",
    }],
  });
  const forgedAssessment = structuredClone(problem);
  forgedAssessment.opportunities[0].assessment.decision = "eligible";
  forgedAssessment.opportunities[0].assessment.eligibleForDispatch = true;
  const normalized = normalizeMissionPlanningProblem(forgedAssessment);
  assert.equal(normalized.opportunities[0].assessment.decision, "conditional");
  assert.equal(normalized.opportunities[0].assessment.eligibleForDispatch, false);

  const forgedPriority = structuredClone(problem);
  forgedPriority.task.priority = 100;
  assert.throws(() => normalizeMissionPlanningProblem(forgedPriority), /ID与内容版本不匹配/);
});

test("caps unsafe scheduling input sizes and horizon length", () => {
  const problem = planningProblem({ taskId: "LIMIT", priority: 50, opportunities: [{ opportunityId: "L-1", satelliteId: "TY-50", start: "2026-08-24T01:00:00.000Z", end: "2026-08-24T01:01:00.000Z" }] });
  assert.throws(() => runSchedulingComparison(Array.from({ length: 31 }, (_, index) => ({ ...problem, problemId: `${problem.problemId}-${index}`, task: { ...problem.task, taskId: `LIMIT-${index}` } }))), /最多试排30个任务/);
  const longHorizon = structuredClone(problem);
  longHorizon.horizon.end = "2026-09-24T06:00:00.000Z";
  assert.throws(() => normalizeMissionPlanningProblem(longHorizon), /不能超过14天/);
});
