import {
  buildMissionPlanningProblem,
  type MissionPlanningProblem,
  type PlanningOpportunityInput,
} from "./mission-planning.ts";

export type SchedulingAlgorithmId = "priority_greedy_v1" | "bounded_constraint_search_v1" | "external_or_tools_cp_sat_v1";

export type SchedulingScore = {
  priority: number;
  timeliness: number;
  quality: number;
  verification: number;
  firstObservationBonus: number;
  total: number;
};

export type SchedulingAssignment = {
  assignmentId: string;
  problemId: string;
  taskId: string;
  taskTitle: string;
  opportunityId: string;
  satelliteId: string;
  instrumentId?: string;
  imagingMode?: string;
  start: string;
  end: string;
  constraintDecision: "eligible" | "conditional";
  manuallyLocked: boolean;
  score: SchedulingScore;
};

export type SchedulingManualRules = {
  lockedOpportunityRefs: string[];
  excludedOpportunityRefs: string[];
  forcedSatelliteByTask: Record<string, string>;
  forcedImagingModeByTask: Record<string, string>;
};

export type MultiTaskSchedule = {
  schemaVersion: "tianxun.planning.multi-schedule/v1";
  runId: string;
  generatedAt: string;
  algorithm: { id: SchedulingAlgorithmId; version: "1"; label: string };
  optimality: "heuristic" | "proven" | "bounded";
  state: "feasible" | "infeasible";
  objectiveScore: number;
  nodesEvaluated: number;
  transitionBufferSeconds: number;
  assumptions: string[];
  summary: {
    taskCount: number;
    opportunityCount: number;
    requestedAssignments: number;
    scheduledTaskCount: number;
    assignmentCount: number;
    conditionalAssignmentCount: number;
    unsatisfiedTaskCount: number;
  };
  assignments: SchedulingAssignment[];
  unassigned: Array<{
    taskId: string;
    taskTitle: string;
    requested: number;
    assigned: number;
    reason: "no_trial_eligible_opportunity" | "filtered_by_manual_rules" | "not_selected_by_objective" | "revisit_target_partially_met";
  }>;
};

export type SchedulingComparison = {
  schemaVersion: "tianxun.planning.comparison/v1";
  generatedAt: string;
  input: { problemCount: number; opportunityCount: number; transitionBufferSeconds: number };
  greedy: MultiTaskSchedule;
  optimized: MultiTaskSchedule;
  manualRules: SchedulingManualRules;
  recommendedAlgorithm: SchedulingAlgorithmId;
  note: string;
};

type Candidate = {
  problem: MissionPlanningProblem;
  opportunity: MissionPlanningProblem["opportunities"][number];
  startMs: number;
  endMs: number;
  baseScore: Omit<SchedulingScore, "firstObservationBonus" | "total"> & { total: number };
};

export function runSchedulingComparison(problems: MissionPlanningProblem[], options: { transitionBufferSeconds?: number; maxSearchNodes?: number; maxSearchCandidates?: number; manualRules?: unknown } = {}): SchedulingComparison {
  validateProblemCollection(problems);
  const transitionBufferSeconds = boundedInteger(options.transitionBufferSeconds, 0, 900, 120);
  const maxSearchNodes = boundedInteger(options.maxSearchNodes, 1_000, 200_000, 50_000);
  const maxSearchCandidates = boundedInteger(options.maxSearchCandidates, 12, 80, 48);
  const generatedAt = new Date().toISOString();
  const manualRules = normalizeSchedulingManualRules(options.manualRules, problems);
  const allCandidates = planningCandidates(problems);
  const candidates = applyManualRules(allCandidates, manualRules);
  const locked = lockedCandidates(allCandidates, candidates, manualRules, transitionBufferSeconds);
  const greedySelection = selectGreedy(candidates, transitionBufferSeconds, locked);
  const greedy = buildSchedule(problems, allCandidates, candidates, greedySelection.selected, manualRules, {
    generatedAt,
    algorithm: "priority_greedy_v1",
    optimality: "heuristic",
    nodesEvaluated: greedySelection.nodesEvaluated,
    transitionBufferSeconds,
  });
  const optimizedSelection = selectBounded(candidates, greedySelection.selected, locked, transitionBufferSeconds, maxSearchNodes, maxSearchCandidates);
  const optimized = buildSchedule(problems, allCandidates, candidates, optimizedSelection.selected, manualRules, {
    generatedAt,
    algorithm: "bounded_constraint_search_v1",
    optimality: optimizedSelection.truncated ? "bounded" : "proven",
    nodesEvaluated: optimizedSelection.nodesEvaluated,
    transitionBufferSeconds,
  });
  return {
    schemaVersion: "tianxun.planning.comparison/v1",
    generatedAt,
    input: { problemCount: problems.length, opportunityCount: candidates.length, transitionBufferSeconds },
    greedy,
    optimized,
    manualRules,
    recommendedAlgorithm: optimized.objectiveScore >= greedy.objectiveScore ? "bounded_constraint_search_v1" : "priority_greedy_v1",
    note: "结果仅用于仿真比较；转换缓冲不是卫星真实姿态机动参数，条件机会不得据此自动下发。",
  };
}

