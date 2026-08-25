import { ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { normalizeMissionPlanningProblem, runSchedulingComparison } from "../../../../lib/mission-scheduler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "planning-schedule", 10);
  if (limited) return limited;

  try {
    const body = await readJsonObject(request, 512 * 1024);
    if (!Array.isArray(body.problems)) throw new ApiInputError("problems 必须是规划问题数组", 400);
    const options: { transitionBufferSeconds?: number; maxSearchNodes?: number; maxSearchCandidates?: number; manualRules?: unknown } = { manualRules: body.manualRules };
    if (body.transitionBufferSeconds !== undefined) options.transitionBufferSeconds = finiteNumber(body.transitionBufferSeconds, "转换缓冲时间");
    if (body.maxSearchNodes !== undefined) options.maxSearchNodes = finiteNumber(body.maxSearchNodes, "搜索节点上限");
    if (body.maxSearchCandidates !== undefined) options.maxSearchCandidates = finiteNumber(body.maxSearchCandidates, "搜索候选上限");
    const comparison = runSchedulingComparison(body.problems.map(normalizeMissionPlanningProblem), options);
    return Response.json(comparison, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "联合试排请求无效";
    return Response.json({ error: message }, { status: error instanceof ApiInputError ? error.status : 400, headers: { "Cache-Control": "no-store" } });
  }
}

function finiteNumber(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new ApiInputError(`${label}必须是有限数字`, 400);
  return parsed;
}
