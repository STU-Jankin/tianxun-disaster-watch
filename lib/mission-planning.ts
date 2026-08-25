import { aoiFingerprint } from "./event-integrity.ts";

export const planningConstraintCodes = [
  "invalid_opportunity_window",
  "outside_task_window",
  "coverage_below_minimum",
  "coverage_unverified",
  "resolution_above_maximum",
  "resolution_unverified",
  "incidence_out_of_range",
  "incidence_unverified",
  "orbit_direction_mismatch",
  "orbit_direction_unverified",
  "dynamic_target_unbound",
  "dynamic_target_time_mismatch",
  "sensor_geometry_unverified",
  "engineering_constraints_unverified",
] as const;

export type PlanningConstraintCode = (typeof planningConstraintCodes)[number];
export type PlanningConstraintSeverity = "blocking" | "unverified";
export type PlanningDecision = "eligible" | "conditional" | "rejected";
export type PlanningSimulationLevel = "orbit_only" | "assumed_sensor" | "sensor_model";

export type PlanningConstraintFinding = {
  code: PlanningConstraintCode;
  severity: PlanningConstraintSeverity;
  message: string;
  actual?: number | string;
  required?: number | string;
};

export type PlanningConstraintAssessment = {
  schemaVersion: "tianxun.planning.constraint-assessment/v1";
  decision: PlanningDecision;
  eligibleForTrialSchedule: boolean;
  eligibleForDispatch: boolean;
  blockingCount: number;
  unverifiedCount: number;
  findings: PlanningConstraintFinding[];
};

export type PlanningOpportunityInput = {
  opportunityId: string;
  satelliteId: string;
  instrumentId?: string;
  imagingMode?: string;
  start: string;
  end: string;
  simulationLevel?: PlanningSimulationLevel;
  coveragePercent?: number;
  spatialResolutionM?: number;
  incidenceAngleDeg?: number;
  orbitDirection?: "ascending" | "descending";
  closestApproachAt?: string;
  trackingValidFrom?: string;
  trackingValidTo?: string;
  engineeringConstraintsVerified?: boolean;
};

export type MissionPlanningProblem = {
  schemaVersion: "tianxun.planning.problem/v1";
  problemId: string;
  generatedAt: string;
  horizon: { start: string; end: string };
  task: {
    taskId: string;
    eventId: string;
    masterEventId: string;
    revision: number;
    title: string;
    hazard: string;
    dynamicTarget: boolean;
    priority: number;
    requiredRevisits: number;
    deliveryDeadline?: string;
    requirements: {
      minimumCoveragePercent?: number;
      maximumSpatialResolutionM?: number;
      incidenceAngleDeg?: { min: number; max: number };
      orbitDirection: "ascending" | "descending" | "either";
    };
  };
  opportunities: Array<{
    opportunityId: string;
    satelliteId: string;
    instrumentId?: string;
    imagingMode?: string;
    start: string;
    end: string;
    simulationLevel: PlanningSimulationLevel;
    coveragePercent?: number;
    spatialResolutionM?: number;
    incidenceAngleDeg?: number;
    orbitDirection?: "ascending" | "descending";
    closestApproachAt?: string;
    trackingValidFrom?: string;
    trackingValidTo?: string;
    engineeringConstraintsVerified?: boolean;
    assessment: PlanningConstraintAssessment;
  }>;
};

export type MissionPlanningSummary = {
  total: number;
  eligible: number;
  conditional: number;
  rejected: number;
  dispatchable: number;
};

export type MissionPlanningSchedule = {
  schemaVersion: "tianxun.planning.schedule/v1";
  problemId: string;
  generatedAt: string;
  algorithm: { id: string; version: string };
  state: "not_solved" | "feasible" | "infeasible";
  assignments: Array<{
    taskId: string;
    opportunityId: string;
    satelliteId: string;
    start: string;
    end: string;
  }>;
  unassigned: Array<{
    taskId: string;
    reason: "not_solved" | "no_feasible_opportunity";
  }>;
};

type PlanningTaskInput = Record<string, unknown>;

