import { ApiInputError, authorizeApiRequest, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { validateSatelliteTask, validateTaskAoi } from "../../../lib/task-contract";
import { getCanonicalEventForTask } from "../../../db/operational";
import { buildTaskAoi } from "../../../lib/task-aoi";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  let task: Record<string, unknown>;
  try { task = await readJsonObject(request); }
  catch (error) { return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "请求无效" }, { status: error instanceof ApiInputError ? error.status : 400 }); }
  const validation = validateSatelliteTask(task, { requireApproved: true });
  if (!validation.ok) return Response.json({ state: "error", windows: [], message: validation.errors.join("；") }, { status: 400 });
  if (!validateTaskAoi(task, task.aoi)) return Response.json({ state: "error", windows: [], message: "任务 AOI 几何无效或与来源几何不一致" }, { status: 400 });
  const aoi = buildTaskAoi(task);
  if (!aoi) return Response.json({ state: "error", windows: [], message: "服务端无法重建任务 AOI" }, { status: 400 });
  const canonical = await getCanonicalEventForTask(String(task.masterEventId));
  if (!canonical || ["resolved", "archived"].includes(canonical.lifecycleStatus) || Date.parse(canonical.observationExpiresAt) <= Date.now()) {
    return Response.json({ state: "error", windows: [], message: "关联主事件不存在、已解除或已超过观测期" }, { status: 409 });
  }
  const endpoint = process.env.SATELLITE_VISIBILITY_API_URL;
  if (!endpoint) {
    return Response.json({ state: "needs_config", windows: [], message: "尚未配置卫星仿真/可见性服务地址 SATELLITE_VISIBILITY_API_URL" }, { status: 503 });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ schemaVersion: "tianxun.visibility.v1", task: { ...task, aoi } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!upstream.ok) throw new Error(`仿真服务返回 HTTP ${upstream.status}`);
    const result = await upstream.json() as { windows?: Array<Record<string, unknown>> };
    if (!Array.isArray(result.windows)) throw new Error("仿真服务响应缺少 windows 数组");
    const windows = result.windows.map(normalizeWindow).filter((window): window is NonNullable<typeof window> => window !== null);
    if (result.windows.length && !windows.length) throw new Error("仿真服务没有返回有效的 UTC 可见窗口");
    return Response.json({ ...result, windows, state: "ready" });
  } catch (error) {
    return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "可见性计算失败" }, { status: 502 });
  }
}

function normalizeWindow(window: Record<string, unknown>) {
  const start = new Date(String(window.start ?? window.startTime ?? ""));
  const end = new Date(String(window.end ?? window.endTime ?? ""));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const coverage = Number(window.coveragePercent ?? window.coverage);
  const lookAngle = Number(window.lookAngleDeg ?? window.lookAngle);
  return {
    satelliteId: String(window.satelliteId ?? window.satellite ?? window.name ?? "卫星"),
    start: start.toISOString(),
    end: end.toISOString(),
    coveragePercent: Number.isFinite(coverage) ? Math.min(100, Math.max(0, coverage)) : undefined,
    lookAngleDeg: Number.isFinite(lookAngle) ? lookAngle : undefined,
  };
}
