import { getTaskExportSnapshot, recordTaskExportPackage } from "../../../../db/operational";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { aoiFingerprint, eventRevisionFingerprint, geometryEquals } from "../../../../lib/event-integrity";
import { buildTaskAoi } from "../../../../lib/task-aoi";
import { buildTaskExportArtifact, type TaskExportFormat } from "../../../../lib/task-export";
import { validateSatelliteTask } from "../../../../lib/task-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request, "operator") ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "task-export", 10);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 64 * 1024);
    const format = String(body.format ?? "") as TaskExportFormat;
    if (!["json", "csv", "geojson"].includes(format)) return Response.json({ error: "不支持的导出格式" }, { status: 400 });
    const expected = Array.isArray(body.tasks) ? body.tasks : [];
    if (!expected.length || expected.length > 100) return Response.json({ error: "导出任务数量必须为 1–100" }, { status: 400 });
    const requested = expected.flatMap((item): Array<{ taskId: string; revision: number; eventRevision: string; aoiHash: string }> => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
      const revision = Number(value.revision);
      const eventRevision = typeof value.eventRevision === "string" ? value.eventRevision : "";
      const aoiHash = typeof value.aoiHash === "string" ? value.aoiHash : "";
      return taskId && taskId.length <= 220 && Number.isInteger(revision) && revision > 0 ? [{ taskId, revision, eventRevision, aoiHash }] : [];
    });
    if (requested.length !== expected.length || new Set(requested.map((item) => item.taskId)).size !== requested.length) return Response.json({ error: "导出任务引用无效或重复" }, { status: 400 });
    const actor = apiActor(request);
    const snapshot = await getTaskExportSnapshot(requested.map((item) => item.taskId), apiRole(request) === "admin" ? undefined : actor);
    const rows = new Map(snapshot.map((row) => [row.taskId, row]));
    const verified: Record<string, unknown>[] = [];
    for (const reference of requested) {
      const row = rows.get(reference.taskId);
      if (!row) return conflict(reference.taskId, "任务不存在、已取消或没有对应主事件");
      if (row.revision !== reference.revision || row.eventRevision !== reference.eventRevision || row.aoiHash !== reference.aoiHash) return conflict(reference.taskId, "任务版本已经变化");
      if (!["candidate", "reviewed"].includes(row.status)) return conflict(reference.taskId, "当前状态不是可导出的规划状态");
      if (["resolved", "archived"].includes(row.lifecycleStatus) || Date.parse(row.observationExpiresAt) <= Date.now() || row.activeEvidenceCount < 1) return conflict(reference.taskId, "主事件已解除、过期或失去有效证据");
      const canonicalRevision = eventRevisionFingerprint(row.event);
      if (canonicalRevision !== row.eventRevision) return conflict(reference.taskId, "主事件或官方报次已有新版本");
      const task = { ...row.task, status: row.status, revision: row.revision, eventRevision: row.eventRevision, aoiHash: row.aoiHash };
      const validation = validateSatelliteTask(task, { requireApproved: true, requirePayload: true, requireProvenance: true });
      if (!validation.ok) return conflict(reference.taskId, validation.errors.join("；"));
      const aoi = buildTaskAoi(task);
      if (!aoi || aoiFingerprint(aoi) !== row.aoiHash) return conflict(reference.taskId, "AOI 已变化或指纹不一致");
      const currentSourceGeometry = row.event.cycloneForecast?.impactGeometry ?? row.event.geometry;
      if (task.aoiApproval === "source_verified" && !geometryEquals(task.sourceGeometry as typeof currentSourceGeometry, currentSourceGeometry)) return conflict(reference.taskId, "来源几何已有新版本");
      if (Date.parse(String(task.imagingEnd)) > Date.parse(row.observationExpiresAt)) return conflict(reference.taskId, "成像窗口超过当前观测期");
      verified.push(task);
    }
    const artifact = buildTaskExportArtifact(verified, format, actor);
    if (new TextEncoder().encode(artifact.body).byteLength > 25 * 1024 * 1024) {
      return Response.json({ error: "任务包超过 25 MiB；请减少本次导出任务数或分批导出" }, { status: 413 });
    }
    await recordTaskExportPackage({
      packageId: artifact.packageId,
      format,
      taskIds: artifact.taskIds,
      masterEventIds: verified.map((task) => String(task.masterEventId)),
      payloadSha256: artifact.snapshotDigest,
      actor,
      createdAt: artifact.generatedAt,
    });
    return new Response(artifact.body, {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        "Cache-Control": "no-store",
        "X-Tianxun-Package-Id": artifact.packageId,
        "X-Tianxun-Snapshot-SHA256": artifact.snapshotDigest,
      },
    });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("task export unavailable", error);
    return Response.json({ error: "服务端任务包生成失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function conflict(taskId: string, reason: string) {
  return Response.json({ error: `任务 ${taskId} 不可导出：${reason}` }, { status: 409, headers: { "Cache-Control": "no-store" } });
}