export function assessPlanningOpportunity(task: PlanningTaskInput, opportunity: PlanningOpportunityInput): PlanningConstraintAssessment {
  const findings: PlanningConstraintFinding[] = [];
  const taskStart = timestamp(task.imagingStart);
  const taskEnd = timestamp(task.imagingEnd);
  const opportunityStart = timestamp(opportunity.start);
  const opportunityEnd = timestamp(opportunity.end);

  if (opportunityStart === null || opportunityEnd === null || opportunityEnd <= opportunityStart) {
    findings.push(blocking("invalid_opportunity_window", "候选机会的开始或结束时间无效"));
  } else if (taskStart === null || taskEnd === null || opportunityStart < taskStart || opportunityEnd > taskEnd) {
    findings.push(blocking("outside_task_window", "候选机会不在任务成像时间窗内"));
  }

  compareMinimum(
    findings,
    numberOrNull(task.minimumCoveragePercent),
    numberOrNull(opportunity.coveragePercent),
    "coverage_below_minimum",
    "coverage_unverified",
    "候选覆盖率低于任务要求",
    "候选机会尚未验证覆盖率",
    "%",
  );
  compareMaximum(
    findings,
    numberOrNull(task.spatialResolutionMeters),
    numberOrNull(opportunity.spatialResolutionM),
    "resolution_above_maximum",
    "resolution_unverified",
    "候选空间分辨率不满足任务要求",
    "候选机会尚未验证空间分辨率",
    " m",
  );

  const incidenceMinimum = numberOrNull(task.incidenceAngleMinDeg);
  const incidenceMaximum = numberOrNull(task.incidenceAngleMaxDeg);
  const incidence = numberOrNull(opportunity.incidenceAngleDeg);
  if (incidenceMinimum !== null && incidenceMaximum !== null) {
    if (incidence === null) findings.push(unverified("incidence_unverified", "候选机会尚未验证地面入射角", `${incidenceMinimum}°～${incidenceMaximum}°`));
    else if (incidence < incidenceMinimum || incidence > incidenceMaximum) findings.push(blocking("incidence_out_of_range", "候选地面入射角超出任务范围", incidence, `${incidenceMinimum}°～${incidenceMaximum}°`));
  }

  const requiredDirection = direction(task.orbitDirectionPreference);
  if (requiredDirection !== "either") {
    if (!opportunity.orbitDirection) findings.push(unverified("orbit_direction_unverified", "候选机会尚未验证升降轨方向", requiredDirection));
    else if (opportunity.orbitDirection !== requiredDirection) findings.push(blocking("orbit_direction_mismatch", "候选轨向不符合任务偏好", opportunity.orbitDirection, requiredDirection));
  }

  const dynamicCyclone = task.hazard === "cyclone" && Array.isArray(task.timeIndexedAoi) && task.timeIndexedAoi.length > 0;
  if (dynamicCyclone) {
    const trackingStart = timestamp(opportunity.trackingValidFrom);
    const trackingEnd = timestamp(opportunity.trackingValidTo);
    const acquisition = timestamp(opportunity.closestApproachAt ?? opportunity.start);
    if (trackingStart === null || trackingEnd === null) {
      findings.push(blocking("dynamic_target_unbound", "台风候选机会没有绑定有效时刻对应的预测AOI"));
    } else if (acquisition === null || acquisition < trackingStart || acquisition >= trackingEnd) {
      findings.push(blocking("dynamic_target_time_mismatch", "卫星成像时刻与台风预测片不匹配"));
    }
  }

  const simulationLevel = opportunity.simulationLevel ?? "sensor_model";
  if (simulationLevel === "orbit_only") {
    findings.push(unverified("sensor_geometry_unverified", "当前仅完成轨道近接筛查，尚未验证真实载荷指向和成像足迹"));
  }
  if (simulationLevel !== "orbit_only" && opportunity.engineeringConstraintsVerified !== true) {
    findings.push(unverified("engineering_constraints_unverified", "尚未验证姿态机动、稳定时间、功耗、存储、热控和模式切换约束"));
  }

  const blockingCount = findings.filter((finding) => finding.severity === "blocking").length;
  const unverifiedCount = findings.filter((finding) => finding.severity === "unverified").length;
  const decision: PlanningDecision = blockingCount ? "rejected" : unverifiedCount ? "conditional" : "eligible";
  return {
    schemaVersion: "tianxun.planning.constraint-assessment/v1",
    decision,
    eligibleForTrialSchedule: decision !== "rejected",
    eligibleForDispatch: decision === "eligible",
    blockingCount,
    unverifiedCount,
    findings,
  };
}

