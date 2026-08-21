import { ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { analyzeTerrainElevations, prepareTerrainSamplingPlan, type LandslideTerrainResult } from "../../../lib/landslide-planning";

export const dynamic = "force-dynamic";

type CacheEntry = { value: LandslideTerrainResult; expiresAt: number };
const terrainState = globalThis as typeof globalThis & { __tianxunTerrainCache?: Map<string, CacheEntry> };

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  const rateLimited = enforceRateLimit(request, "landslide-terrain", 6, 60_000);
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request, 8 * 1024);
    let plan: ReturnType<typeof prepareTerrainSamplingPlan>;
    try { plan = prepareTerrainSamplingPlan(body); }
    catch (error) { throw new ApiInputError(error instanceof Error ? error.message : "地形筛查参数无效", 400); }

    const cache = terrainState.__tianxunTerrainCache ??= new Map();
    const cached = cache.get(plan.cacheKey);
    if (cached && cached.expiresAt > Date.now()) return terrainResponse(cached.value, "hit");

    const endpoint = elevationEndpoint();
    endpoint.searchParams.set("latitude", plan.points.map((point) => point.latitude.toFixed(7)).join(","));
    endpoint.searchParams.set("longitude", plan.points.map((point) => point.longitude.toFixed(7)).join(","));
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
      signal: AbortSignal.timeout(12_000),
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`Open-Meteo Elevation 返回 HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 128 * 1024) throw new Error("高程响应超过安全上限");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 128 * 1024) throw new Error("高程响应超过安全上限");
    const payload = JSON.parse(text) as { elevation?: unknown };
    const result = analyzeTerrainElevations(plan, payload.elevation, new Date().toISOString());
    cache.set(plan.cacheKey, { value: result, expiresAt: Date.now() + 30 * 86_400_000 });
    pruneCache(cache);
    return terrainResponse(result, "miss");
  } catch (error) {
    const status = error instanceof ApiInputError ? error.status : error instanceof SyntaxError ? 502 : 502;
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "公共高程服务请求超时；请稍后重试或人工绘制 AOI"
      : error instanceof Error ? error.message : "地形筛查失败";
    return Response.json({ state: "unavailable", provider: "Open-Meteo Elevation · Copernicus DEM", message: message.replace(/[\r\n]+/g, " ").slice(0, 240) }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}

export function elevationEndpoint() {
  const raw = process.env.OPEN_METEO_ELEVATION_API_URL?.trim() || "https://api.open-meteo.com/v1/elevation";
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiInputError("OPEN_METEO_ELEVATION_API_URL 无效", 503); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || isPrivateLiteral(url.hostname)) throw new ApiInputError("OPEN_METEO_ELEVATION_API_URL 必须是无凭据的公网 HTTPS 地址", 503);
  url.search = "";
  url.hash = "";
  return url;
}

function terrainResponse(value: LandslideTerrainResult, cache: "hit" | "miss") {
  return Response.json(value, { headers: { "Cache-Control": "private, max-age=3600", "X-Tianxun-Terrain-Cache": cache } });
}

function pruneCache(cache: Map<string, CacheEntry>) {
  const now = Date.now();
  for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size > 200) cache.delete(cache.keys().next().value!);
}

function isPrivateLiteral(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0"].includes(host)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
