import { getCanonicalEventForTask, getEventExposureAssessment, upsertEventExposureAssessment } from "../../../db/operational.ts";
import { ApiInputError, apiActor, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security.ts";
import {
  exposureAssessmentIdentity,
  exposureAssessmentModelVersion,
  exposureAssessmentStatus,
  exposureRiskInput,
  parseOverpassExposure,
  parseWorldPopTask,
  prepareOverpassExposureQuery,
  worldPopRequestPlan,
  type ExposureAssessment,
  type OsmExposure,
  type PopulationExposure,
} from "../../../lib/exposure-assessment.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  const rateLimited = enforceRateLimit(request, "exposure-read", 30, 60_000);
  if (rateLimited) return rateLimited;
  try {
    const masterEventId = boundedId(new URL(request.url).searchParams.get("masterEventId"));
    const [canonical, assessment] = await Promise.all([
      getCanonicalEventForTask(masterEventId),
      getEventExposureAssessment(masterEventId),
    ]);
    if (!canonical) throw new ApiInputError("主事件不存在、已结束或缺少有效证据", 404);
    const identity = exposureAssessmentIdentity(canonical.event);
    const stale = Boolean(assessment && (assessment.eventRevision !== identity.eventRevision || assessment.aoiHash !== identity.aoiHash));
    return Response.json({ assessment: stale ? null : assessment, stale }, { headers: privateHeaders(stale ? "stale" : "read") });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  const rateLimited = enforceRateLimit(request, "exposure-compute", 4, 60_000);
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request, 8 * 1024);
    const masterEventId = boundedId(body.masterEventId);
    const force = body.force === true;
    const canonical = await getCanonicalEventForTask(masterEventId);
    if (!canonical) throw new ApiInputError("主事件不存在、已结束或缺少有效证据", 404);
    const identity = exposureAssessmentIdentity(canonical.event);
    const cached = await getEventExposureAssessment(masterEventId);
    const sameInput = cached?.eventRevision === identity.eventRevision && cached.aoiHash === identity.aoiHash;
    const fresh = sameInput && Date.parse(cached!.expiresAt) > Date.now();
    if (!force && fresh && cached!.status !== "pending") return Response.json({ assessment: cached }, { headers: privateHeaders("hit") });

    const actor = await apiActor(request);
    const year = configuredWorldPopYear();
    const reusablePending = !force && sameInput && cached?.population.state === "pending" ? cached.population : undefined;
    const reusableOsm = !force && sameInput && cached?.osm.state === "ready" ? cached.osm : undefined;
    const [population, osm] = await Promise.all([
      fetchPopulation(identity.aoi, year, reusablePending),
      reusableOsm ? Promise.resolve(reusableOsm) : fetchOsmExposure(identity.aoi),
    ]);
    const computedAt = new Date().toISOString();
    const assessment: ExposureAssessment = {
      masterEventId,
      eventRevision: identity.eventRevision,
      aoiHash: identity.aoiHash,
      status: exposureAssessmentStatus(population, osm),
      aoi: identity.aoi,
      population,
      osm,
      riskInput: exposureRiskInput(population, osm),
      computedAt,
      expiresAt: new Date(Date.now() + (population.state === "pending" ? 60 * 60_000 : 7 * 24 * 60 * 60_000)).toISOString(),
      updatedBy: actor,
      limitations: [
        "该结果是暴露度筛查，不是受灾、受损、伤亡或经济损失评估。",
        "WorldPop 是指定年份人口模型估计，不代表灾害发生时刻的人口分布。",
        "OSM 为志愿者维护的已映射要素；零记录或缺失记录不能证明现实中不存在。",
        identity.aoi.basis === "derived_screening_buffer" ? "当前没有可直接采用的官方影响面，AOI 为事件代表点缓冲区，必须由值守人员复核。" : "AOI 采用来源几何，但来源范围不等于实际受灾边界。",
      ],
      modelVersion: exposureAssessmentModelVersion,
    };
    await upsertEventExposureAssessment(assessment);
    return Response.json({ assessment }, { headers: privateHeaders("miss") });
  } catch (error) {
    return errorResponse(error);
  }
}

async function fetchPopulation(aoi: ReturnType<typeof exposureAssessmentIdentity>["aoi"], year: number, pending?: PopulationExposure): Promise<PopulationExposure> {
  const plan = worldPopRequestPlan(aoi, year);
  if (plan.state === "skipped") return { state: "skipped", provider: "WorldPop", year: plan.year, resolution: plan.resolution, message: plan.message };
  try {
    const endpoint = worldPopEndpoint();
    let population: PopulationExposure;
    if (pending?.taskId) {
      population = await requestWorldPopTask(endpoint, pending.taskId, plan.year, plan.resolution);
    } else {
      const response = await boundedFetch(new URL("population", endpoint).toString(), {
        method: "POST",
        headers: worldPopHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(plan.payload),
      }, 12_000, 512 * 1024);
      population = parseWorldPopTask(JSON.parse(response), plan.year, plan.resolution);
    }
    for (let attempt = 0; population.state === "pending" && population.taskId && attempt < 4; attempt += 1) {
      await delay(700 + attempt * 250);
      population = await requestWorldPopTask(endpoint, population.taskId, plan.year, plan.resolution);
    }
    return population;
  } catch (error) {
    return {
      state: "unavailable",
      provider: "WorldPop",
      year: plan.year,
      resolution: plan.resolution,
      taskId: pending?.taskId,
      message: safeUpstreamMessage(error, "WorldPop 当前不可用"),
    };
  }
}