export function buildMissionPlanningProblem(input: {
  task: PlanningTaskInput;
  opportunities: PlanningOpportunityInput[];
  generatedAt?: string | Date;
}): MissionPlanningProblem {
  const taskId = requiredText(input.task.taskId, "任务缺少 taskId");
  const eventId = requiredText(input.task.eventId, "任务缺少 eventId");
  const masterEventId = requiredText(input.task.masterEventId, "任务缺少 masterEventId");
  const horizonStart = requiredIso(input.task.imagingStart, "任务成像开始时间无效");
  const horizonEnd = requiredIso(input.task.imagingEnd, "任务成像结束时间无效");
  if (Date.parse(horizonEnd) <= Date.parse(horizonStart)) throw new Error("任务成像时间窗无效");
  const generatedAt = requiredIso(input.generatedAt ?? new Date(), "规划问题生成时间无效");
  if (input.opportunities.length > 100) throw new Error("单个规划问题最多包含100个候选机会");
  const seen = new Set<string>();
  const opportunities = input.opportunities.map((opportunity) => {
    const opportunityId = requiredText(opportunity.opportunityId, "候选机会缺少 opportunityId");
    if (seen.has(opportunityId)) throw new Error(`候选机会ID重复：${opportunityId}`);
    seen.add(opportunityId);
    return {
      opportunityId,
      satelliteId: requiredText(opportunity.satelliteId, "候选机会缺少 satelliteId"),
      instrumentId: optionalText(opportunity.instrumentId),
      imagingMode: optionalText(opportunity.imagingMode),
      start: requiredIso(opportunity.start, "候选机会开始时间无效"),
      end: requiredIso(opportunity.end, "候选机会结束时间无效"),
      simulationLevel: opportunity.simulationLevel ?? "sensor_model",
      coveragePercent: numberOrUndefined(opportunity.coveragePercent),
      spatialResolutionM: numberOrUndefined(opportunity.spatialResolutionM),
      incidenceAngleDeg: numberOrUndefined(opportunity.incidenceAngleDeg),
      orbitDirection: opportunity.orbitDirection,
      closestApproachAt: optionalIso(opportunity.closestApproachAt),
      trackingValidFrom: optionalIso(opportunity.trackingValidFrom),
      trackingValidTo: optionalIso(opportunity.trackingValidTo),
      engineeringConstraintsVerified: opportunity.engineeringConstraintsVerified === true ? true : undefined,
      assessment: assessPlanningOpportunity(input.task, opportunity),
    };
  });
  const problemCore = {
    schemaVersion: "tianxun.planning.problem/v1" as const,
    generatedAt,
    horizon: { start: horizonStart, end: horizonEnd },
    task: {
      taskId,
      eventId,
      masterEventId,
      revision: integerOr(input.task.revision, 0),
      title: optionalText(input.task.title) ?? taskId,
      hazard: optionalText(input.task.hazard) ?? "unknown",
      dynamicTarget: input.task.hazard === "cyclone" && Array.isArray(input.task.timeIndexedAoi) && input.task.timeIndexedAoi.length > 0,
      priority: integerOr(input.task.priority, 0),
      requiredRevisits: Math.max(1, integerOr(input.task.revisitCount, 1)),
      deliveryDeadline: optionalIso(input.task.deliveryDeadline),
      requirements: {
        minimumCoveragePercent: numberOrUndefined(input.task.minimumCoveragePercent),
        maximumSpatialResolutionM: numberOrUndefined(input.task.spatialResolutionMeters),
        incidenceAngleDeg: incidenceRange(input.task),
        orbitDirection: direction(input.task.orbitDirectionPreference),
      },
    },
    opportunities,
  };
  return {
    ...problemCore,
    problemId: `${taskId}:r${problemCore.task.revision}:${aoiFingerprint(problemCore).slice(0, 24)}`,
  };
}

