export type OverpassProfile = "public" | "china_daily";
export type OverpassCacheStatus = "refreshed" | "fresh" | "stale";

// Covers the standard 30 km earthquake screening circle (~2,827 km²) with
// modest geometric headroom while still rejecting genuinely broad scans.
export const publicOverpassMaximumAreaKm2 = 3_500;

export type OverpassRuntimeConfig = {
  endpoint: URL;
  profile: OverpassProfile;
  profileLabel: string;
  dataScope: "global_public" | "china";
  updateCadence: "upstream" | "daily";
  maximumAreaKm2: number;
  cacheTtlMs: number;
  staleIfErrorMs: number;
  queryTimeoutSeconds: number;
  userAgent: string;
};

const publicEndpoint = "https://overpass-api.de/api/interpreter";
const defaultUserAgent = "Tianxun-Disaster-Watch/0.1 github.com/STU-Jankin/tianxun-disaster-watch";

export function resolveOverpassRuntimeConfig(environment: Record<string, string | undefined> = process.env): OverpassRuntimeConfig {
  const rawProfile = environment.OVERPASS_PROFILE?.trim().toLowerCase() || "public";
  if (rawProfile !== "public" && rawProfile !== "china_daily") throw new Error("OVERPASS_PROFILE 仅支持 public 或 china_daily");
  const profile = rawProfile as OverpassProfile;
  const configuredEndpoint = environment.OVERPASS_API_URL?.trim();
  if (profile === "china_daily" && (!configuredEndpoint || configuredEndpoint === publicEndpoint)) {
    throw new Error("china_daily 模式必须配置独立的中国 OSM Overpass 地址，禁止把公共实例标记为中国日更镜像");
  }
  const endpoint = parseEndpoint(configuredEndpoint || publicEndpoint, profile, environment.OVERPASS_ALLOW_PRIVATE_ENDPOINT === "true");
  const maximumAreaKm2 = profile === "public"
    ? publicOverpassMaximumAreaKm2
    : boundedNumber(environment.OVERPASS_MAX_AREA_KM2, 50_000, 2_500, 100_000);
  const cacheTtlHours = profile === "public"
    ? boundedNumber(environment.OVERPASS_CACHE_TTL_HOURS, 24, 1, 24)
    : boundedNumber(environment.OVERPASS_CACHE_TTL_HOURS, 26, 6, 72);
  const staleIfErrorHours = boundedNumber(environment.OVERPASS_STALE_IF_ERROR_HOURS, profile === "public" ? 72 : 168, cacheTtlHours, 720);
  const queryTimeoutSeconds = profile === "public"
    ? 25
    : boundedNumber(environment.OVERPASS_QUERY_TIMEOUT_SECONDS, 45, 15, 120);
  const configuredUserAgent = environment.OVERPASS_USER_AGENT?.trim().replace(/[\r\n]+/g, " ").slice(0, 180);
  return {
    endpoint,
    profile,
    profileLabel: profile === "china_daily" ? "中国 OSM 日更镜像" : "公共 Overpass",
    dataScope: profile === "china_daily" ? "china" : "global_public",
    updateCadence: profile === "china_daily" ? "daily" : "upstream",
    maximumAreaKm2,
    cacheTtlMs: cacheTtlHours * 60 * 60_000,
    staleIfErrorMs: staleIfErrorHours * 60 * 60_000,
    queryTimeoutSeconds,
    userAgent: configuredUserAgent || defaultUserAgent,
  };
}

export function overpassCacheKey(config: OverpassRuntimeConfig, kind: "exposure" | "infrastructure", identity: string) {
  const normalizedIdentity = identity.trim().replace(/[^a-zA-Z0-9:._-]+/g, "-").slice(0, 180);
  if (!normalizedIdentity) throw new Error("OSM 缓存标识无效");
  return `${config.profile}:${kind}:${normalizedIdentity}`;
}

export function overpassFreshUntil(fetchedAt: string, config: OverpassRuntimeConfig) {
  const timestamp = Date.parse(fetchedAt);
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + config.cacheTtlMs).toISOString();
}

export function overpassCacheStatusLabel(status: OverpassCacheStatus | undefined) {
  if (status === "fresh") return "本地缓存命中";
  if (status === "stale") return "过期缓存降级";
  return "已向数据服务刷新";
}

function parseEndpoint(raw: string, profile: OverpassProfile, allowPrivateEndpoint: boolean) {
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch { throw new Error("OVERPASS_API_URL 无效"); }
  if (endpoint.username || endpoint.password || !endpoint.hostname) throw new Error("OVERPASS_API_URL 不允许包含凭据");
  const privateEndpoint = privateLiteral(endpoint.hostname);
  if (profile === "public") {
    if (endpoint.protocol !== "https:" || privateEndpoint) throw new Error("公共 Overpass 地址必须是公网 HTTPS 地址");
  } else {
    if (privateEndpoint && !allowPrivateEndpoint) throw new Error("内网中国 Overpass 地址需要显式设置 OVERPASS_ALLOW_PRIVATE_ENDPOINT=true");
    if (endpoint.protocol !== "https:" && !(allowPrivateEndpoint && privateEndpoint && endpoint.protocol === "http:")) {
      throw new Error("中国 Overpass 地址必须使用 HTTPS；仅显式允许的内网地址可使用 HTTP");
    }
  }
  return endpoint;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
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