async function requestWorldPopTask(endpoint: URL, taskId: string, year: number, resolution: "100m" | "1km") {
  if (!/^[\w.-]{1,160}$/.test(taskId)) throw new Error("WorldPop task_id 无效");
  const response = await boundedFetch(new URL(`tasks/${encodeURIComponent(taskId)}`, endpoint).toString(), { headers: worldPopHeaders() }, 10_000, 512 * 1024);
  return parseWorldPopTask(JSON.parse(response), year, resolution, taskId);
}

async function fetchOsmExposure(aoi: ReturnType<typeof exposureAssessmentIdentity>["aoi"]): Promise<OsmExposure> {
  const plan = prepareOverpassExposureQuery(aoi);
  if (plan.state === "skipped") return { state: "skipped", provider: "OpenStreetMap · Overpass", facilityCounts: {}, facilities: [], facilitiesTruncated: false, message: plan.message };
  try {
    const response = await boundedFetch(overpassEndpoint().toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": overpassUserAgent(),
      },
      body: new URLSearchParams({ data: plan.query }).toString(),
    }, 18_000, 6 * 1024 * 1024);
    const result = parseOverpassExposure(JSON.parse(response));
    return {
      state: "ready",
      provider: "OpenStreetMap · Overpass",
      ...result,
      fetchedAt: new Date().toISOString(),
      message: `${plan.queryBasis}；建筑和道路是已映射要素计数，关键设施最多返回 300 个地图点位`,
    };
  } catch (error) {
    return { state: "unavailable", provider: "OpenStreetMap · Overpass", facilityCounts: {}, facilities: [], facilitiesTruncated: false, message: safeUpstreamMessage(error, "公共 Overpass 当前不可用") };
  }
}

function worldPopEndpoint() {
  return publicHttpsBaseUrl(process.env.WORLDPOP_API_URL?.trim() || "https://api.worldpop.org/v2/", "WORLDPOP_API_URL");
}

function overpassEndpoint() {
  return publicHttpsBaseUrl(process.env.OVERPASS_API_URL?.trim() || "https://overpass-api.de/api/interpreter", "OVERPASS_API_URL", false);
}

function publicHttpsBaseUrl(raw: string, name: string, trailingSlash = true) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiInputError(`${name} 无效`, 503); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || privateLiteral(url.hostname)) throw new ApiInputError(`${name} 必须是无凭据的公网 HTTPS 地址`, 503);
  if (trailingSlash && !url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function worldPopHeaders(extra: Record<string, string> = {}) {
  const apiKey = process.env.WORLDPOP_API_KEY?.trim();
  return { Accept: "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}), ...extra };
}

function overpassUserAgent() {
  return process.env.OVERPASS_USER_AGENT?.trim().replace(/[\r\n]+/g, " ").slice(0, 180) || "Tianxun-Disaster-Watch/0.1 github.com/STU-Jankin/tianxun-disaster-watch";
}

function configuredWorldPopYear() {
  const parsed = Number(process.env.WORLDPOP_DATA_YEAR);
  return Number.isFinite(parsed) ? Math.max(2015, Math.min(2030, Math.round(parsed))) : Math.max(2015, Math.min(2030, new Date().getUTCFullYear()));
}

async function boundedFetch(url: string, init: RequestInit, timeoutMs: number, maximumBytes: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("上游响应超过安全上限");
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("上游响应超过安全上限");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

function boundedId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 240 || /[\r\n\0]/.test(id)) throw new ApiInputError("masterEventId 无效", 400);
  return id;
}

function privateHeaders(cache: string) {
  return { "Cache-Control": "private, no-store", "X-Tianxun-Cache": cache };
}

function errorResponse(error: unknown) {
  const aborted = error instanceof Error && error.name === "AbortError";
  const status = error instanceof ApiInputError ? error.status : 503;
  const message = aborted ? "外部暴露度数据查询超时，请稍后重试" : error instanceof Error ? error.message : "暴露度评估失败";
  return Response.json({ error: message.replace(/[\r\n]+/g, " ").slice(0, 280) }, { status, headers: privateHeaders("error") });
}

function safeUpstreamMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "AbortError") return `${fallback}：查询超时`;
  return `${fallback}：${error instanceof Error ? error.message : "未知错误"}`.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function privateLiteral(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0"].includes(host)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
