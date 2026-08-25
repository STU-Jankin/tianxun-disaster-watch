import { aoiFingerprint } from "./event-integrity.ts";
import type { SchedulingComparison, SchedulingManualRules } from "./mission-scheduler.ts";

export type PlanningScenarioRecord = {
  schemaVersion: "tianxun.planning.scenario/v1";
  scenarioId: string;
  seriesId: string;
  version: number;
  parentScenarioId?: string;
  name: string;
  owner: string;
  createdAt: string;
  status: "simulation_only";
  problemIds: string[];
  problemFingerprint: string;
  manualRules: SchedulingManualRules;
  comparison: SchedulingComparison;
  checksum: string;
};

export type PlanningScenarioSummary = {
  scenarioId: string;
  seriesId: string;
  version: number;
  parentScenarioId?: string;
  name: string;
  createdAt: string;
  problemFingerprint: string;
  objectiveScore: number;
  assignmentCount: number;
  conditionalAssignmentCount: number;
};

export function createPlanningScenarioRecord(input: Omit<PlanningScenarioRecord, "schemaVersion" | "status" | "problemFingerprint" | "checksum">): PlanningScenarioRecord {
  const problemIds = [...new Set(input.problemIds)].sort();
  const core = {
    schemaVersion: "tianxun.planning.scenario/v1" as const,
    ...input,
    status: "simulation_only" as const,
    problemIds,
    problemFingerprint: aoiFingerprint(problemIds),
  };
  // Persisted JSON omits undefined optional properties. Hash that exact shape so
  // a database round-trip cannot invalidate an otherwise untouched snapshot.
  const persistedCore = JSON.parse(JSON.stringify(core)) as typeof core;
  return { ...persistedCore, checksum: aoiFingerprint(persistedCore) };
}

export function planningScenarioSummary(record: PlanningScenarioRecord): PlanningScenarioSummary {
  const schedule = record.comparison.recommendedAlgorithm === "priority_greedy_v1" ? record.comparison.greedy : record.comparison.optimized;
  return {
    scenarioId: record.scenarioId,
    seriesId: record.seriesId,
    version: record.version,
    parentScenarioId: record.parentScenarioId,
    name: record.name,
    createdAt: record.createdAt,
    problemFingerprint: record.problemFingerprint,
    objectiveScore: schedule.objectiveScore,
    assignmentCount: schedule.summary.assignmentCount,
    conditionalAssignmentCount: schedule.summary.conditionalAssignmentCount,
  };
}

export function planningScenarioMatchesProblems(record: PlanningScenarioRecord, problemIds: string[]) {
  return record.problemFingerprint === aoiFingerprint([...new Set(problemIds)].sort());
}

export function planningScenarioHasValidChecksum(value: unknown): value is PlanningScenarioRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "tianxun.planning.scenario/v1" || typeof record.scenarioId !== "string" || typeof record.owner !== "string" || typeof record.checksum !== "string") return false;
  const { checksum, ...core } = record;
  return aoiFingerprint(core) === checksum;
}
