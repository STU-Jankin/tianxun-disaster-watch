import { deleteSatelliteTask, getCanonicalEventForTask, getSatelliteTask, listSatelliteTaskCancellationIds, listSatelliteTasks, upsertSatelliteTask } from "../../../db/operational";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { unknownTaskFields, validateSatelliteTask } from "../../../lib/task-contract";
import { aoiFingerprint, eventRevisionFingerprint } from "../../../lib/event-integrity";
import { buildTaskAoi } from "../../../lib/task-aoi";
import { cycloneTaskAoiSlices } from "../../../lib/cyclone-forecast";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  try {
    const actor = await apiActor(request);
    const owner = await apiRole(request) === "admin" ? undefined : actor;
    const [tasks, cancelledTaskIds] = await Promise.all([listSatelliteTasks(owner), listSatelliteTaskCancellationIds(owner)]);
    return Response.json({ tasks, cancelledTaskIds, storage: "operational-database" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("task database unavailable", error);
    return Response.json({ error: "任务数据库暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "task-write", 60);
  if (limited) return limited;
  try {
    const task = await readJsonObject(request, 256 * 1024);
    const unknownFields = unknownTaskFields(task);
    if (unknownFields.length) return Response.json({ error: "任务包含未允许字段", fields: unknownFields.slice(0, 20) }, { status: 400 });
    const masterEventId = typeof task.masterEventId === "string" ? task.masterEventId.trim() : "";
    if (!masterEventId || masterEventId.length > 220) return Response.json({ error: "缺少或无效 masterEventId" }, { status: 400 });
    if (!["candidate", "reviewed"].includes(String(task.status))) {
      return Response.json({ error: "操作员入口只允许维护候选和已复核状态；排程、下发、成像与完成必须由仿真/执行回执接口产生" }, { status: 403 });
    }
    const canonical = await getCanonicalEventForTask(masterEventId, {
      eventId: typeof task.eventId === "string" ? task.eventId : undefined,
      entityKey: typeof task.entityKey === "string" ? task.entityKey : undefined,
      hazard: typeof task.hazard === "string" ? task.hazard : undefined,
    });
    if (!canonical) return Response.json({ error: "主事件已更新、归档或尚未可靠入库；请刷新事件后重新建立任务" }, { status: 409 });
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
    const cycloneForecast = canonical.event.cycloneForecast;
    if (cycloneForecast?.impactField && task.aoiType === "source" && Date.parse(String(task.imagingEnd)) > Date.parse(cycloneForecast.forecastValidUntil)) {
      return Response.json({ error: "台风逐时影响场任务不能超过当前官方报次有效期；请缩短成像窗或等待新报次" }, { status: 409 });
    }
    if (task.aoiApproval === "source_verified") {
      if (canonical.event.dispatchEligibility !== "ready") return Response.json({ error: "来源坐标不具备直接下发资格，必须由操作员复核 AOI" }, { status: 409 });
      if (task.aoiType !== "source") return Response.json({ error: "来源核验任务必须使用当前主事件的来源几何" }, { status: 409 });
    }
    const timeIndexedAoi = cycloneTaskAoiSlices(cycloneForecast, String(task.imagingStart), String(task.imagingEnd));
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
      eventIssuedAt: canonical.event.issuedAt,
      eventValidFrom: canonical.event.validFrom,
      eventValidTo: canonical.event.validTo,
      phenomenonStage: canonical.event.phenomenonStage,
      observationPhase: canonical.event.observationPhase,
      source: canonical.event.source,
      sourceUrl: canonical.event.sourceUrl,
      locationQuality: canonical.event.locationQuality,
      locationAccuracyKm: canonical.event.locationAccuracyKm,
      evidenceCount: canonical.event.evidenceCount,
      cycloneForecast,
      forecastAdvisoryId: cycloneForecast ? `${cycloneForecast.source}:${cycloneForecast.advisory ?? cycloneForecast.issuedAt}` : undefined,
      forecastIssuedAt: cycloneForecast?.issuedAt,
      forecastValidUntil: cycloneForecast?.forecastValidUntil,
      timeIndexedAoi: timeIndexedAoi.length ? timeIndexedAoi : undefined,
      sourceGeometry,
    };
    const draft = { ...task, ...canonicalFields, eventRevision: currentEventRevision };
    const validation = validateSatelliteTask(draft);
    if (!validation.ok) return Response.json({ error: "任务校验失败", errors: validation.errors }, { status: 400 });
    const rebuiltAoi = buildTaskAoi(draft);
    if (!rebuiltAoi) return Response.json({ error: "服务端无法重建任务 AOI" }, { status: 400 });
    const nextAoiHash = aoiFingerprint(rebuiltAoi);
    const actor = await apiActor(request);
    const isAdmin = await apiRole(request) === "admin";
    const existing = typeof task.taskId === "string" ? await getSatelliteTask(task.taskId, isAdmin ? undefined : actor) as Record<string, unknown> | null : null;
    const approvalUnchanged = task.aoiApproval === "operator_confirmed" && existing?.aoiApproval === "operator_confirmed" && existing.aoiHash === nextAoiHash;
    const approvedAt = task.aoiApproval === "operator_confirmed"
      ? approvalUnchanged ? existing?.approvedAt : new Date().toISOString()
      : canonical.event.updatedAt;
    const approvedBy = task.aoiApproval === "operator_confirmed"
      ? approvalUnchanged ? existing?.approvedBy : actor
      : canonical.event.source;
    const approvedTask = { ...draft, approvedAt, approvedBy, aoiHash: nextAoiHash };
    const finalValidation = validateSatelliteTask(approvedTask, { requireApproved: true, requireProvenance: true });
    if (!finalValidation.ok) return Response.json({ error: "任务校验失败", errors: finalValidation.errors }, { status: 400 });
    return Response.json({ task: await upsertSatelliteTask(approvedTask as Parameters<typeof upsertSatelliteTask>[0], { payloadJson: JSON.stringify(canonical.event) }, actor, isAdmin), storage: "operational-database" });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /任务不属于当前操作员/.test(error.message)) return Response.json({ error: "任务不存在或不属于当前操作员" }, { status: 404 });
    if (error instanceof Error && /不允许的任务状态转换|任务.*其他请求更新|主事件.*发生变化|任务版本冲突|任务已取消|revision/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    console.error("task save unavailable", error);
    return Response.json({ error: "任务保存失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "task-delete", 30);
  if (limited) return limited;
  const parameters = new URL(request.url).searchParams;
  const taskId = parameters.get("taskId");
  const revisionValue = parameters.get("revision");
  const revision = revisionValue === null ? undefined : Number(revisionValue);
  if (!taskId || taskId.length > 220) return Response.json({ error: "缺少或无效 taskId" }, { status: 400 });
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) return Response.json({ error: "revision 必须是非负整数" }, { status: 400 });
  try {
    const actor = await apiActor(request);
    const result = await deleteSatelliteTask(taskId, revision, actor, "操作员取消任务", await apiRole(request) === "admin");
    return Response.json({ deleted: taskId, ...result });
  } catch (error) {
    if (error instanceof Error && /任务不属于当前操作员/.test(error.message)) return Response.json({ error: "任务不存在或不属于当前操作员" }, { status: 404 });
    if (error instanceof Error && /不允许取消|任务已被其他请求更新|任务版本冲突/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    console.error("task delete unavailable", error);
    return Response.json({ error: "任务删除失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}
