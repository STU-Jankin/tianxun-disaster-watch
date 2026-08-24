import { ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import {
  assessInfrastructureRoutes,
  parseOverpassInfrastructure,
  prepareInfrastructureQuery,
  type InfrastructureFeature,
} from "../../../lib/osm-infrastructure";

export const dynamic = "force-dynamic";

type CacheEntry = { features: InfrastructureFeature[]; fetchedAt: string; expiresAt: number };
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
    let plan: ReturnType<typeof prepareInfrastructureQuery>;
    try { plan = prepareInfrastructureQuery(body.routes); }
    catch (error) { throw new ApiInputError(error instanceof Error ? error.message : "路线参数无效", 400); }
    if (plan.state !== "ready") return Response.json(plan, { headers: { "Cache-Control": "private, no-store" } });

    const cache = infrastructureState.__tianxunInfrastructureCache ??= new Map();
    const cached = cache.get(plan.cacheKey);
    if (cached && cached.expiresAt > Date.now()) return assessmentResponse(assessInfrastructureRoutes(plan, cached.features, cached.fetchedAt), "hit");

    const endpoint = overpassEndpoint();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": overpassUserAgent(),
        },
        body: new URLSearchParams({ data: plan.query }).toString(),
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Overpass 上游返回 HTTP ${response.status}`);
      const text = await readLimitedText(response, 4 * 1024 * 1024);
      const features = parseOverpassInfrastructure(JSON.parse(text));
      const fetchedAt = new Date().toISOString();
      cache.set(plan.cacheKey, { features, fetchedAt, expiresAt: Date.now() + 24 * 60 * 60_000 });
      pruneCache(cache);
      return assessmentResponse(assessInfrastructureRoutes(plan, features, fetchedAt), "miss");
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

export function overpassEndpoint() {
  const raw = process.env.OVERPASS_API_URL?.trim() || "https://overpass-api.de/api/interpreter";
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiInputError("OVERPASS_API_URL 无效", 503); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || isPrivateLiteral(url.hostname)) throw new ApiInputError("OVERPASS_API_URL 必须是无凭据的公网 HTTPS 地址", 503);
  return url.toString();
}

function overpassUserAgent() {
  const configured = process.env.OVERPASS_USER_AGENT?.trim().replace(/[\r\n]+/g, " ").slice(0, 180);
  return configured || "Tianxun-Disaster-Watch/0.1 github.com/STU-Jankin/tianxun-disaster-watch";
}

function assessmentResponse(value: ReturnType<typeof assessInfrastructureRoutes>, cache: "hit" | "miss") {
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

function isPrivateLiteral(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0"].includes(host)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [, aText, bText] = match;
  const a = Number(aText);
  const b = Number(bText);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
