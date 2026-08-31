import { getOsmQueryCache, upsertOsmQueryCache } from "../../../db/operational.ts";
import { ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import {
  assessInfrastructureRoutes,
  parseOverpassBaseTimestamp,
  parseOverpassInfrastructure,
  prepareInfrastructureQuery,
  type InfrastructureFeature,
} from "../../../lib/osm-infrastructure";
import { overpassCacheKey, resolveOverpassRuntimeConfig, type OverpassProfile } from "../../../lib/overpass-runtime.ts";

export const dynamic = "force-dynamic";

type CacheEntry = { features: InfrastructureFeature[]; fetchedAt: string; expiresAt: number; osmBaseTimestamp?: string; dataProfile: OverpassProfile };
const infrastructureState = globalThis as typeof globalThis & { __tianxunInfrastructureCache?: Map<string, CacheEntry> };

export async function POST(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  const rateLimited = enforceRateLimit(request, "osm-infrastructure", 6, 60_000);
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request, 256 * 1024);
    const config = resolveOverpassRuntimeConfig();
    let plan: ReturnType<typeof prepareInfrastructureQuery>;
    try {
      plan = prepareInfrastructureQuery(body.routes, {
        maximumAreaKm2: config.maximumAreaKm2,
        serviceLabel: config.profileLabel,
        queryTimeoutSeconds: config.queryTimeoutSeconds,
      });
    }
    catch (error) { throw new ApiInputError(error instanceof Error ? error.message : "路线参数无效", 400); }
    if (plan.state !== "ready") return Response.json(plan, { headers: { "Cache-Control": "private, no-store" } });

    const cache = infrastructureState.__tianxunInfrastructureCache ??= new Map();
    const cacheKey = overpassCacheKey(config, "infrastructure", plan.cacheKey);
    const cached = cache.get(cacheKey) ?? await readDurableCache(cacheKey);
    if (cached) cache.set(cacheKey, cached);
    const metadata = (entry: CacheEntry, cacheStatus: "fresh" | "stale" | "refreshed") => ({
      osmBaseTimestamp: entry.osmBaseTimestamp,
      cacheStatus,
      dataProfile: config.profile,
      updateCadence: config.updateCadence,
    } as const);
    if (cached && cached.expiresAt > Date.now()) {
      return assessmentResponse(assessInfrastructureRoutes(plan, cached.features, cached.fetchedAt, metadata(cached, "fresh")), "hit");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (config.queryTimeoutSeconds + 5) * 1_000);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": config.userAgent,
        },
        body: new URLSearchParams({ data: plan.query }).toString(),
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Overpass 上游返回 HTTP ${response.status}`);
      const text = await readLimitedText(response, 4 * 1024 * 1024);
      const payload = JSON.parse(text);
      const features = parseOverpassInfrastructure(payload);
      const fetchedAt = new Date().toISOString();
      const entry: CacheEntry = {
        features,
        fetchedAt,
        expiresAt: Date.now() + config.cacheTtlMs,
        osmBaseTimestamp: parseOverpassBaseTimestamp(payload),
        dataProfile: config.profile,
      };
      cache.set(cacheKey, entry);
      await writeDurableCache(cacheKey, entry);
      pruneCache(cache);
      return assessmentResponse(assessInfrastructureRoutes(plan, features, fetchedAt, metadata(entry, "refreshed")), "miss");
    } catch (error) {
      const fetchedAt = cached ? Date.parse(cached.fetchedAt) : Number.NaN;
      if (cached && Number.isFinite(fetchedAt) && fetchedAt + config.staleIfErrorMs > Date.now()) {
        const assessment = assessInfrastructureRoutes(plan, cached.features, cached.fetchedAt, metadata(cached, "stale"));
        assessment.note = `${assessment.note} 当前${config.profileLabel}刷新失败，已使用 ${cached.fetchedAt} 的本地缓存；禁止据此认定道路或设施状态未变化。`;
        return assessmentResponse(assessment, "stale");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const status = error instanceof ApiInputError ? error.status : error instanceof SyntaxError ? 502 : 502;
    const message = error instanceof Error && error.name === "AbortError"
      ? "公共 Overpass 查询超时；路线仍可生成，但桥梁、隧道和涉水点覆盖未知"
      : error instanceof Error ? error.message : "基础设施查询失败";
    return Response.json({
      state: "unavailable",
      provider: "OpenStreetMap · Overpass",
      message: message.replace(/[\r\n]+/g, " ").slice(0, 240),
    }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}

function assessmentResponse(value: ReturnType<typeof assessInfrastructureRoutes>, cache: "hit" | "miss" | "stale") {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store", "X-Tianxun-Cache": cache } });
}

async function readLimitedText(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("Overpass 响应超过安全上限");
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
      throw new Error("Overpass 响应超过安全上限");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function pruneCache(cache: Map<string, CacheEntry>) {
  const now = Date.now();
  for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size > 100) cache.delete(cache.keys().next().value!);
}

async function readDurableCache(cacheKey: string): Promise<CacheEntry | undefined> {
  try {
    const record = await getOsmQueryCache<{ features?: unknown }>(cacheKey, "infrastructure");
    if (!record || !isInfrastructureFeatureList(record.payload.features)) return undefined;
    return {
      features: record.payload.features,
      fetchedAt: record.fetchedAt,
      expiresAt: Date.parse(record.expiresAt),
      osmBaseTimestamp: record.osmBaseTimestamp,
      dataProfile: record.dataProfile,
    };
  } catch {
    return undefined;
  }
}

async function writeDurableCache(cacheKey: string, entry: CacheEntry) {
  try {
    await upsertOsmQueryCache({
      cacheKey,
      queryKind: "infrastructure",
      dataProfile: entry.dataProfile,
      payload: { features: entry.features },
      fetchedAt: entry.fetchedAt,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      osmBaseTimestamp: entry.osmBaseTimestamp,
    });
  } catch {
    // The request remains usable with process-local caching when durable storage is unavailable.
  }
}

function isInfrastructureFeatureList(value: unknown): value is InfrastructureFeature[] {
  return Array.isArray(value) && value.length <= 500 && value.every((item) => Boolean(item)
    && typeof item === "object"
    && typeof (item as InfrastructureFeature).infrastructureId === "string"
    && ["bridge", "tunnel", "ford"].includes((item as InfrastructureFeature).kind)
    && Boolean((item as InfrastructureFeature).geometry));
}
