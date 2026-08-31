import { getCanonicalEventForTask, getEventExposureAssessment, getOsmQueryCache, upsertEventExposureAssessment, upsertOsmQueryCache } from "../../../db/operational.ts";
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
  type PopulationExposurePart,
  type WorldPopRequestChunk,
} from "../../../lib/exposure-assessment.ts";
import { overpassCacheKey, overpassFreshUntil, resolveOverpassRuntimeConfig, type OverpassRuntimeConfig } from "../../../lib/overpass-runtime.ts";

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
    const stale = Boolean(assessment && (assessment.eventRevision !== identity.eventRevision || assessment.aoiHash !== identity.aoiHash || assessment.modelVersion !== exposureAssessmentModelVersion));
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
    const overpassConfig = resolveOverpassRuntimeConfig();
    const sameInput = cached?.eventRevision === identity.eventRevision && cached.aoiHash === identity.aoiHash && cached.modelVersion === exposureAssessmentModelVersion;
    const sameOsmProfile = cached?.osm.dataProfile === overpassConfig.profile;
    const fresh = sameInput && sameOsmProfile && Date.parse(cached!.expiresAt) > Date.now();
    if (!force && fresh && cached!.status !== "pending") return Response.json({ assessment: cached }, { headers: privateHeaders("hit") });

    const actor = await apiActor(request);
    const year = configuredWorldPopYear();
    const reusablePending = !force && sameInput && cached?.population.state === "pending" ? cached.population : undefined;
    const [population, osm] = await Promise.all([
      fetchPopulation(identity.aoi, year, reusablePending),
      fetchOsmExposure(identity.aoi, overpassConfig, force),
    ]);
    const computedAt = new Date().toISOString();
    const osmFetchedAt = osm.state === "ready" && osm.fetchedAt ? Date.parse(osm.fetchedAt) : Number.NaN;
    const osmFreshRemainingMs = Number.isFinite(osmFetchedAt) ? Math.max(15 * 60_000, osmFetchedAt + overpassConfig.cacheTtlMs - Date.now()) : overpassConfig.cacheTtlMs;
    const assessmentTtlMs = population.state === "pending"
      ? 60 * 60_000
      : osm.state === "ready" ? (osm.cacheStatus === "stale" ? 60 * 60_000 : Math.min(overpassConfig.cacheTtlMs, osmFreshRemainingMs)) : 6 * 60 * 60_000;
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
      expiresAt: new Date(Date.now() + assessmentTtlMs).toISOString(),
      updatedBy: actor,
      limitations: [
        "该结果是暴露度筛查，不是受灾、受损、伤亡或经济损失评估。",
        "WorldPop 是指定年份人口模型估计，不代表灾害发生时刻的人口分布。",
        "OSM 为志愿者维护的已映射要素；零记录或缺失记录不能证明现实中不存在。",
        identity.aoi.basis === "derived_screening_buffer" ? "当前没有可直接采用的官方影响面，AOI 为事件代表点缓冲区，需要在地图中核对。" : "AOI 采用来源几何，但来源范围不等于实际受灾边界。",
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
  const plan = worldPopRequestPlan(aoi, year, process.env.WORLDPOP_API_KEY?.trim() ? 500_000 : 50_000);
  if (plan.state === "skipped") return { state: "skipped", provider: "WorldPop", year: plan.year, resolution: plan.resolution, message: plan.message };
  if ("chunks" in plan && plan.chunks) return fetchPartitionedPopulation(plan.chunks, aoi.areaKm2, plan.year, plan.resolution, pending);
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

async function fetchPartitionedPopulation(chunks: WorldPopRequestChunk[], totalAreaKm2: number, year: number, resolution: "100m" | "1km", pending?: PopulationExposure): Promise<PopulationExposure> {
  const endpoint = worldPopEndpoint();
  const previous = new Map((pending?.parts ?? []).map((part) => [part.chunkId, part]));
  const parts = await Promise.all(chunks.map((chunk) => fetchPopulationPart(endpoint, chunk, year, resolution, previous.get(chunk.chunkId))));
  const ready = parts.filter((part) => part.state === "ready" && part.totalPopulation !== undefined);
  const completedParts = ready.length;
  if (completedParts === chunks.length) {
    const totalPopulation = ready.reduce((sum, part) => sum + (part.totalPopulation ?? 0), 0);
    const sources = [...new Set(ready.map((part) => part.dataSource).filter((value): value is string => Boolean(value)))];
    return {
      state: "ready",
      provider: "WorldPop",
      year,
      resolution,
      totalPopulation,
      populationDensityPerKm2: totalAreaKm2 > 0 ? totalPopulation / totalAreaKm2 : undefined,
      dataSource: sources.length ? sources.join("；") : undefined,
      processingTimeMs: ready.reduce((sum, part) => sum + (part.processingTimeMs ?? 0), 0) || undefined,
      completedParts,
      totalParts: chunks.length,
      parts,
      message: `已完成 ${chunks.length}/${chunks.length} 个安全分块；人口为 WorldPop ${year} 年模型估计，不是实时人口或现场普查`,
    };
  }
  const active = parts.some((part) => part.state === "pending");
  return {
    state: "pending",
    provider: "WorldPop",
    year,
    resolution,
    completedParts,
    totalParts: chunks.length,
    parts,
    message: `${active ? "WorldPop 正在分块计算" : "WorldPop 部分分块暂时失败"}；已完成 ${completedParts}/${chunks.length}，系统会保留已完成结果，重试时不会重复提交`,
  };
}

async function fetchPopulationPart(endpoint: URL, chunk: WorldPopRequestChunk, year: number, resolution: "100m" | "1km", prior?: PopulationExposurePart): Promise<PopulationExposurePart> {
  if (prior?.state === "ready" && prior.totalPopulation !== undefined) return prior;
  try {
    let population: PopulationExposure;
    if (prior?.state === "pending" && prior.taskId) {
      population = await requestWorldPopTask(endpoint, prior.taskId, year, resolution);
    } else {
      const response = await boundedFetch(new URL("population", endpoint).toString(), {
        method: "POST",
        headers: worldPopHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(chunk.payload),
      }, 12_000, 512 * 1024);
      population = parseWorldPopTask(JSON.parse(response), year, resolution);
    }
    for (let attempt = 0; population.state === "pending" && population.taskId && attempt < 4; attempt += 1) {
      await delay(700 + attempt * 250);
      population = await requestWorldPopTask(endpoint, population.taskId, year, resolution);
    }
    return {
      chunkId: chunk.chunkId,
      areaKm2: chunk.areaKm2,
      state: population.state === "ready" ? "ready" : "pending",
      taskId: population.taskId,
      totalPopulation: population.totalPopulation,
      populationDensityPerKm2: population.populationDensityPerKm2,
      dataSource: population.dataSource,
      processingTimeMs: population.processingTimeMs,
      message: population.message,
    };
  } catch (error) {
    return {
      chunkId: chunk.chunkId,
      areaKm2: chunk.areaKm2,
      state: "unavailable",
      taskId: prior?.taskId,
      message: safeUpstreamMessage(error, "WorldPop 分块暂时不可用"),
    };
  }
}

async function requestWorldPopTask(endpoint: URL, taskId: string, year: number, resolution: "100m" | "1km") {
  if (!/^[\w.-]{1,160}$/.test(taskId)) throw new Error("WorldPop task_id 无效");
  const response = await boundedFetch(new URL(`tasks/${encodeURIComponent(taskId)}`, endpoint).toString(), { headers: worldPopHeaders() }, 10_000, 512 * 1024);
  return parseWorldPopTask(JSON.parse(response), year, resolution, taskId);
}

async function fetchOsmExposure(aoi: ReturnType<typeof exposureAssessmentIdentity>["aoi"], config: OverpassRuntimeConfig, force: boolean): Promise<OsmExposure> {
  const plan = prepareOverpassExposureQuery(aoi, {
    maximumAreaKm2: config.maximumAreaKm2,
    serviceLabel: config.profileLabel,
    queryTimeoutSeconds: config.queryTimeoutSeconds,
  });
  if (plan.state === "skipped") return {
    state: "skipped",
    provider: "OpenStreetMap · Overpass",
    dataProfile: config.profile,
    updateCadence: config.updateCadence,
    facilityCounts: {},
    facilities: [],
    facilitiesTruncated: false,
    message: plan.message,
  };
  const cacheKey = overpassCacheKey(config, "exposure", plan.cacheIdentity);
  const cached = await readExposureCache(cacheKey);
  if (!force && cached && Date.parse(cached.expiresAt) > Date.now()) {
    return { ...cached.payload, cacheStatus: "fresh", dataProfile: config.profile, updateCadence: config.updateCadence };
  }
  try {
    const response = await boundedFetch(config.endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": config.userAgent,
      },
      body: new URLSearchParams({ data: plan.query }).toString(),
    }, (config.queryTimeoutSeconds + 5) * 1_000, 6 * 1024 * 1024);
    const result = parseOverpassExposure(JSON.parse(response));
    const fetchedAt = new Date().toISOString();
    const ready: OsmExposure = {
      state: "ready",
      provider: "OpenStreetMap · Overpass",
      ...result,
      fetchedAt,
      cacheStatus: "refreshed",
      dataProfile: config.profile,
      updateCadence: config.updateCadence,
      message: `${config.profileLabel} · ${plan.queryBasis}；建筑和道路是已映射要素计数，关键设施最多返回 300 个地图点位`,
    };
    await writeExposureCache(cacheKey, ready, config);
    return ready;
  } catch (error) {
    const cachedFetchedAt = cached ? Date.parse(cached.fetchedAt) : Number.NaN;
    if (cached && Number.isFinite(cachedFetchedAt) && cachedFetchedAt + config.staleIfErrorMs > Date.now()) {
      return {
        ...cached.payload,
        cacheStatus: "stale",
        dataProfile: config.profile,
        updateCadence: config.updateCadence,
        message: `${cached.payload.message}；${config.profileLabel}刷新失败，当前使用 ${cached.fetchedAt} 的过期缓存，禁止据此认定设施或道路没有变化`,
      };
    }
    return {
      state: "unavailable",
      provider: "OpenStreetMap · Overpass",
      dataProfile: config.profile,
      updateCadence: config.updateCadence,
      facilityCounts: {},
      facilities: [],
      facilitiesTruncated: false,
      message: safeUpstreamMessage(error, `${config.profileLabel}当前不可用`),
    };
  }
}

function worldPopEndpoint() {
  return publicHttpsBaseUrl(process.env.WORLDPOP_API_URL?.trim() || "https://api.worldpop.org/v2/", "WORLDPOP_API_URL");
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

async function readExposureCache(cacheKey: string) {
  try {
    const cached = await getOsmQueryCache<OsmExposure>(cacheKey, "exposure");
    return cached?.payload.state === "ready" && Array.isArray(cached.payload.facilities) && cached.payload.facilities.length <= 300 ? cached : null;
  } catch {
    return null;
  }
}

async function writeExposureCache(cacheKey: string, payload: OsmExposure, config: OverpassRuntimeConfig) {
  try {
    await upsertOsmQueryCache({
      cacheKey,
      queryKind: "exposure",
      dataProfile: config.profile,
      payload,
      fetchedAt: payload.fetchedAt!,
      expiresAt: overpassFreshUntil(payload.fetchedAt!, config),
      osmBaseTimestamp: payload.osmBaseTimestamp,
    });
  } catch {
    // Event-level persistence still keeps the assessment usable when the shared cache is unavailable.
  }
}