export function buildExternallySelectedSchedule(
  problems: MissionPlanningProblem[],
  selectedOpportunityRefs: string[],
  options: { transitionBufferSeconds?: number; manualRules?: unknown; generatedAt?: string; optimality?: MultiTaskSchedule["optimality"]; nodesEvaluated?: number } = {},
): MultiTaskSchedule {
  validateProblemCollection(problems);
  const transitionBufferSeconds = boundedInteger(options.transitionBufferSeconds, 0, 900, 120);
  const manualRules = normalizeSchedulingManualRules(options.manualRules, problems);
  const allCandidates = planningCandidates(problems);
  const candidates = applyManualRules(allCandidates, manualRules);
  const knownRefs = new Set(candidates.map((candidate) => schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)));
  const selectedRefs = [...new Set(selectedOpportunityRefs)];
  if (selectedRefs.length > 500 || selectedRefs.some((reference) => typeof reference !== "string" || !knownRefs.has(reference))) throw new Error("外部优化器返回未知、被排除或不可试排的机会");
  const requiredLocked = new Set(manualRules.lockedOpportunityRefs);
  if ([...requiredLocked].some((reference) => !selectedRefs.includes(reference))) throw new Error("外部优化器遗漏了人工锁定机会");
  const selectionRules = { ...manualRules, lockedOpportunityRefs: selectedRefs };
  const selected = lockedCandidates(allCandidates, candidates, selectionRules, transitionBufferSeconds);
  return buildSchedule(problems, allCandidates, candidates, selected, manualRules, {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    algorithm: "external_or_tools_cp_sat_v1",
    optimality: options.optimality ?? "bounded",
    nodesEvaluated: boundedInteger(options.nodesEvaluated, 0, 10_000_000, 0),
    transitionBufferSeconds,
  });
}

export function schedulingOpportunityRef(problemId: string, opportunityId: string) {
  return JSON.stringify([problemId, opportunityId]);
}

export function emptySchedulingManualRules(): SchedulingManualRules {
  return { lockedOpportunityRefs: [], excludedOpportunityRefs: [], forcedSatelliteByTask: {}, forcedImagingModeByTask: {} };
}

export function normalizeSchedulingManualRules(value: unknown, problems: MissionPlanningProblem[]): SchedulingManualRules {
  if (value === undefined || value === null) return emptySchedulingManualRules();
  const input = object(value, "人工规划规则必须是对象");
  const knownTasks = new Map(problems.map((problem) => [problem.task.taskId, problem]));
  const knownRefs = new Set(problems.flatMap((problem) => problem.opportunities.map((opportunity) => schedulingOpportunityRef(problem.problemId, opportunity.opportunityId))));
  const lockedOpportunityRefs = normalizedRefList(input.lockedOpportunityRefs, "锁定机会", knownRefs);
  const excludedOpportunityRefs = normalizedRefList(input.excludedOpportunityRefs, "排除机会", knownRefs);
  const excluded = new Set(excludedOpportunityRefs);
  if (lockedOpportunityRefs.some((reference) => excluded.has(reference))) throw new Error("同一机会不能同时锁定和排除");
  const forcedSatelliteByTask = normalizedTaskRuleMap(input.forcedSatelliteByTask, "指定卫星", knownTasks, (problem, selected) => problem.opportunities.some((opportunity) => opportunity.satelliteId === selected));
  const forcedImagingModeByTask = normalizedTaskRuleMap(input.forcedImagingModeByTask, "指定成像模式", knownTasks, (problem, selected) => problem.opportunities.some((opportunity) => opportunity.imagingMode === selected));
  return { lockedOpportunityRefs, excludedOpportunityRefs, forcedSatelliteByTask, forcedImagingModeByTask };
}

