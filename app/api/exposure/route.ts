import { getCanonicalEventForTask, getEventExposureAssessment, getOsmQueryCache, upsertEventExposureAssessment, upsertOsmQueryCache } from "../../../db/operational.ts";
import { ApiInputError, apiActor, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security.ts";
import {
  aggregateOverpassExposureChunks,
  buildOsmExposureScope,
  decodeOsmIdDeltas,
  encodeOsmIdDeltas,
  exposureAssessmentIdentity,
  exposureAssessmentModelVersion,
  exposureAssessmentStatus,
  exposureRiskInput,
  parseOverpassExposureChunk,
  parseWorldPopTask,
  prepareOverpassExposurePlan,
  worldPopRequestPlan,
  type ExposureAssessment,
  type ExposureFacility,
  type OsmExposure,
  type OsmExposurePart,
  type OsmExposureScope,
  type OverpassExposureChunkResult,
  type PopulationExposure,
  type PopulationExposurePart,
  type WorldPopRequestChunk,
} from "../../../lib/exposure-assessment.ts";
import { overpassCacheKey, overpassFreshUntil, resolveOverpassRuntimeConfig, type OverpassRuntimeConfig } from "../../../lib/overpass-runtime.ts";

export const dynamic = "force-dynamic";

type CachedOsmExposureChunk = {
  schemaVersion: "osm-exposure-chunk-v1";
  chunkId: string;
  areaKm2: number;
  buildingIdDeltas: string;
  roadWayIdDeltas: string;
  facilityIds: string[];
  facilities: ExposureFacility[];
  osmBaseTimestamp?: string;
  fetchedAt: string;
};

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
    const osmScope = buildOsmExposureScope(canonical.event, identity.aoi, overpassConfig.maximumAreaKm2);
    const reusablePending = !force && sameInput && cached?.population.state === "pending" ? cached.population : undefined;
    const reusablePopulation = !force && sameInput && cached?.population.state === "ready" ? cached.population : undefined;
    const reusableOsm = !force && sameInput && sameOsmProfile && cached?.osm.state === "pending" ? cached.osm : undefined;
    const [population, osm] = await Promise.all([
      reusablePopulation ? Promise.resolve(reusablePopulation) : fetchPopulation(identity.aoi, year, reusablePending),
      fetchOsmExposure(osmScope, overpassConfig, force, reusableOsm),
    ]);
    const computedAt = new Date().toISOString();
    const osmFetchedAt = osm.state === "ready" && osm.fetchedAt ? Date.parse(osm.fetchedAt) : Number.NaN;
    const osmFreshRemainingMs = Number.isFinite(osmFetchedAt) ? Math.max(15 * 60_000, osmFetchedAt + overpassConfig.cacheTtlMs - Date.now()) : overpassConfig.cacheTtlMs;
    const assessmentTtlMs = population.state === "pending" || osm.state === "pending"
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
        ...(osm.coverage === "focused" ? ["OSM 建筑、道路和关键设施仅统计明确标注的重点筛查区，不代表完整灾害影响范围，也不得按面积比例外推。"] : []),
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

async function fetchOsmExposure(scope: OsmExposureScope, config: OverpassRuntimeConfig, force: boolean, pending?: OsmExposure): Promise<OsmExposure> {
  const plan = prepareOverpassExposurePlan(scope.aoi, {
    maximumAreaKm2: config.maximumAreaKm2,
    chunkAreaKm2: config.chunkAreaKm2,
    serviceLabel: config.profileLabel,
    queryTimeoutSeconds: config.queryTimeoutSeconds,
  });
  if (plan.state === "skipped") return emptyOsmExposure("skipped", config, plan.message, scope);
  const scopeMetadata = {
    coverage: scope.coverage,
    scopeLabel: scope.label,
    scopeAreaKm2: scope.aoi.areaKm2,
    sourceAoiAreaKm2: scope.sourceAoiAreaKm2,
  } as const;

  const aggregateCacheKey = overpassCacheKey(config, "exposure", `aggregate-v1:${plan.cacheIdentity}`);
  const cachedAggregate = await readExposureCache(aggregateCacheKey);
  const continuing = pending?.state === "pending" && pending.planHash === plan.planHash;
  if (!force && !continuing && cachedAggregate && Date.parse(cachedAggregate.expiresAt) > Date.now()) {
    return { ...cachedAggregate.payload, ...scopeMetadata, cacheStatus: "fresh", dataProfile: config.profile, updateCadence: config.updateCadence };
  }

  const priorRefreshStartedAt = continuing && pending.refreshStartedAt && Number.isFinite(Date.parse(pending.refreshStartedAt)) ? pending.refreshStartedAt : undefined;
  const refreshStartedAt = force ? new Date().toISOString() : priorRefreshStartedAt;
  const priorParts = new Map((continuing ? pending.parts ?? [] : []).map((part) => [part.chunkId, part]));
  const readyChunks = new Map<string, { result: OverpassExposureChunkResult; fetchedAt: string }>();
  for (const chunk of plan.chunks) {
    const cached = await readExposureChunkCache(overpassCacheKey(config, "exposure", `chunk-v1:${chunk.chunkId}`), chunk.chunkId, chunk.areaKm2);
    if (!cached || Date.parse(cached.expiresAt) <= Date.now()) continue;
    if (refreshStartedAt && Date.parse(cached.fetchedAt) < Date.parse(refreshStartedAt)) continue;
    readyChunks.set(chunk.chunkId, { result: cached.result, fetchedAt: cached.fetchedAt });
  }

  let attemptedChunkId = "";
  let attemptedAt = "";
  let attemptError = "";
  if (readyChunks.size < plan.chunks.length) {
    const next = plan.chunks
      .filter((chunk) => !readyChunks.has(chunk.chunkId))
      .sort((left, right) => (priorParts.get(left.chunkId)?.attempts ?? 0) - (priorParts.get(right.chunkId)?.attempts ?? 0) || left.chunkId.localeCompare(right.chunkId))[0];
    attemptedChunkId = next.chunkId;
    attemptedAt = new Date().toISOString();
    try {
      const response = await boundedFetch(config.endpoint.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": config.userAgent,
        },
        body: new URLSearchParams({ data: next.query }).toString(),
      }, (config.queryTimeoutSeconds + 5) * 1_000, 6 * 1024 * 1024);
      const result = parseOverpassExposureChunk(JSON.parse(response), next.chunkId, next.areaKm2);
      const stored = await writeExposureChunkCache(overpassCacheKey(config, "exposure", `chunk-v1:${next.chunkId}`), result, attemptedAt, config);
      if (!stored) throw new Error("分块去重索引超过缓存安全上限，请缩小 AOI 或使用自建 OSM 服务");
      readyChunks.set(next.chunkId, { result, fetchedAt: attemptedAt });
    } catch (error) {
      attemptError = safeUpstreamMessage(error, `${config.profileLabel}第 ${plan.chunks.indexOf(next) + 1} 块暂时不可用`);
    }
  }

  const parts: OsmExposurePart[] = plan.chunks.map((chunk) => {
    const ready = readyChunks.get(chunk.chunkId);
    const prior = priorParts.get(chunk.chunkId);
    if (ready) return {
      chunkId: chunk.chunkId,
      areaKm2: chunk.areaKm2,
      state: "ready",
      attempts: chunk.chunkId === attemptedChunkId ? (prior?.attempts ?? 0) + 1 : Math.max(1, prior?.attempts ?? 0),
      fetchedAt: ready.fetchedAt,
      lastAttemptAt: chunk.chunkId === attemptedChunkId ? attemptedAt : prior?.lastAttemptAt,
      message: "分块已缓存并纳入跨块 ID 去重",
    };
    if (chunk.chunkId === attemptedChunkId && attemptError) return {
      chunkId: chunk.chunkId,
      areaKm2: chunk.areaKm2,
      state: "unavailable",
      attempts: (prior?.attempts ?? 0) + 1,
      lastAttemptAt: attemptedAt,
      message: attemptError,
    };
    return prior ?? { chunkId: chunk.chunkId, areaKm2: chunk.areaKm2, state: "waiting", attempts: 0, message: "等待受控查询" };
  });

  if (readyChunks.size === plan.chunks.length) {
    const result = aggregateOverpassExposureChunks(plan.chunks.map((chunk) => readyChunks.get(chunk.chunkId)!.result));
    const fetchedAt = new Date().toISOString();
    const ready: OsmExposure = {
      state: "ready",
      provider: "OpenStreetMap · Overpass",
      ...result,
      fetchedAt,
      cacheStatus: "refreshed",
      dataProfile: config.profile,
      updateCadence: config.updateCadence,
      ...scopeMetadata,
      completedParts: plan.chunks.length,
      totalParts: plan.chunks.length,
      parts,
      planHash: plan.planHash,
      message: `${config.profileLabel} · 已完成 ${plan.chunks.length}/${plan.chunks.length} 个非重叠分块，并按 OSM 类型与 ID 跨块去重；${scope.coverage === "focused" ? "统计口径仅限重点筛查区，不代表完整影响范围；" : ""}关键设施地图最多显示 300 个点位`,
    };
    await writeExposureCache(aggregateCacheKey, ready, config);
    return ready;
  }

  const failedParts = parts.filter((part) => part.state === "unavailable").length;
  return {
    state: "pending",
    provider: "OpenStreetMap · Overpass",
    dataProfile: config.profile,
    updateCadence: config.updateCadence,
    ...scopeMetadata,
    facilityCounts: {},
    facilities: [],
    facilitiesTruncated: false,
    completedParts: readyChunks.size,
    totalParts: plan.chunks.length,
    parts,
    planHash: plan.planHash,
    refreshStartedAt,
    message: `${plan.message}；已完成 ${readyChunks.size}/${plan.chunks.length}${failedParts ? `，${failedParts} 块本轮失败，将优先续算未尝试分块后再重试` : ""}。未完成全部分块前不生成建筑、道路或设施总数`,
  };
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

