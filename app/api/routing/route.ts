import { authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite, ApiInputError } from "../../../lib/api-security";
import {
  amapConfiguration,
  buildAmapCoordinateConversionUrl,
  buildAmapDrivingUrl,
  buildAmapRouteUrl,
  deduplicateAmapRoutes,
  isAmapDomesticRoutingCoordinate,
  parseAmapConvertedCoordinates,
  parseAmapDriving,
  parseAmapRouteAlternatives,
  type AmapRoadRoutingResponse,
  type AmapTravelMode,
  type RoutingCoordinate,
} from "../../../lib/amap-routing";

export const dynamic = "force-dynamic";

type CacheEntry = { value: Extract<AmapRoadRoutingResponse, { state: "ready" }>; expiresAt: number };
const routingState = globalThis as typeof globalThis & { __tianxunAmapRoutingCache?: Map<string, CacheEntry> };
const strategies = [32, 33, 35] as const;

export async function POST(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  const rateLimited = enforceRateLimit(request, "amap-routing", 12, 60_000);
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request, 8 * 1024);
    const origin = parseCoordinate(body.origin, "起点");
    const destination = parseCoordinate(body.destination, "目的地");
    const mode = parseMode(body.mode);
    if (!isAmapDomesticRoutingCoordinate(origin) || !isAmapDomesticRoutingCoordinate(destination)) {
      return Response.json({ state: "unsupported", provider: "高德地图", message: "当前高德国内 Web 服务只用于中国境内道路；境外继续使用几何降级模式" } satisfies AmapRoadRoutingResponse, { status: 422 });
    }
    if (haversineKm(origin, destination) < 0.2) throw new ApiInputError("起点与目的地至少相距 0.2 km", 400);
    const directDistanceKm = haversineKm(origin, destination);
    const maximumDistanceKm = mode === "walking" ? 100 : mode === "bicycling" || mode === "electrobike" ? 300 : 1_500;
    if (directDistanceKm > maximumDistanceKm) throw new ApiInputError(`${modeLabel(mode)}单次推演直线距离不能超过 ${maximumDistanceKm} km`, 400);

    const cacheKey = `${mode}:${origin.map((value) => value.toFixed(5)).join(",")}:${destination.map((value) => value.toFixed(5)).join(",")}`;
    const cache = routingState.__tianxunAmapRoutingCache ??= new Map();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return routingResponse(cached.value, "hit");

    const configuration = amapConfiguration();
    if (!configuration.ready || !configuration.config) {
      return Response.json({ state: "needs_config", provider: "高德地图", message: configuration.message } satisfies AmapRoadRoutingResponse, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const conversion = await upstreamJson(buildAmapCoordinateConversionUrl(configuration.config, [origin, destination]), "高德坐标转换");
    const [amapOrigin, amapDestination] = parseAmapConvertedCoordinates(conversion, 2);
    const results = mode === "driving"
      ? await Promise.allSettled(strategies.map(async (strategy) => {
        const payload = await upstreamJson(buildAmapDrivingUrl(configuration.config!, amapOrigin, amapDestination, strategy), `高德策略 ${strategy}`);
        return [parseAmapDriving(payload, strategy)];
      }))
      : await Promise.allSettled([upstreamJson(buildAmapRouteUrl(configuration.config, amapOrigin, amapDestination, mode), `高德${modeLabel(mode)}`).then((payload) => parseAmapRouteAlternatives(payload, mode))]);
    const routes = deduplicateAmapRoutes(results.flatMap((result) => result.status === "fulfilled" ? result.value : []));
    if (!routes.length) {
      const reasons = results.flatMap((result) => result.status === "rejected" ? [safeError(result.reason)] : []);
      throw new Error(reasons[0] || "高德没有返回可用道路路线");
    }
    const value: Extract<AmapRoadRoutingResponse, { state: "ready" }> = {
      state: "ready",
      provider: "高德地图",
      mode,
      fetchedAt: new Date().toISOString(),
      sourceCoordinateSystem: "GCJ-02",
      normalizedCoordinateSystem: "WGS84_APPROX",
      routes,
      note: `路线来自高德${modeLabel(mode)}规划并近似归一到 WGS84；上游可用字段随出行方式不同，任何路况都不等同于桥梁结构安全，尚未核验桥梁监测、道路毁损、临时封闭和现场通行条件。`,
    };
    cache.set(cacheKey, { value, expiresAt: Date.now() + 15 * 60_000 });
    pruneCache(cache);
    return routingResponse(value, "miss");
  } catch (error) {
    const status = error instanceof ApiInputError ? error.status : 502;
    const message = error instanceof Error ? error.message : "真实道路请求失败";
    return Response.json({ state: "error", provider: "高德地图", message: message.replace(/[\r\n]+/g, " ").slice(0, 240) } satisfies AmapRoadRoutingResponse, { status, headers: { "Cache-Control": "no-store" } });
  }
}

function parseMode(value: unknown): AmapTravelMode {
  const mode = String(value ?? "driving");
  if (!["driving", "walking", "bicycling", "electrobike"].includes(mode)) throw new ApiInputError("不支持的出行方式", 400);
  return mode as AmapTravelMode;
}

function modeLabel(mode: AmapTravelMode) {
  if (mode === "walking") return "步行";
  if (mode === "bicycling") return "骑行";
  if (mode === "electrobike") return "电动自行车";
  return "驾车";
}

function parseCoordinate(value: unknown, label: string): RoutingCoordinate {
  if (!Array.isArray(value) || value.length !== 2) throw new ApiInputError(`${label}坐标无效`, 400);
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new ApiInputError(`${label}坐标无效`, 400);
  return [longitude, latitude];
}

async function upstreamJson(url: string, provider: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${provider}返回 HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 2_000_000) throw new Error(`${provider}响应超过安全上限`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 2_000_000) throw new Error(`${provider}响应超过安全上限`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${provider}返回无效 JSON`);
  }
}

function routingResponse(value: Extract<AmapRoadRoutingResponse, { state: "ready" }>, cache: "hit" | "miss") {
  return Response.json(value, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Tianxun-Routing-Cache": cache,
    },
  });
}

function pruneCache(cache: Map<string, CacheEntry>) {
  if (cache.size <= 300) return;
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size > 300) cache.delete(cache.keys().next().value!);
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "请求失败").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function haversineKm(start: RoutingCoordinate, end: RoutingCoordinate) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(end[1] - start[1]);
  const longitudeDelta = radians(end[0] - start[0]);
  const startLatitude = radians(start[1]);
  const endLatitude = radians(end[1]);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}
