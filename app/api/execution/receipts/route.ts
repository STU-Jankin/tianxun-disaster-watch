import { listMissionExecutionReceipts, recordMissionExecutionReceipt } from "../../../../db/operational";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { normalizeExecutionReceiptInput } from "../../../../lib/mission-execution";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const role = await apiRole(request);
    const actor = await apiActor(request);
    const receipts = await listMissionExecutionReceipts({
      taskId: boundedQuery(url.searchParams.get("taskId"), 220),
      masterEventId: boundedQuery(url.searchParams.get("masterEventId"), 220),
      limit: Number(url.searchParams.get("limit") ?? 100),
    }, role === "admin" || role === "executor" ? undefined : actor);
    return Response.json({ receipts, storage: "operational-database", schemaVersion: "tianxun.execution-receipt/v1" }, { headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("mission receipt read unavailable", error);
    return Response.json({ error: "任务执行回执暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "executor")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "mission-execution-receipt", 120);
  if (limited) return limited;
  try {
    const input = normalizeExecutionReceiptInput(await readJsonObject(request, 64 * 1024));
    const role = await apiRole(request);
    const receipt = await recordMissionExecutionReceipt(input, await apiActor(request), role === "admin" || role === "executor");
    return Response.json({ receipt, storage: "operational-database", schemaVersion: "tianxun.execution-receipt/v1" }, { status: 201, headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /不存在/.test(error.message)) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof Error && /版本冲突|状态转换|已被其他|已被其他记录/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && /不属于/.test(error.message)) return Response.json({ error: error.message }, { status: 403 });
    if (error instanceof Error && /必须|无效|不能为空|超过|不能晚于|损坏/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    console.error("mission receipt write unavailable", error);
    return Response.json({ error: "任务执行回执登记失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function boundedQuery(value: string | null, maximum: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new ApiInputError("查询参数无效", 400);
  return normalized || undefined;
}

function privateHeaders() { return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }; }
