import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { unknownTaskFields, validateSatelliteTask } from "../../../lib/task-contract";
import { getCanonicalEventForTask, getSatelliteTask, listSatelliteOrbitCache } from "../../../db/operational";
import { buildTaskAoi } from "../../../lib/task-aoi";
import { aoiFingerprint, eventRevisionFingerprint, geometryEquals } from "../../../lib/event-integrity";
import { buildSatelliteOrbitSnapshot } from "../../../lib/satellite-orbits";
import { screenTleOpportunities } from "../../../lib/tle-opportunities";
import { screenConfiguredSarOpportunities } from "../../../lib/configured-sar-opportunities";
import type { SarImagingModeId } from "../../../lib/satellite-payloads";
import { cycloneTaskAoiSlices, type CycloneTaskAoiSlice } from "../../../lib/cyclone-forecast";
import {
  cycloneTrackingTargets,
  screenCycloneConfiguredSarOpportunities,
  screenCycloneTleOpportunities,
  type CycloneTrackingTarget,
} from "../../../lib/cyclone-tracking-opportunities";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "visibility", 20);
  if (limited) return limited;
  let requestTask: Record<string, unknown>;
  try { requestTask = await readJsonObject(request); }
  catch (error) { return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "请求无效" }, { status: error instanceof ApiInputError ? error.status : 400 }); }
  const taskId = typeof requestTask.taskId === "string" ? requestTask.taskId.trim() : "";
  if (!taskId) return Response.json({ state: "error", windows: [], message: "缺少 taskId" }, { status: 400 });
  const actor = await apiActor(request);
  const role = await apiRole(request);
  const statelessPublicTrial = request.headers.get("x-tianxun-stateless-visibility") === "1" && actor.startsWith("public-");
  let storedTask;
  try { storedTask = await getSatelliteTask(taskId, role === "admin" ? undefined : actor); }
  catch (error) {
    console.error("visibility task lookup unavailable", error);
    return Response.json({ state: "error", windows: [], message: "任务数据库暂不可用" }, { status: 503 });
  }
  let canonical: Awaited<ReturnType<typeof getCanonicalEventForTask>> = null;
  let task: Record<string, unknown>;
  if (storedTask) {
    if (Number(requestTask.revision) !== Number(storedTask.revision)) {
      return Response.json({ state: "error", windows: [], message: "任务已有新版本，请刷新后重新计算" }, { status: 409 });
    }
    task = storedTask as Record<string, unknown>;
  } else if (statelessPublicTrial) {
    const unknownFields = unknownTaskFields(requestTask);
    if (unknownFields.length) return Response.json({ state: "error", windows: [], message: "任务包含未允许字段" }, { status: 400 });
    if (!["candidate", "reviewed"].includes(String(requestTask.status))) {
      return Response.json({ state: "error", windows: [], message: "试算只接受候选或已复核任务" }, { status: 400 });
    }
    const masterEventId = typeof requestTask.masterEventId === "string" ? requestTask.masterEventId.trim() : "";
    if (!masterEventId) return Response.json({ state: "error", windows: [], message: "缺少 masterEventId" }, { status: 400 });
    canonical = await getCanonicalEventForTask(masterEventId, {
      eventId: typeof requestTask.eventId === "string" ? requestTask.eventId : undefined,
      entityKey: typeof requestTask.entityKey === "string" ? requestTask.entityKey : undefined,
      hazard: typeof requestTask.hazard === "string" ? requestTask.hazard : undefined,
    });
    if (!canonical) return Response.json({ state: "error", windows: [], message: "主事件不存在或尚未可靠入库" }, { status: 409 });
    const sourceGeometry = canonical.event.cycloneForecast?.impactGeometry ?? canonical.event.geometry;
    if (requestTask.aoiApproval === "source_verified" && (canonical.event.dispatchEligibility !== "ready" || requestTask.aoiType !== "source")) {
      return Response.json({ state: "error", windows: [], message: "来源坐标不具备直接试算资格，请先人工核对 AOI" }, { status: 409 });
    }
    const statelessTimeIndexedAoi = cycloneTaskAoiSlices(canonical.event.cycloneForecast, String(requestTask.imagingStart), String(requestTask.imagingEnd));
    task = {
      ...requestTask,
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
      cycloneForecast: canonical.event.cycloneForecast,
      timeIndexedAoi: statelessTimeIndexedAoi.length ? statelessTimeIndexedAoi : undefined,
      forecastAdvisoryId: canonical.event.cycloneForecast ? `${canonical.event.cycloneForecast.source}:${canonical.event.cycloneForecast.advisory ?? canonical.event.cycloneForecast.issuedAt}` : undefined,
      forecastIssuedAt: canonical.event.cycloneForecast?.issuedAt,
      forecastValidUntil: canonical.event.cycloneForecast?.forecastValidUntil,
      sourceGeometry,
      eventRevision: eventRevisionFingerprint(canonical.event),
      approvedAt: new Date().toISOString(),
      approvedBy: actor,
    };
    const statelessAoi = buildTaskAoi(task);
    if (!statelessAoi) return Response.json({ state: "error", windows: [], message: "服务端无法重建任务 AOI" }, { status: 400 });
    task.aoiHash = aoiFingerprint(statelessAoi);
  } else {
    return Response.json({ state: "error", windows: [], message: "任务尚未保存、已取消或不存在" }, { status: 404 });
  }
  const validation = validateSatelliteTask(task, { requireApproved: true, requirePayload: true, requireProvenance: true });
  if (!validation.ok) return Response.json({ state: "error", windows: [], message: validation.errors.join("；") }, { status: 400 });
  const aoi = buildTaskAoi(task);
  if (!aoi) return Response.json({ state: "error", windows: [], message: "服务端无法重建任务 AOI" }, { status: 400 });
  canonical ??= await getCanonicalEventForTask(String(task.masterEventId));
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
  const trackingSlices = task.hazard === "cyclone" && task.aoiType === "source" && Array.isArray(task.timeIndexedAoi)
    ? task.timeIndexedAoi as CycloneTaskAoiSlice[]
    : [];
  const trackingTarget = cycloneTrackingTarget(task.cycloneTrackingTarget);
  const dynamicCycloneTracking = trackingSlices.length > 0;
  const endpoint = process.env.SATELLITE_VISIBILITY_API_URL;
  if (!endpoint) {
    if (!Array.isArray(task.sensors) || !task.sensors.includes("SAR")) {
      return Response.json({ state: "error", mode: "orbit_only", windows: [], message: "当前内置任务模型仅配置了 SAR 星座；光学卫星轨道、相机视场和机动参数尚未登记，暂不能计算光学机会" }, { status: 400 });
    }
    try {
      const satellites = buildSatelliteOrbitSnapshot(await listSatelliteOrbitCache());
      const now = new Date();
      const opticalPendingNote = task.sensors.includes("光学") ? "；光学载荷尚无星表与相机参数，本次结果仅包含 SAR 机会。" : "。";
      const imagingStart = new Date(Math.max(now.getTime(), Date.parse(String(task.imagingStart))));
      const configured = satellites.some((satellite) => satellite.orbitStatus === "current" && satellite.payloadProfile && satellite.identityStatus === "configured");
      if (configured) {
        const common = {
          imagingStart,
          imagingEnd: String(task.imagingEnd),
          satellites,
          incidenceAngleMinDeg: Number(task.incidenceAngleMinDeg),
          incidenceAngleMaxDeg: Number(task.incidenceAngleMaxDeg),
          spatialResolutionMeters: Number(task.spatialResolutionMeters),
          minimumCoveragePercent: Number(task.minimumCoveragePercent),
          sarImagingModeIds: Array.isArray(task.sarImagingModes) ? task.sarImagingModes as SarImagingModeId[] : undefined,
          orbitDirectionPreference: ["ascending", "descending"].includes(String(task.orbitDirectionPreference)) ? task.orbitDirectionPreference as "ascending" | "descending" : "either" as const,
          now,
        };
        const result = dynamicCycloneTracking
          ? screenCycloneConfiguredSarOpportunities({ ...common, slices: trackingSlices, target: trackingTarget, forecastAdvisoryId: String(task.forecastAdvisoryId ?? "") || undefined })
          : screenConfiguredSarOpportunities({ ...common, geometry: aoi });
        return Response.json({
          ...result,
          schemaVersion: "tianxun.visibility.v3",
          state: "ready",
          mode: "assumed_sensor",
          message: result.windows.length
            ? dynamicCycloneTracking
              ? `已按 ${"trackingSliceCount" in result ? result.trackingSliceCount : trackingSlices.length} 个逐时预测 AOI 匹配卫星过境，生成 ${result.windows.length} 个${trackingTargetLabel(trackingTarget)}跟踪机会；新报次到达后必须重算，禁止自动下发${opticalPendingNote}`
              : `已用 ${result.satelliteCount} 颗配置卫星生成 ${result.windows.length} 个假设传感器机会；可用于试排程，禁止自动下发${opticalPendingNote}`
            : dynamicCycloneTracking
              ? `已完成 ${trackingSlices.length} 个逐时预测 AOI 的动态匹配；当前没有同时满足轨道、入射角、分辨率和覆盖率的${trackingTargetLabel(trackingTarget)}跟踪机会${opticalPendingNote}`
              : `已完成 ${result.satelliteCount} 颗配置卫星的假设传感器计算；当前时间窗没有同时满足入射角、分辨率和覆盖率的机会${opticalPendingNote}`,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const common = {
        imagingStart,
        imagingEnd: String(task.imagingEnd),
        satellites,
        orbitDirectionPreference: ["ascending", "descending"].includes(String(task.orbitDirectionPreference)) ? task.orbitDirectionPreference as "ascending" | "descending" : "either" as const,
        searchRadiusKm: Number(process.env.TLE_ORBIT_SEARCH_RADIUS_KM ?? 350),
        now,
      };
      const result = dynamicCycloneTracking
        ? screenCycloneTleOpportunities({ ...common, slices: trackingSlices, target: trackingTarget, forecastAdvisoryId: String(task.forecastAdvisoryId ?? "") || undefined })
        : screenTleOpportunities({ ...common, geometry: aoi });
      return Response.json({
        ...result,
        schemaVersion: "tianxun.visibility.v3",
        state: "ready",
        mode: "orbit_only",
        message: result.windows.length
          ? dynamicCycloneTracking
            ? `已按逐时台风${trackingTargetLabel(trackingTarget)}生成 ${result.windows.length} 个动态轨道近接候选；仅供排程粗筛，不代表 SAR 可成像。`
            : `已用 ${result.satelliteCount} 颗当前 TLE 生成 ${result.windows.length} 个轨道近接候选；仅供排程粗筛，不代表 SAR 可成像。`
          : dynamicCycloneTracking
            ? `已完成逐时台风${trackingTargetLabel(trackingTarget)}轨道匹配，当前时间窗内未发现近接候选。`
            : `已完成 ${result.satelliteCount} 颗卫星的 TLE 轨道粗筛，当前时间窗内未发现满足搜索半径的近接候选。`,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ state: "error", mode: "orbit_only", windows: [], message: error instanceof Error ? error.message : "本地 TLE 轨道粗筛失败" }, { status: 503 });
    }
  }
  if (dynamicCycloneTracking) {
    return Response.json({ state: "error", windows: [], message: "已配置的外部仿真接口尚未声明支持逐时移动 AOI；为防止把静态风圈误当成台风跟踪结果，本次计算已停止" }, { status: 501 });
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
    const orbitVersion = boundedText(result.orbitVersion, 120);
    const computedAt = validIso(result.computedAt) ?? new Date().toISOString();
    const windows = result.windows.map((window) => normalizeWindow(window, task, orbitVersion, computedAt)).filter((window): window is NonNullable<typeof window> => window !== null);
    if (result.windows.length && !windows.length) throw new Error("仿真服务没有返回有效的 UTC 可见窗口");
    return Response.json({ schemaVersion: "tianxun.visibility.v3", mode: "sensor_model", orbitVersion, computedAt, windows, state: "ready", message: "已由外部传感器级仿真服务返回可见窗口；仍需按任务约束复核后方可排程。" });
  } catch (error) {
    return Response.json({ state: "error", windows: [], message: error instanceof Error ? error.message : "可见性计算失败" }, { status: 502 });
  }
}

function cycloneTrackingTarget(value: unknown): CycloneTrackingTarget {
  return cycloneTrackingTargets.includes(value as CycloneTrackingTarget) ? value as CycloneTrackingTarget : "center";
}

function trackingTargetLabel(value: CycloneTrackingTarget) {
  return value === "center" ? "预测中心" : value === "wind_field" ? "风圈" : "不确定区";
}

function normalizeWindow(window: Record<string, unknown>, task: Record<string, unknown>, orbitVersion: string, computedAt: string) {
  const start = new Date(String(window.start ?? window.startTime ?? ""));
  const end = new Date(String(window.end ?? window.endTime ?? ""));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const taskStart = Date.parse(String(task.imagingStart));
  const taskEnd = Date.parse(String(task.imagingEnd));
  if (start.getTime() < taskStart || end.getTime() > taskEnd) return null;
  const coverage = Number(window.coveragePercent ?? window.coverage);
  const incidenceAngle = Number(window.incidenceAngleDeg ?? window.groundIncidenceAngleDeg);
  const offNadirAngle = Number(window.offNadirAngleDeg ?? window.lookAngleDeg ?? window.lookAngle);
  const orbitDirection = ["ascending", "descending"].includes(String(window.orbitDirection ?? window.direction)) ? String(window.orbitDirection ?? window.direction) : undefined;
  if (Number.isFinite(coverage) && coverage < Number(task.minimumCoveragePercent)) return null;
  if (Number.isFinite(incidenceAngle) && (incidenceAngle < Number(task.incidenceAngleMinDeg) || incidenceAngle > Number(task.incidenceAngleMaxDeg))) return null;
  if (["ascending", "descending"].includes(String(task.orbitDirectionPreference)) && orbitDirection && orbitDirection !== task.orbitDirectionPreference) return null;
  const constraintNotes = [];
  if (!Number.isFinite(coverage)) constraintNotes.push("仿真服务未返回覆盖率，尚未验证最低覆盖约束");
  if (!Number.isFinite(incidenceAngle)) constraintNotes.push("仿真服务未返回地面入射角；离轴/侧摆角不会代替入射角参与判定");
  if (["ascending", "descending"].includes(String(task.orbitDirectionPreference)) && !orbitDirection) constraintNotes.push("仿真服务未返回轨向，尚未验证升降轨偏好");
  const satelliteId = boundedText(window.satelliteId ?? window.satellite ?? window.name ?? "", 120);
  if (!satelliteId) return null;
  const opportunityId = boundedText(window.opportunityId, 160) || `SIM-${aoiFingerprint({ satelliteId, start: start.toISOString(), end: end.toISOString(), orbitVersion, aoiHash: task.aoiHash }).slice(0, 24)}`;
  return {
    opportunityId,
    satelliteId,
    satelliteNoradId: Number.isInteger(Number(window.satelliteNoradId ?? window.noradId)) ? Number(window.satelliteNoradId ?? window.noradId) : undefined,
    instrumentId: boundedText(window.instrumentId, 120) || undefined,
    imagingMode: boundedText(window.imagingMode, 120) || undefined,
    orbitVersion,
    computedAt,
    start: start.toISOString(),
    end: end.toISOString(),
    coveragePercent: Number.isFinite(coverage) ? Math.min(100, Math.max(0, coverage)) : undefined,
    incidenceAngleDeg: Number.isFinite(incidenceAngle) ? incidenceAngle : undefined,
    offNadirAngleDeg: Number.isFinite(offNadirAngle) ? offNadirAngle : undefined,
    orbitDirection,
    simulationLevel: "sensor_model" as const,
    constraintNotes,
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
