import { ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { validateSatelliteTask } from "../../../lib/task-contract";
import { getCanonicalEventForTask, getSatelliteTask } from "../../../db/operational";
import { buildTaskAoi } from "../../../lib/task-aoi";
import { aoiFingerprint, eventRevisionFingerprint, geometryEquals } from "../../../lib/event-integrity";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "visibility", 20);
  if (limited) return limited;
  let requestTask: Record<string, unknown>;
  try { requestTask = await readJsonObject(request); }
  catch (error) { return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "请求无效" }, { status: error instanceof ApiInputError ? error.status : 400 }); }
  const taskId = typeof requestTask.taskId === "string" ? requestTask.taskId.trim() : "";
  if (!taskId) return Response.json({ state: "error", windows: [], message: "缺少 taskId" }, { status: 400 });
  let storedTask;
  try { storedTask = await getSatelliteTask(taskId); }
  catch (error) {
    console.error("visibility task lookup unavailable", error);
    return Response.json({ state: "error", windows: [], message: "任务数据库暂不可用" }, { status: 503 });
  }
  if (!storedTask) return Response.json({ state: "error", windows: [], message: "任务尚未保存、已取消或不存在" }, { status: 404 });
  if (Number(requestTask.revision) !== Number(storedTask.revision)) {
    return Response.json({ state: "error", windows: [], message: "任务已有新版本，请刷新后重新计算" }, { status: 409 });
  }
  const task = storedTask as Record<string, unknown>;
  const validation = validateSatelliteTask(task, { requireApproved: true, requirePayload: true, requireProvenance: true });
  if (!validation.ok) return Response.json({ state: "error", windows: [], message: validation.errors.join("；") }, { status: 400 });
  const aoi = buildTaskAoi(task);
  if (!aoi) return Response.json({ state: "error", windows: [], message: "服务端无法重建任务 AOI" }, { status: 400 });
  const canonical = await getCanonicalEventForTask(String(task.masterEventId));
  if (!canonical || ["resolved", "archived"].includes(canonical.lifecycleStatus) || Date.parse(canonical.observationExpiresAt) <= Date.now()) {
    return Response.json({ state: "error", windows: [], message: "关联主事件不存在、已解除或已超过观测期" }, { status: 409 });
  }
  if (Date.parse(String(task.imagingEnd)) > Date.parse(canonical.observationExpiresAt)) {
    return Response.json({ state: "error", windows: [], message: "任务成像窗口已超过该灾害的有效观测期" }, { status: 409 });
  }
  if (task.eventRevision !== eventRevisionFingerprint(canonical.event)) return Response.json({ state: "error", windows: [], message: "主事件已有新版本，请重新核对 AOI 后再计算" }, { status: 409 });
  const sourceGeometry = canonical.event.cycloneForecast?.impactGeometry ?? canonical.event.geometry;
  if (task.aoiApproval === "source_verified" && !geometryEquals(task.sourceGeometry as typeof sourceGeometry, sourceGeometry)) {
    return Response.json({ state: "error", windows: [], message: "来源几何已变化，请重新建立任务" }, { status: 409 });
  }
  if (task.aoiHash !== aoiFingerprint(aoi)) return Response.json({ state: "error", windows: [], message: "AOI 指纹不一致，请重新保存任务" }, { status: 409 });
  const endpoint = process.env.SATELLITE_VISIBILITY_API_URL;
  if (!endpoint) {
    return Response.json({ state: "needs_config", windows: [], message: "尚未配置卫星仿真/可见性服务地址 SATELLITE_VISIBILITY_API_URL" }, { status: 503 });
  }
  try {
    const serviceUrl = validateSimulationEndpoint(endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ schemaVersion: "tianxun.visibility.v1", task: { ...task, aoi } }),
      signal: controller.signal,
      redirect: "manual",
    }).finally(() => clearTimeout(timeout));
    if (!upstream.ok) throw new Error(`仿真服务返回 HTTP ${upstream.status}`);
    const result = JSON.parse(await readLimitedResponse(upstream, 512_000)) as { windows?: Array<Record<string, unknown>>; orbitVersion?: unknown; computedAt?: unknown };
    if (!Array.isArray(result.windows)) throw new Error("仿真服务响应缺少 windows 数组");
    if (result.windows.length > 100) throw new Error("仿真服务返回的窗口数量超过上限");
    const windows = result.windows.map((window) => normalizeWindow(window, task)).filter((window): window is NonNullable<typeof window> => window !== null);
    if (result.windows.length && !windows.length) throw new Error("仿真服务没有返回有效的 UTC 可见窗口");
    return Response.json({ schemaVersion: "tianxun.visibility.v1", orbitVersion: boundedText(result.orbitVersion, 120), computedAt: validIso(result.computedAt) ?? new Date().toISOString(), windows, state: "ready" });
  } catch (error) {
    return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "可见性计算失败" }, { status: 502 });
  }
}

function normalizeWindow(window: Record<string, unknown>, task: Record<string, unknown>) {
  const start = new Date(String(window.start ?? window.startTime ?? ""));
  const end = new Date(String(window.end ?? window.endTime ?? ""));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const taskStart = Date.parse(String(task.imagingStart));
  const taskEnd = Date.parse(String(task.imagingEnd));
  if (start.getTime() < taskStart || end.getTime() > taskEnd) return null;
  const coverage = Number(window.coveragePercent ?? window.coverage);
  const lookAngle = Number(window.lookAngleDeg ?? window.lookAngle);
  if (Number.isFinite(coverage) && coverage < Number(task.minimumCoveragePercent)) return null;
  if (Number.isFinite(lookAngle) && (lookAngle < Number(task.incidenceAngleMinDeg) || lookAngle > Number(task.incidenceAngleMaxDeg))) return null;
  return {
    satelliteId: boundedText(window.satelliteId ?? window.satellite ?? window.name ?? "卫星", 120) || "卫星",
    start: start.toISOString(),
    end: end.toISOString(),
    coveragePercent: Number.isFinite(coverage) ? Math.min(100, Math.max(0, coverage)) : undefined,
    lookAngleDeg: Number.isFinite(lookAngle) ? lookAngle : undefined,
  };
}

function validateSimulationEndpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("仿真服务 URL 禁止内嵌凭据");
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("仿真服务必须使用 HTTPS，回环地址除外");
  return url.toString();
}

async function readLimitedResponse(response: Response, maximumBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("仿真响应超过安全上限");
  if (!response.body) return "{}";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error("仿真响应超过安全上限"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function validIso(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
