import { authorizeApiRequest, enforceRateLimit } from "../../../lib/api-security";
import {
  buildLandslideForecast,
  buildOpenMeteoLandslideClimatologyUrl,
  buildOpenMeteoLandslideForecastUrl,
  landslideForecastBaselinePeriod,
  parseOpenMeteoLandslideClimatology,
  parseOpenMeteoLandslideForecast,
  type LandslideForecastReady,
  type OpenMeteoClimatology,
} from "../../../lib/landslide-forecast";
import { analyzeTerrainElevations, prepareTerrainSamplingPlan, type LandslideTerrainResult } from "../../../lib/landslide-planning";

export const dynamic = "force-dynamic";

type CacheEntry<T> = { value: T; expiresAt: number };
const forecastState = globalThis as typeof globalThis & {
  __tianxunLandslideForecastCache?: Map<string, CacheEntry<LandslideForecastReady>>;
  __tianxunLandslideClimatologyCache?: Map<string, CacheEntry<OpenMeteoClimatology>>;
};

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const rateLimited = enforceRateLimit(request, "landslide-forecast-read", 12, 60_000);
  if (rateLimited) return rateLimited;

  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const radiusKm = Number(url.searchParams.get("radiusKm") ?? 10);
  let terrainPlan: ReturnType<typeof prepareTerrainSamplingPlan>;
  try {
    terrainPlan = prepareTerrainSamplingPlan({ latitude, longitude, radiusKm });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "滑坡预报查询参数无效", 400);
  }

  const cacheKey = terrainPlan.cacheKey;
  const cache = forecastState.__tianxunLandslideForecastCache ??= new Map();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ready(cached.value, "hit");

  try {
    const period = landslideForecastBaselinePeriod();
    const series = await fetchForecast(latitude, longitude);
    const [climatologyResult, terrainResult] = await Promise.allSettled([
      fetchClimatology(latitude, longitude, period),
      fetchTerrain(terrainPlan),
    ]);
    const inputWarnings: string[] = [];
    const climatology = climatologyResult.status === "fulfilled" ? climatologyResult.value : null;
    if (climatologyResult.status === "rejected") inputWarnings.push(`本地降雨P95不可用：${safeReason(climatologyResult.reason)}`);
    const terrain: LandslideTerrainResult = terrainResult.status === "fulfilled" ? terrainResult.value : {
      state: "unavailable",
      provider: "Open-Meteo Elevation · Copernicus DEM",
      message: `DEM坡度不可用：${safeReason(terrainResult.reason)}`,
    };
    if (terrainResult.status === "rejected") inputWarnings.push(`DEM坡度不可用：${safeReason(terrainResult.reason)}`);
    const value = buildLandslideForecast({ series, climatology, terrain, radiusKm: terrainPlan.radiusKm, baselinePeriod: period, inputWarnings });
    cache.set(cacheKey, { value, expiresAt: Date.now() + 30 * 60_000 });
    prune(cache, 300);
    return ready(value, "miss");
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "滑坡预报输入服务请求超时，请稍后重试"
      : error instanceof Error ? error.message : "滑坡预报筛查失败";
    return unavailable(message.replace(/[\r\n]+/g, " ").slice(0, 260), 502);
  }
}

async function fetchForecast(latitude: number, longitude: number) {
  const response = await boundedFetch(buildOpenMeteoLandslideForecastUrl(latitude, longitude), "Open-Meteo未来降雨", 1_000_000);
  return parseOpenMeteoLandslideForecast(JSON.parse(response));
}

async function fetchClimatology(latitude: number, longitude: number, period: { start: string; end: string }) {
  const cache = forecastState.__tianxunLandslideClimatologyCache ??= new Map();
  const key = `${latitude.toFixed(2)}:${longitude.toFixed(2)}:${period.start}:${period.end}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await boundedFetch(buildOpenMeteoLandslideClimatologyUrl(latitude, longitude, period), "Open-Meteo历史降雨", 1_000_000, 20_000);
  const value = parseOpenMeteoLandslideClimatology(JSON.parse(response));
  cache.set(key, { value, expiresAt: Date.now() + 30 * 86_400_000 });
  prune(cache, 500);
  return value;
}

async function fetchTerrain(plan: ReturnType<typeof prepareTerrainSamplingPlan>): Promise<LandslideTerrainResult> {
  const endpoint = new URL("https://api.open-meteo.com/v1/elevation");
  endpoint.searchParams.set("latitude", plan.points.map((point) => point.latitude.toFixed(7)).join(","));
  endpoint.searchParams.set("longitude", plan.points.map((point) => point.longitude.toFixed(7)).join(","));
  const text = await boundedFetch(endpoint.toString(), "Open-Meteo高程", 128 * 1024);
  const payload = JSON.parse(text) as { elevation?: unknown };
  return analyzeTerrainElevations(plan, payload.elevation, new Date().toISOString());
}

async function boundedFetch(url: string, label: string, maximumBytes: number, timeoutMs = 12_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${label}返回 HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) throw new Error(`${label}未返回JSON`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) throw new Error(`${label}响应超过安全上限`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error(`${label}响应超过安全上限`);
  return text;
}

function ready(value: LandslideForecastReady, cache: "hit" | "miss") {
  return Response.json(value, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Tianxun-Landslide-Forecast-Cache": cache,
    },
  });
}

function unavailable(message: string, status: number) {
  return Response.json({ state: "unavailable", provider: "Open-Meteo Best Match · Copernicus DEM", message }, { status, headers: { "Cache-Control": "no-store" } });
}

function safeReason(value: unknown) {
  return (value instanceof Error ? value.message : "请求失败").replace(/[\r\n]+/g, " ").slice(0, 140);
}

function prune<T>(cache: Map<string, CacheEntry<T>>, maximum: number) {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size > maximum) cache.delete(cache.keys().next().value!);
}