export function normalizeMissionPlanningProblem(value: unknown): MissionPlanningProblem {
  const input = object(value, "规划问题必须是对象");
  if (input.schemaVersion !== "tianxun.planning.problem/v1") throw new Error("规划问题版本不受支持");
  const task = object(input.task, "规划任务摘要无效");
  const horizon = object(input.horizon, "规划时间域无效");
  const requirements = object(task.requirements, "规划任务约束无效");
  const opportunities = array(input.opportunities, "规划机会必须是数组");
  if (opportunities.length > 100) throw new Error("单个规划问题最多包含100个机会");
  const dynamicTarget = task.dynamicTarget === true;
  const pseudoTask: Record<string, unknown> = {
    taskId: boundedText(task.taskId, 220, "taskId"),
    eventId: boundedText(task.eventId, 220, "eventId"),
    masterEventId: boundedText(task.masterEventId, 220, "masterEventId"),
    revision: boundedInteger(task.revision, 0, 1_000_000, 0),
    title: boundedText(task.title, 500, "title"),
    hazard: boundedText(task.hazard, 80, "hazard"),
    timeIndexedAoi: dynamicTarget ? [{}] : undefined,
    priority: boundedInteger(task.priority, 0, 100, 0),
    revisitCount: boundedInteger(task.requiredRevisits, 1, 50, 1),
    deliveryDeadline: optionalIso(task.deliveryDeadline),
    imagingStart: iso(horizon.start, "规划开始时间无效"),
    imagingEnd: iso(horizon.end, "规划结束时间无效"),
    minimumCoveragePercent: optionalNumber(requirements.minimumCoveragePercent, 0, 100),
    spatialResolutionMeters: optionalNumber(requirements.maximumSpatialResolutionM, 0.1, 10_000),
    incidenceAngleMinDeg: optionalNumber(objectOrEmpty(requirements.incidenceAngleDeg).min, 0, 90),
    incidenceAngleMaxDeg: optionalNumber(objectOrEmpty(requirements.incidenceAngleDeg).max, 0, 90),
    orbitDirectionPreference: direction(requirements.orbitDirection),
  };
  const normalizedOpportunities = opportunities.map((candidate): PlanningOpportunityInput => {
    const opportunity = object(candidate, "规划机会无效");
    const simulationLevel = opportunity.simulationLevel === "orbit_only" || opportunity.simulationLevel === "assumed_sensor" || opportunity.simulationLevel === "sensor_model" ? opportunity.simulationLevel : null;
    if (!simulationLevel) throw new Error("规划机会仿真层级无效");
    const orbitDirection = opportunity.orbitDirection === "ascending" || opportunity.orbitDirection === "descending" ? opportunity.orbitDirection : undefined;
    return {
      opportunityId: boundedText(opportunity.opportunityId, 220, "opportunityId"),
      satelliteId: boundedText(opportunity.satelliteId, 220, "satelliteId"),
      instrumentId: optionalText(opportunity.instrumentId, 220),
      imagingMode: optionalText(opportunity.imagingMode, 220),
      start: iso(opportunity.start, "规划机会开始时间无效"),
      end: iso(opportunity.end, "规划机会结束时间无效"),
      simulationLevel,
      coveragePercent: optionalNumber(opportunity.coveragePercent, 0, 100),
      spatialResolutionM: optionalNumber(opportunity.spatialResolutionM, 0.1, 10_000),
      incidenceAngleDeg: optionalNumber(opportunity.incidenceAngleDeg, 0, 90),
      orbitDirection,
      closestApproachAt: optionalIso(opportunity.closestApproachAt),
      trackingValidFrom: optionalIso(opportunity.trackingValidFrom),
      trackingValidTo: optionalIso(opportunity.trackingValidTo),
      engineeringConstraintsVerified: opportunity.engineeringConstraintsVerified === true,
    };
  });
  const start = Date.parse(String(pseudoTask.imagingStart));
  const end = Date.parse(String(pseudoTask.imagingEnd));
  if (end <= start) throw new Error("规划时间域无效");
  if (end - start > 14 * 86_400_000) throw new Error("单次试排时间域不能超过14天");
  const rebuilt = buildMissionPlanningProblem({ task: pseudoTask, opportunities: normalizedOpportunities, generatedAt: iso(input.generatedAt, "规划问题生成时间无效") });
  if (boundedText(input.problemId, 500, "problemId") !== rebuilt.problemId) throw new Error("规划问题ID与内容版本不匹配");
  return rebuilt;
}

