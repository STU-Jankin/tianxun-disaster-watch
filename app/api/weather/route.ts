import { authorizeApiRequest, enforceRateLimit } from "../../../lib/api-security";
import {
  buildQWeatherForecastUrl,
  parseQWeatherForecast,
  qweatherAuthorizationHeaders,
  qweatherConfiguration,
  type WeatherForecastReady,
} from "../../../lib/qweather";
import { buildMetWeatherUrl, metWeatherUserAgent, parseMetWeatherForecast } from "../../../lib/met-weather";

export const dynamic = "force-dynamic";

type WeatherCacheEntry = { value: WeatherForecastReady; expiresAt: number };
const weatherState = globalThis as typeof globalThis & {
  __tianxunWeatherCache?: Map<string, WeatherCacheEntry>;
  __tianxunWeatherDailyLocations?: { day: string; locations: Set<string> };
};

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const rateLimited = enforceRateLimit(request, "weather-read", 40, 60_000);
  if (rateLimited) return rateLimited;

  const input = new URL(request.url);
  const latitude = Number(input.searchParams.get("latitude"));
  const longitude = Number(input.searchParams.get("longitude"));
  const requestedHours = Number(input.searchParams.get("hours") ?? 72);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return Response.json({ state: "error", provider: "MET Norway", message: "天气查询坐标无效" }, { status: 400 });
  }
  if (requestedHours !== 24 && requestedHours !== 72) {
    return Response.json({ state: "error", provider: "MET Norway", message: "逐小时预报只支持24或72小时" }, { status: 400 });
  }

  const hours = requestedHours as 24 | 72;
  const cacheKey = `${latitude.toFixed(2)},${longitude.toFixed(2)}:${hours}`;
  const cache = weatherState.__tianxunWeatherCache ??= new Map();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return weatherResponse(cached.value, "hit");
  const failures: string[] = [];
  const configuration = qweatherConfiguration();
  if (configuration.ready && configuration.config) {
    if (reserveDailyLocation(cacheKey)) {
      try {
        const forecast = await fetchQWeather(configuration.config, latitude, longitude, hours);
        rememberForecast(cache, cacheKey, forecast);
        return weatherResponse(forecast, "miss");
      } catch (error) {
        failures.push(weatherError("QWeather", error));
      }
    } else {
      failures.push("QWeather 今日新点位额度已满");
    }
  }

  try {
    const forecast = await fetchMetWeather(latitude, longitude, hours);
    rememberForecast(cache, cacheKey, forecast);
    return weatherResponse(forecast, "miss");
  } catch (error) {
    failures.push(weatherError("MET Norway", error));
    return Response.json({ state: "error", provider: "MET Norway", message: failures.join("；").slice(0, 360) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function fetchQWeather(config: NonNullable<ReturnType<typeof qweatherConfiguration>["config"]>, latitude: number, longitude: number, hours: 24 | 72) {
  const response = await fetch(buildQWeatherForecastUrl(config, latitude, longitude, hours), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "User-Agent": "Tianxun-Disaster-Watch/0.1",
      ...await qweatherAuthorizationHeaders(config),
    },
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`返回 HTTP ${response.status}`);
  return parseQWeatherForecast(await limitedJson(response, "QWeather"), { latitude, longitude });
}

async function fetchMetWeather(latitude: number, longitude: number, hours: 24 | 72) {
  const response = await fetch(buildMetWeatherUrl(latitude, longitude), {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "User-Agent": metWeatherUserAgent() },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`返回 HTTP ${response.status}`);
  return parseMetWeatherForecast(await limitedJson(response, "MET Norway"), { latitude, longitude }, hours);
}

async function limitedJson(response: Response, provider: string) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 2_000_000) throw new Error(`${provider} 响应超过安全上限`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 2_000_000) throw new Error(`${provider} 响应超过安全上限`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider} 返回了无效 JSON`);
  }
}

function rememberForecast(cache: Map<string, WeatherCacheEntry>, cacheKey: string, forecast: WeatherForecastReady) {
  cache.set(cacheKey, { value: forecast, expiresAt: Date.now() + 30 * 60_000 });
  if (cache.size > 500) for (const [key, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key);
}

function weatherError(provider: string, error: unknown) {
  const reason = error instanceof Error ? error.message : "请求失败";
  return `${provider}：${reason.replace(/[\r\n]+/g, " ").slice(0, 150)}`;
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