function emptyOsmExposure(state: "skipped" | "unavailable", config: OverpassRuntimeConfig, message: string, scope?: OsmExposureScope): OsmExposure {
  return {
    state,
    provider: "OpenStreetMap · Overpass",
    dataProfile: config.profile,
    updateCadence: config.updateCadence,
    coverage: scope?.coverage,
    scopeLabel: scope?.label,
    scopeAreaKm2: scope?.aoi.areaKm2,
    sourceAoiAreaKm2: scope?.sourceAoiAreaKm2,
    facilityCounts: {},
    facilities: [],
    facilitiesTruncated: false,
    message,
  };
}

async function readExposureChunkCache(cacheKey: string, chunkId: string, areaKm2: number) {
  try {
    const cached = await getOsmQueryCache<CachedOsmExposureChunk>(cacheKey, "exposure");
    const payload = cached?.payload;
    if (!cached || !payload || payload.schemaVersion !== "osm-exposure-chunk-v1" || payload.chunkId !== chunkId) return null;
    if (!Array.isArray(payload.facilityIds) || payload.facilityIds.length > 50_000 || payload.facilityIds.some((id) => !/^(node|way|relation):[1-9]\d*$/.test(id))) return null;
    if (!Array.isArray(payload.facilities) || payload.facilities.length > 5_000 || payload.facilities.some((facility) => !validCachedFacility(facility))) return null;
    const result: OverpassExposureChunkResult = {
      chunkId,
      areaKm2,
      buildingIds: decodeOsmIdDeltas(payload.buildingIdDeltas),
      roadWayIds: decodeOsmIdDeltas(payload.roadWayIdDeltas),
      facilityIds: [...new Set(payload.facilityIds)].sort(),
      facilities: payload.facilities,
      osmBaseTimestamp: payload.osmBaseTimestamp,
    };
    return { ...cached, result };
  } catch {
    return null;
  }
}