function validateProblemCollection(problems: MissionPlanningProblem[]) {
  if (!problems.length) throw new Error("至少需要一个已计算可见机会的规划任务");
  if (problems.length > 30) throw new Error("单次最多试排30个任务");
  const taskIds = new Set<string>();
  let opportunities = 0;
  for (const problem of problems) {
    if (taskIds.has(problem.task.taskId)) throw new Error(`任务重复：${problem.task.taskId}`);
    taskIds.add(problem.task.taskId);
    opportunities += problem.opportunities.length;
  }
  if (opportunities > 500) throw new Error("单次最多试排500个候选机会");
}

function planningCandidates(problems: MissionPlanningProblem[]): Candidate[] {
  return problems.flatMap((problem) => problem.opportunities
    .filter((opportunity) => opportunity.assessment.eligibleForTrialSchedule)
    .map((opportunity) => ({
      problem,
      opportunity,
      startMs: Date.parse(opportunity.start),
      endMs: Date.parse(opportunity.end),
      baseScore: scoreOpportunity(problem, opportunity),
    })))
    .sort(compareCandidates);
}

function applyManualRules(candidates: Candidate[], rules: SchedulingManualRules) {
  const excluded = new Set(rules.excludedOpportunityRefs);
  return candidates.filter((candidate) => {
    const taskId = candidate.problem.task.taskId;
    const reference = schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId);
    if (excluded.has(reference)) return false;
    const satellite = rules.forcedSatelliteByTask[taskId];
    if (satellite && candidate.opportunity.satelliteId !== satellite) return false;
    const imagingMode = rules.forcedImagingModeByTask[taskId];
    if (imagingMode && candidate.opportunity.imagingMode !== imagingMode) return false;
    return true;
  });
}

function lockedCandidates(allCandidates: Candidate[], filteredCandidates: Candidate[], rules: SchedulingManualRules, transitionBufferSeconds: number) {
  const allByRef = new Map(allCandidates.map((candidate) => [schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId), candidate]));
  const filteredRefs = new Set(filteredCandidates.map((candidate) => schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)));
  const locked = rules.lockedOpportunityRefs.map((reference) => {
    const candidate = allByRef.get(reference);
    if (!candidate) throw new Error("锁定机会不存在或不具备试排资格");
    if (!filteredRefs.has(reference)) throw new Error("锁定机会与排除、指定卫星或指定模式规则冲突");
    return candidate;
  });
  const counts = new Map<string, number>();
  for (const candidate of locked) {
    const taskId = candidate.problem.task.taskId;
    const count = (counts.get(taskId) ?? 0) + 1;
    if (count > candidate.problem.task.requiredRevisits) throw new Error(`任务 ${candidate.problem.task.title} 的锁定机会超过重访次数`);
    if (conflicts(candidate, locked.filter((other) => other !== candidate), transitionBufferSeconds)) throw new Error("锁定机会之间存在同星时间或转换缓冲冲突");
    counts.set(taskId, count);
  }
  return locked;
}