export function summarizeMissionPlanningProblem(problem: MissionPlanningProblem): MissionPlanningSummary {
  return problem.opportunities.reduce<MissionPlanningSummary>((summary, opportunity) => {
    summary.total += 1;
    summary[opportunity.assessment.decision] += 1;
    if (opportunity.assessment.eligibleForDispatch) summary.dispatchable += 1;
    return summary;
  }, { total: 0, eligible: 0, conditional: 0, rejected: 0, dispatchable: 0 });
}

export function annotatePlanningWindows<T extends PlanningOpportunityInput>(task: PlanningTaskInput, windows: T[], generatedAt?: string | Date) {
  const problem = buildMissionPlanningProblem({ task, opportunities: windows, generatedAt });
  const assessments = new Map(problem.opportunities.map((opportunity) => [opportunity.opportunityId, opportunity.assessment]));
  return {
    problem,
    summary: summarizeMissionPlanningProblem(problem),
    windows: windows.map((window) => ({ ...window, constraintAssessment: assessments.get(window.opportunityId)! })),
  };
}

export function createUnsolvedMissionSchedule(problem: MissionPlanningProblem, algorithm = { id: "unassigned", version: "1" }): MissionPlanningSchedule {
  const hasFeasibleOpportunity = problem.opportunities.some((opportunity) => opportunity.assessment.eligibleForTrialSchedule);
  return {
    schemaVersion: "tianxun.planning.schedule/v1",
    problemId: problem.problemId,
    generatedAt: new Date().toISOString(),
    algorithm,
    state: hasFeasibleOpportunity ? "not_solved" : "infeasible",
    assignments: [],
    unassigned: [{ taskId: problem.task.taskId, reason: hasFeasibleOpportunity ? "not_solved" : "no_feasible_opportunity" }],
  };
}

function compareMinimum(
  findings: PlanningConstraintFinding[], required: number | null, actual: number | null,
  failureCode: PlanningConstraintCode, missingCode: PlanningConstraintCode,
  failureMessage: string, missingMessage: string, unit: string,
) {
  if (required === null) return;
  if (actual === null) findings.push(unverified(missingCode, missingMessage, `${required}${unit}`));
  else if (actual < required) findings.push(blocking(failureCode, failureMessage, `${actual}${unit}`, `${required}${unit}`));
}

function compareMaximum(
  findings: PlanningConstraintFinding[], required: number | null, actual: number | null,
  failureCode: PlanningConstraintCode, missingCode: PlanningConstraintCode,
  failureMessage: string, missingMessage: string, unit: string,
) {
  if (required === null) return;
  if (actual === null) findings.push(unverified(missingCode, missingMessage, `${required}${unit}`));
  else if (actual > required) findings.push(blocking(failureCode, failureMessage, `${actual}${unit}`, `${required}${unit}`));
}

function blocking(code: PlanningConstraintCode, message: string, actual?: number | string, required?: number | string): PlanningConstraintFinding {
  return { code, severity: "blocking", message, ...(actual === undefined ? {} : { actual }), ...(required === undefined ? {} : { required }) };
}

function unverified(code: PlanningConstraintCode, message: string, required?: number | string): PlanningConstraintFinding {
  return { code, severity: "unverified", message, ...(required === undefined ? {} : { required }) };
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredIso(value: unknown, message: string) {
  const parsed = timestamp(value);
  if (parsed === null) throw new Error(message);
  return new Date(parsed).toISOString();
}

function optionalIso(value: unknown) {
  const parsed = timestamp(value);
  return parsed === null ? undefined : new Date(parsed).toISOString();
}

function requiredText(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrUndefined(value: unknown) {
  return numberOrNull(value) ?? undefined;
}

function integerOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function direction(value: unknown): "ascending" | "descending" | "either" {
  return value === "ascending" || value === "descending" ? value : "either";
}

function incidenceRange(task: PlanningTaskInput) {
  const min = numberOrNull(task.incidenceAngleMinDeg);
  const max = numberOrNull(task.incidenceAngleMaxDeg);
  return min === null || max === null ? undefined : { min, max };
}
