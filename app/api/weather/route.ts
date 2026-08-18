import { authorizeApiRequest, enforceRateLimit } from "../../../lib/api-security";
import {
  buildQWeatherForecastUrl,
  parseQWeatherForecast,
  qweatherAuthorizationHeaders,
  qweatherConfiguration,
  type WeatherForecastReady,
} from "../../../lib/qweather";

export const dynamic = "force-dynamic";

type WeatherCacheEntry = { value: WeatherForecastReady; expiresAt: number };
const weatherState = globalThis as typeof globalThis & {
  __tianxunWeatherCache?: Map<string, WeatherCacheEntry>;
  __tianxunWeatherDailyLocations?: { day: string; locations: Set<string> };
};

export async function GET(request: Request) {
  const unauthorized = authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const rateLimited = enforceRateLimit(request, "weather-read", 40, 60_000);
  if (rateLimited) return rateLimited;

  const input = new URL(request.url);
  const latitude = Number(input.searchParams.get("latitude"));
  const longitude = Number(input.searchParams.get("longitude"));
  const requestedHours = Number(input.searchParams.get("hours") ?? 72);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return Response.json({ state: "error", provider: "QWeather", message: "天气查询坐标无效" }, { status: 400 });
  }
  if (requestedHours !== 24 && requestedHours !== 72) {
    return Response.json({ state: "error", provider: "QWeather", message: "逐小时预报只支持24或72小时" }, { status: 400 });
  }

  const configuration = qweatherConfiguration();
  if (!configuration.ready || !configuration.config) {
    return Response.json({ state: "needs_config", provider: "QWeather", message: configuration.message }, { headers: { "Cache-Control": "private, max-age=60" } });
  }

  const hours = requestedHours as 24 | 72;
  const cacheKey = `${latitude.toFixed(2)},${longitude.toFixed(2)}:${hours}`;
  const cache = weatherState.__tianxunWeatherCache ??= new Map();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return weatherResponse(cached.value, "hit");
  if (!reserveDailyLocation(cacheKey)) {
    return Response.json({ state: "error", provider: "QWeather", message: "今日新天气点位已达到免费额度保护上限，请明日重试或提高受控限额" }, { status: 429 });
  }

  try {
    const response = await fetch(buildQWeatherForecastUrl(configuration.config, latitude, longitude, hours), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": "Tianxun-Disaster-Watch/0.1",
        ...await qweatherAuthorizationHeaders(configuration.config),
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`QWeather 返回 HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 2_000_000) throw new Error("QWeather 响应超过安全上限");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 2_000_000) throw new Error("QWeather 响应超过安全上限");
    const forecast = parseQWeatherForecast(JSON.parse(text), { latitude, longitude });
    cache.set(cacheKey, { value: forecast, expiresAt: Date.now() + 30 * 60_000 });
    if (cache.size > 500) for (const [key, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key);
    return weatherResponse(forecast, "miss");
  } catch (error) {
    const message = error instanceof SyntaxError ? "QWeather 返回了无效 JSON" : error instanceof Error ? error.message : "QWeather 请求失败";
    return Response.json({ state: "error", provider: "QWeather", message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

function reserveDailyLocation(cacheKey: string) {
  const day = new Date().toISOString().slice(0, 10);
  const state = weatherState.__tianxunWeatherDailyLocations;
  const current = !state || state.day !== day ? { day, locations: new Set<string>() } : state;
  weatherState.__tianxunWeatherDailyLocations = current;
  if (current.locations.has(cacheKey)) return true;
  const configuredLimit = Number(process.env.QWEATHER_DAILY_UNIQUE_LOCATION_LIMIT ?? 120);
  const limit = Number.isFinite(configuredLimit) ? Math.min(1_000, Math.max(10, Math.floor(configuredLimit))) : 120;
  if (current.locations.size >= limit) return false;
  current.locations.add(cacheKey);
  return true;
}

function weatherResponse(value: WeatherForecastReady, cache: "hit" | "miss") {
  return Response.json(value, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Tianxun-Weather-Cache": cache,
    },
  });
}
