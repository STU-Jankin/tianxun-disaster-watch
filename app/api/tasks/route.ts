import { deleteSatelliteTask, getCanonicalEventForTask, listSatelliteTaskCancellationIds, listSatelliteTasks, upsertSatelliteTask } from "../../../db/operational";
import { ApiInputError, apiActor, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { unknownTaskFields, validateSatelliteTask } from "../../../lib/task-contract";
import { aoiFingerprint, eventRevisionFingerprint, geometryEquals } from "../../../lib/event-integrity";
import { buildTaskAoi } from "../../../lib/task-aoi";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  try {
    const [tasks, cancelledTaskIds] = await Promise.all([listSatelliteTasks(), listSatelliteTaskCancellationIds()]);
    return Response.json({ tasks, cancelledTaskIds, storage: "operational-database" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("task database unavailable", error);
    return Response.json({ error: "任务数据库暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "task-write", 60);
  if (limited) return limited;
  try {
    const task = await readJsonObject(request);
    const unknownFields = unknownTaskFields(task);
    if (unknownFields.length) return Response.json({ error: "任务包含未允许字段", fields: unknownFields.slice(0, 20) }, { status: 400 });
    const validation = validateSatelliteTask(task);
    if (!validation.ok) return Response.json({ error: "任务校验失败", errors: validation.errors }, { status: 400 });
    const canonical = await getCanonicalEventForTask(String(task.masterEventId));
    if (!canonical) return Response.json({ error: "主事件不存在或尚未可靠入库，禁止建立任务" }, { status: 409 });
    if (["resolved", "archived"].includes(canonical.lifecycleStatus) || Date.parse(canonical.observationExpiresAt) <= Date.now()) {
      return Response.json({ error: "主事件已解除或超过观测期，禁止建立或更新任务" }, { status: 409 });
    }
    if (Date.parse(String(task.imagingEnd)) > Date.parse(canonical.observationExpiresAt)) {
      return Response.json({ error: "成像窗口超过该灾害的有效观测期" }, { status: 409 });
    }
    const currentEventRevision = eventRevisionFingerprint(canonical.event);
    if (Number(task.revision ?? 0) > 0 && task.eventRevision !== currentEventRevision) {
      return Response.json({ error: "主事件已有新版本，必须刷新事件并重新核对 AOI" }, { status: 409 });
    }
    const sourceGeometry = canonical.event.cycloneForecast?.impactGeometry ?? canonical.event.geometry;
    if (task.aoiApproval === "source_verified") {
      if (canonical.event.dispatchEligibility !== "ready") return Response.json({ error: "来源坐标不具备直接下发资格，必须由操作员复核 AOI" }, { status: 409 });
      if (task.aoiType !== "source" || !geometryEquals(task.sourceGeometry as typeof sourceGeometry, sourceGeometry)) {
        return Response.json({ error: "来源核验任务的 AOI 必须与当前主事件来源几何完全一致" }, { status: 409 });
      }
    }
    const approvedAt = task.aoiApproval === "operator_confirmed" ? new Date().toISOString() : canonical.event.updatedAt;
    const approvedBy = task.aoiApproval === "operator_confirmed" ? apiActor(request) : canonical.event.source;
    const canonicalFields = {
      eventId: canonical.event.id,
      masterEventId: canonical.event.masterEventId,
      entityKey: canonical.event.entityKey,
      title: canonical.event.title,
      hazard: canonical.event.hazard,
      priority: canonical.event.priority,
      latitude: canonical.event.latitude,
      longitude: canonical.event.longitude,
      eventOccurredAt: canonical.event.occurredAt,
      eventUpdatedAt: canonical.event.updatedAt,
      observationPhase: canonical.event.observationPhase,
      source: canonical.event.source,
      sourceUrl: canonical.event.sourceUrl,
      locationQuality: canonical.event.locationQuality,
      locationAccuracyKm: canonical.event.locationAccuracyKm,
      evidenceCount: canonical.event.evidenceCount,
      cycloneForecast: canonical.event.cycloneForecast,
      sourceGeometry,
    };
    const draft = { ...task, ...canonicalFields, approvedAt, approvedBy, eventRevision: currentEventRevision };
    const rebuiltAoi = buildTaskAoi(draft);
    if (!rebuiltAoi) return Response.json({ error: "服务端无法重建任务 AOI" }, { status: 400 });
    const approvedTask = { ...draft, aoiHash: aoiFingerprint(rebuiltAoi) };
    const finalValidation = validateSatelliteTask(approvedTask, { requireApproved: true, requireProvenance: true });
    if (!finalValidation.ok) return Response.json({ error: "任务校验失败", errors: finalValidation.errors }, { status: 400 });
    return Response.json({ task: await upsertSatelliteTask(approvedTask as Parameters<typeof upsertSatelliteTask>[0]), storage: "operational-database" });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /不允许的任务状态转换|任务已被其他请求更新|任务版本冲突|revision/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    console.error("task save unavailable", error);
    return Response.json({ error: "任务保存失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "task-delete", 30);
  if (limited) return limited;
  const parameters = new URL(request.url).searchParams;
  const taskId = parameters.get("taskId");
  const revisionValue = parameters.get("revision");
  const revision = revisionValue === null ? undefined : Number(revisionValue);
  if (!taskId || taskId.length > 220) return Response.json({ error: "缺少或无效 taskId" }, { status: 400 });
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) return Response.json({ error: "revision 必须是正整数" }, { status: 400 });
  try {
    const result = await deleteSatelliteTask(taskId, revision, apiActor(request));
    return Response.json({ deleted: taskId, ...result });
  } catch (error) {
    if (error instanceof Error && /不允许取消|任务已被其他请求更新|任务版本冲突/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    console.error("task delete unavailable", error);
    return Response.json({ error: "任务删除失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}
