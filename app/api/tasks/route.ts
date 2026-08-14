import { deleteSatelliteTask, getCanonicalEventForTask, listSatelliteTaskCancellationIds, listSatelliteTasks, upsertSatelliteTask } from "../../../db/operational";
import { ApiInputError, apiActor, authorizeApiRequest, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { validateSatelliteTask } from "../../../lib/task-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  try {
    const [tasks, cancelledTaskIds] = await Promise.all([listSatelliteTasks(), listSatelliteTaskCancellationIds()]);
    return Response.json({ tasks, cancelledTaskIds, storage: "operational-database" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "任务数据库暂不可用", detail: error instanceof Error ? error.message : "unknown" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  try {
    const task = await readJsonObject(request);
    const validation = validateSatelliteTask(task);
    if (!validation.ok) return Response.json({ error: "任务校验失败", errors: validation.errors }, { status: 400 });
    const canonical = await getCanonicalEventForTask(String(task.masterEventId));
    if (!canonical) return Response.json({ error: "主事件不存在或尚未可靠入库，禁止建立任务" }, { status: 409 });
    if (["resolved", "archived"].includes(canonical.lifecycleStatus) || Date.parse(canonical.observationExpiresAt) <= Date.now()) {
      return Response.json({ error: "主事件已解除或超过观测期，禁止建立或更新任务" }, { status: 409 });
    }
    if (task.aoiApproval === "source_verified" && canonical.event.dispatchEligibility !== "ready") {
      return Response.json({ error: "来源坐标不具备直接下发资格，必须由操作员复核 AOI" }, { status: 409 });
    }
    const approvedTask = task.aoiApproval === "operator_confirmed"
      ? { ...task, approvedAt: new Date().toISOString(), approvedBy: apiActor(request) }
      : { ...task, approvedAt: canonical.event.updatedAt, approvedBy: canonical.event.source };
    return Response.json({ task: await upsertSatelliteTask(approvedTask as Parameters<typeof upsertSatelliteTask>[0]), storage: "operational-database" });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /不允许的任务状态转换|任务已被其他请求更新/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "任务保存失败", detail: error instanceof Error ? error.message : "unknown" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const taskId = new URL(request.url).searchParams.get("taskId");
  if (!taskId) return Response.json({ error: "缺少 taskId" }, { status: 400 });
  try {
    const found = await deleteSatelliteTask(taskId);
    if (!found) return Response.json({ error: "任务不存在" }, { status: 404 });
    return Response.json({ deleted: taskId });
  } catch (error) {
    if (error instanceof Error && /不允许取消|任务已被其他请求更新/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "任务删除失败", detail: error instanceof Error ? error.message : "unknown" }, { status: 503 });
  }
}