function scoreOpportunity(problem: MissionPlanningProblem, opportunity: MissionPlanningProblem["opportunities"][number]) {
  const horizonStart = Date.parse(problem.horizon.start);
  const horizonDuration = Math.max(1, Date.parse(problem.horizon.end) - horizonStart);
  const relativeTime = Math.max(0, Math.min(1, (Date.parse(opportunity.start) - horizonStart) / horizonDuration));
  const priority = problem.task.priority * 100;
  const timeliness = Math.round((1 - relativeTime) * 100);
  const quality = opportunity.coveragePercent === undefined ? 0 : Math.round(opportunity.coveragePercent / 5);
  const verification = opportunity.assessment.decision === "eligible" ? 20 : 0;
  return { priority, timeliness, quality, verification, total: priority + timeliness + quality + verification };
}

function selectGreedy(candidates: Candidate[], transitionBufferSeconds: number, locked: Candidate[]) {
  const selected: Candidate[] = [...locked];
  const counts = new Map<string, number>();
  for (const candidate of locked) counts.set(candidate.problem.task.taskId, (counts.get(candidate.problem.task.taskId) ?? 0) + 1);
  const lockedRefs = new Set(locked.map((candidate) => schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)));
  const remaining = new Set(candidates.filter((candidate) => !lockedRefs.has(schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId))));
  let nodesEvaluated = 0;
  while (remaining.size) {
    let best: Candidate | null = null;
    let bestMarginal = -Infinity;
    for (const candidate of remaining) {
      nodesEvaluated += 1;
      const taskId = candidate.problem.task.taskId;
      if ((counts.get(taskId) ?? 0) >= candidate.problem.task.requiredRevisits || conflicts(candidate, selected, transitionBufferSeconds)) continue;
      const marginal = candidate.baseScore.total + ((counts.get(taskId) ?? 0) === 0 ? 500 : 0);
      if (marginal > bestMarginal || (marginal === bestMarginal && best && compareCandidates(candidate, best) < 0)) {
        best = candidate;
        bestMarginal = marginal;
      }
    }
    if (!best) break;
    selected.push(best);
    counts.set(best.problem.task.taskId, (counts.get(best.problem.task.taskId) ?? 0) + 1);
    remaining.delete(best);
  }
  return { selected, nodesEvaluated };
}

function selectBounded(candidates: Candidate[], seed: Candidate[], locked: Candidate[], transitionBufferSeconds: number, maxSearchNodes: number, maxSearchCandidates: number) {
  const lockedRefs = new Set(locked.map((candidate) => schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)));
  const optionalCandidates = candidates.filter((candidate) => !lockedRefs.has(schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)));
  const perTask = new Map<string, Candidate[]>();
  for (const candidate of optionalCandidates) {
    const values = perTask.get(candidate.problem.task.taskId) ?? [];
    if (values.length < 8) values.push(candidate);
    perTask.set(candidate.problem.task.taskId, values);
  }
  const search = [...perTask.values()].flat().sort(compareCandidates).slice(0, maxSearchCandidates);
  const candidateTruncated = search.length < optionalCandidates.length;
  const maximum = search.map((candidate) => candidate.baseScore.total + 500);
  const suffix = new Array(search.length + 1).fill(0);
  for (let index = search.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + maximum[index];
  let best = [...seed];
  let bestScore = selectionScore(best);
  let nodesEvaluated = 0;
  let nodeTruncated = false;
  const selected: Candidate[] = [...locked];
  const counts = new Map<string, number>();
  for (const candidate of locked) counts.set(candidate.problem.task.taskId, (counts.get(candidate.problem.task.taskId) ?? 0) + 1);
  const lockedScore = selectionScore(locked);

  const visit = (index: number, score: number) => {
    if (nodesEvaluated >= maxSearchNodes) { nodeTruncated = true; return; }
    nodesEvaluated += 1;
    if (score + suffix[index] < bestScore) return;
    if (index >= search.length) {
      if (score > bestScore || (score === bestScore && selectionKey(selected) < selectionKey(best))) {
        best = [...selected];
        bestScore = score;
      }
      return;
    }
    const candidate = search[index];
    const taskId = candidate.problem.task.taskId;
    const count = counts.get(taskId) ?? 0;
    if (count < candidate.problem.task.requiredRevisits && !conflicts(candidate, selected, transitionBufferSeconds)) {
      selected.push(candidate);
      counts.set(taskId, count + 1);
      visit(index + 1, score + candidate.baseScore.total + (count === 0 ? 500 : 0));
      selected.pop();
      if (count === 0) counts.delete(taskId); else counts.set(taskId, count);
    }
    visit(index + 1, score);
  };
  visit(0, lockedScore);
  return { selected: best, nodesEvaluated, truncated: candidateTruncated || nodeTruncated };
}

