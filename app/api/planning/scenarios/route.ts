import { getPlanningScenario, listPlanningScenarioSummaries, savePlanningScenario } from "../../../../db/operational";
import { ApiInputError, apiActor, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { normalizeMissionPlanningProblem, runSchedulingComparison } from "../../../../lib/mission-scheduler";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "planning-scenario-read", 60);
  if (limited) return limited;
  try {
    const actor = await apiActor(request);
    const scenarioId = new URL(request.url).searchParams.get("scenarioId")?.trim();
    if (scenarioId) {
      if (!/^scenario-[0-9a-f-]{36}$/i.test(scenarioId)) throw new ApiInputError("规划方案ID无效", 400);
      const scenario = await getPlanningScenario(scenarioId, actor);
      if (!scenario) return Response.json({ error: "规划方案不存在、校验失败或不属于当前操作员" }, { status: 404 });
      return Response.json({ scenario, storage: "operational-database" }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ scenarios: await listPlanningScenarioSummaries(actor), storage: "operational-database" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("planning scenario read unavailable", error);
    return Response.json({ error: "规划方案库暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "planning-scenario-save", 12);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 512 * 1024);
    if (!Array.isArray(body.problems)) throw new ApiInputError("problems 必须是规划问题数组", 400);
    const name = scenarioName(body.name);
    const seriesId = optionalId(body.seriesId, /^series-[0-9a-f-]{36}$/i, "方案系列ID无效");
    const parentScenarioId = optionalId(body.parentScenarioId, /^scenario-[0-9a-f-]{36}$/i, "父方案ID无效");
    const options: { transitionBufferSeconds?: number; maxSearchNodes?: number; maxSearchCandidates?: number; manualRules?: unknown } = { manualRules: body.manualRules };
    if (body.transitionBufferSeconds !== undefined) options.transitionBufferSeconds = finiteNumber(body.transitionBufferSeconds, "转换缓冲时间");
    const problems = body.problems.map(normalizeMissionPlanningProblem);
    const comparison = runSchedulingComparison(problems, options);
    const scenario = await savePlanningScenario({
      scenarioId: `scenario-${crypto.randomUUID()}`,
      seriesId,
      parentScenarioId,
      owner: await apiActor(request),
      name,
      createdAt: new Date().toISOString(),
      problemIds: problems.map((problem) => problem.problemId),
      manualRules: comparison.manualRules,
      comparison,
    });
    return Response.json({ scenario, storage: "operational-database", warning: "方案是不可变仿真快照，不代表任务已排程或已下发" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /父方案|续存方案|版本冲突/.test(error.message)) return Response.json({ error: error.message }, { status: /父方案不存在/.test(error.message) ? 404 : 409 });
    if (error instanceof Error && /规划|任务|机会|规则|锁定|排除|卫星|模式|100个|512KB/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    console.error("planning scenario save unavailable", error);
    return Response.json({ error: "规划方案保存失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function scenarioName(value: unknown) {
  if (typeof value !== "string") throw new ApiInputError("请输入方案名称", 400);
  const name = value.trim();
  if (name.length < 2 || name.length > 80 || [...name].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new ApiInputError("方案名称须为2–80个可见字符", 400);
  return name;
}

function optionalId(value: unknown, pattern: RegExp, message: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !pattern.test(value)) throw new ApiInputError(message, 400);
  return value;
}

function finiteNumber(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new ApiInputError(`${label}必须是有限数字`, 400);
  return parsed;
}
