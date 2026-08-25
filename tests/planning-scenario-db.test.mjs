import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMissionPlanningProblem } from "../lib/mission-planning.ts";
import { emptySchedulingManualRules, runSchedulingComparison } from "../lib/mission-scheduler.ts";
import { planningScenarioHasValidChecksum, planningScenarioMatchesProblems } from "../lib/planning-scenarios.ts";

function planningProblem() {
  return buildMissionPlanningProblem({
    generatedAt: "2026-08-25T00:00:00.000Z",
    task: {
      taskId: "SCENARIO-TASK",
      eventId: "SCENARIO-EVENT",
      masterEventId: "SCENARIO-MASTER",
      revision: 1,
      title: "规划方案持久化测试",
      hazard: "flood",
      priority: 85,
      revisitCount: 1,
      imagingStart: "2026-08-25T00:00:00.000Z",
      imagingEnd: "2026-08-25T06:00:00.000Z",
    },
    opportunities: [{
      opportunityId: "SCENARIO-OPPORTUNITY",
      satelliteId: "TY-39",
      start: "2026-08-25T01:00:00.000Z",
      end: "2026-08-25T01:03:00.000Z",
      simulationLevel: "sensor_model",
      engineeringConstraintsVerified: true,
    }],
  });
}

test("stores immutable planning versions with owner isolation and validated checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-planning-scenario-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const { getPlanningScenario, listPlanningScenarioSummaries, savePlanningScenario } = await import(new URL("../db/operational.ts", import.meta.url));
    const problem = planningProblem();
    const comparison = runSchedulingComparison([problem]);
    const base = {
      owner: "alice",
      problemIds: [problem.problemId],
      manualRules: emptySchedulingManualRules(),
      comparison,
    };
    const first = await savePlanningScenario({
      ...base,
      scenarioId: "scenario-11111111-1111-4111-8111-111111111111",
      name: "第一版仿真",
      createdAt: "2026-08-25T01:00:00.000Z",
    });
    const second = await savePlanningScenario({
      ...base,
      scenarioId: "scenario-22222222-2222-4222-8222-222222222222",
      seriesId: first.seriesId,
      parentScenarioId: first.scenarioId,
      name: "第二版仿真",
      createdAt: "2026-08-25T02:00:00.000Z",
    });

    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(second.parentScenarioId, first.scenarioId);
    assert.equal(planningScenarioHasValidChecksum(second), true);
    assert.equal(planningScenarioMatchesProblems(second, [problem.problemId]), true);
    assert.deepEqual((await listPlanningScenarioSummaries("alice")).map((item) => item.version), [2, 1]);
    assert.equal((await getPlanningScenario(second.scenarioId, "alice"))?.checksum, second.checksum);
    assert.equal(await getPlanningScenario(second.scenarioId, "bob"), null);
    assert.deepEqual(await listPlanningScenarioSummaries("bob"), []);
    await assert.rejects(() => savePlanningScenario({
      ...base,
      scenarioId: "scenario-44444444-4444-4444-8444-444444444444",
      seriesId: first.seriesId,
      name: "缺少父版本",
      createdAt: "2026-08-25T02:30:00.000Z",
    }), /续存方案必须提供父方案/);
    await assert.rejects(() => savePlanningScenario({
      ...base,
      owner: "bob",
      scenarioId: "scenario-33333333-3333-4333-8333-333333333333",
      parentScenarioId: first.scenarioId,
      name: "越权派生",
      createdAt: "2026-08-25T03:00:00.000Z",
    }), /父方案不存在或不属于当前操作员/);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== "EBUSY") throw error;
    });
  }
});