async function writeExposureChunkCache(cacheKey: string, result: OverpassExposureChunkResult, fetchedAt: string, config: OverpassRuntimeConfig) {
  const payload: CachedOsmExposureChunk = {
    schemaVersion: "osm-exposure-chunk-v1",
    chunkId: result.chunkId,
    areaKm2: result.areaKm2,
    buildingIdDeltas: encodeOsmIdDeltas(result.buildingIds),
    roadWayIdDeltas: encodeOsmIdDeltas(result.roadWayIds),
    facilityIds: result.facilityIds,
    facilities: result.facilities,
    osmBaseTimestamp: result.osmBaseTimestamp,
    fetchedAt,
  };
  return upsertOsmQueryCache({
    cacheKey,
    queryKind: "exposure",
    dataProfile: config.profile,
    payload,
    fetchedAt,
    expiresAt: overpassFreshUntil(fetchedAt, config),
    osmBaseTimestamp: result.osmBaseTimestamp,
  });
}

function validCachedFacility(value: unknown): value is ExposureFacility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const facility = value as Partial<ExposureFacility>;
  return typeof facility.id === "string" && facility.id.length <= 180
    && ["health", "emergency", "shelter", "education", "power", "water"].includes(String(facility.kind))
    && typeof facility.name === "string" && facility.name.length <= 160
    && Number.isFinite(facility.latitude) && facility.latitude! >= -90 && facility.latitude! <= 90
    && Number.isFinite(facility.longitude) && facility.longitude! >= -180 && facility.longitude! <= 180
    && ["node", "way", "relation"].includes(String(facility.osmType))
    && Number.isSafeInteger(facility.osmId) && facility.osmId! > 0;
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