function buildSchedule(problems: MissionPlanningProblem[], allCandidates: Candidate[], candidates: Candidate[], selected: Candidate[], manualRules: SchedulingManualRules, metadata: { generatedAt: string; algorithm: SchedulingAlgorithmId; optimality: MultiTaskSchedule["optimality"]; nodesEvaluated: number; transitionBufferSeconds: number }): MultiTaskSchedule {
  const counts = new Map<string, number>();
  const lockedRefs = new Set(manualRules.lockedOpportunityRefs);
  const ordered = [...selected].sort((left, right) => left.startMs - right.startMs || compareCandidates(left, right));
  const assignments = ordered.map((candidate): SchedulingAssignment => {
    const taskId = candidate.problem.task.taskId;
    const firstObservationBonus = (counts.get(taskId) ?? 0) === 0 ? 500 : 0;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
    const score = { ...candidate.baseScore, firstObservationBonus, total: candidate.baseScore.total + firstObservationBonus };
    return {
      assignmentId: `${taskId}:${candidate.opportunity.opportunityId}`,
      problemId: candidate.problem.problemId,
      taskId,
      taskTitle: candidate.problem.task.title,
      opportunityId: candidate.opportunity.opportunityId,
      satelliteId: candidate.opportunity.satelliteId,
      instrumentId: candidate.opportunity.instrumentId,
      imagingMode: candidate.opportunity.imagingMode,
      start: candidate.opportunity.start,
      end: candidate.opportunity.end,
      constraintDecision: candidate.opportunity.assessment.decision as "eligible" | "conditional",
      manuallyLocked: lockedRefs.has(schedulingOpportunityRef(candidate.problem.problemId, candidate.opportunity.opportunityId)),
      score,
    };
  });
  const unassigned = problems.flatMap((problem) => {
    const assigned = counts.get(problem.task.taskId) ?? 0;
    if (assigned >= problem.task.requiredRevisits) return [];
    const hasTrialCandidate = allCandidates.some((candidate) => candidate.problem.problemId === problem.problemId);
    const hasCandidate = candidates.some((candidate) => candidate.problem.problemId === problem.problemId);
    return [{
      taskId: problem.task.taskId,
      taskTitle: problem.task.title,
      requested: problem.task.requiredRevisits,
      assigned,
      reason: !hasTrialCandidate ? "no_trial_eligible_opportunity" as const : !hasCandidate ? "filtered_by_manual_rules" as const : assigned ? "revisit_target_partially_met" as const : "not_selected_by_objective" as const,
    }];
  });
  const scheduledTaskCount = new Set(assignments.map((assignment) => assignment.taskId)).size;
  const objectiveScore = assignments.reduce((sum, assignment) => sum + assignment.score.total, 0);
  return {
    schemaVersion: "tianxun.planning.multi-schedule/v1",
    runId: `${metadata.algorithm}:${metadata.generatedAt}`,
    generatedAt: metadata.generatedAt,
    algorithm: {
      id: metadata.algorithm,
      version: "1",
      label: metadata.algorithm === "priority_greedy_v1" ? "优先级贪心基线" : metadata.algorithm === "bounded_constraint_search_v1" ? "有界约束搜索" : "外部 OR-Tools CP-SAT",
    },
    optimality: metadata.optimality,
    state: assignments.length ? "feasible" : "infeasible",
    objectiveScore,
    nodesEvaluated: metadata.nodesEvaluated,
    transitionBufferSeconds: metadata.transitionBufferSeconds,
    assumptions: [
      `同一卫星相邻任务暂按 ${metadata.transitionBufferSeconds} 秒转换缓冲检查冲突。`,
      metadata.algorithm === "external_or_tools_cp_sat_v1" ? "外部求解器的选择已由本系统重新校验任务重访次数、人工规则及同星时间冲突。" : "当前未建模真实姿态角速度、加速度、稳定时间、功耗、存储、热控、下传和模式切换。",
      "conditional 机会只允许进入试排，不具备自动下发资格。",
    ],
    summary: {
      taskCount: problems.length,
      opportunityCount: candidates.length,
      requestedAssignments: problems.reduce((sum, problem) => sum + problem.task.requiredRevisits, 0),
      scheduledTaskCount,
      assignmentCount: assignments.length,
      conditionalAssignmentCount: assignments.filter((assignment) => assignment.constraintDecision === "conditional").length,
      unsatisfiedTaskCount: unassigned.length,
    },
    assignments,
    unassigned,
  };
}

function conflicts(candidate: Candidate, selected: Candidate[], transitionBufferSeconds: number) {
  const bufferMs = transitionBufferSeconds * 1_000;
  return selected.some((existing) => existing.opportunity.satelliteId === candidate.opportunity.satelliteId
    && candidate.startMs < existing.endMs + bufferMs
    && existing.startMs < candidate.endMs + bufferMs);
}

function selectionScore(selected: Candidate[]) {
  const seen = new Set<string>();
  return selected.reduce((score, candidate) => {
    const taskId = candidate.problem.task.taskId;
    const bonus = seen.has(taskId) ? 0 : 500;
    seen.add(taskId);
    return score + candidate.baseScore.total + bonus;
  }, 0);
}

function selectionKey(selected: Candidate[]) {
  return selected.map((candidate) => `${candidate.problem.task.taskId}:${candidate.opportunity.opportunityId}`).sort().join("|");
}

function compareCandidates(left: Candidate, right: Candidate) {
  return right.baseScore.total - left.baseScore.total
    || left.startMs - right.startMs
    || left.problem.task.taskId.localeCompare(right.problem.task.taskId)
    || left.opportunity.opportunityId.localeCompare(right.opportunity.opportunityId);
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown, message: string) {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function normalizedRefList(value: unknown, label: string, knownRefs: Set<string>) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label}列表无效或超过500项`);
  const result = [...new Set(value.map((item) => boundedText(item, 1_000, label)))].sort();
  if (result.some((reference) => !knownRefs.has(reference))) throw new Error(`${label}包含不属于当前规划问题的机会`);
  return result;
}

function normalizedTaskRuleMap(value: unknown, label: string, knownTasks: Map<string, MissionPlanningProblem>, accepts: (problem: MissionPlanningProblem, selected: string) => boolean) {
  if (value === undefined || value === null) return {};
  const input = object(value, `${label}规则必须是对象`);
  if (Object.keys(input).length > 30) throw new Error(`${label}规则最多包含30个任务`);
  const output: Record<string, string> = {};
  for (const [rawTaskId, rawSelected] of Object.entries(input)) {
    const taskId = boundedText(rawTaskId, 220, "taskId");
    const selected = boundedText(rawSelected, 220, label);
    const problem = knownTasks.get(taskId);
    if (!problem) throw new Error(`${label}包含未知任务`);
    if (!accepts(problem, selected)) throw new Error(`${label}不属于该任务的候选机会`);
    output[taskId] = selected;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function boundedText(value: unknown, maximum: number, field: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${field} 无效`);
  return value.trim();
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maximum) throw new Error("可选文本字段无效");
  return value.trim() || undefined;
}

function iso(value: unknown, message: string) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(message);
  return new Date(parsed).toISOString();
}

function optionalIso(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return iso(value, "可选时间字段无效");
}

function optionalNumber(value: unknown, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error("数值约束字段超出范围");
  return parsed;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error("整数配置字段超出范围");
  return parsed;
}

function direction(value: unknown): "ascending" | "descending" | "either" {
  return value === "ascending" || value === "descending" ? value : "either";
}
