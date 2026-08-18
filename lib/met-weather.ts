import type { WeatherForecastHour, WeatherForecastReady, WeatherSuitability } from "./qweather";

const documentationUrl = "https://api.met.no/weatherapi/locationforecast/2.0/documentation";

export function buildMetWeatherUrl(latitude: number, longitude: number) {
  const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  url.search = new URLSearchParams({ lat: latitude.toFixed(4), lon: longitude.toFixed(4) }).toString();
  return url.toString();
}

export function metWeatherUserAgent(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.MET_WEATHER_USER_AGENT?.replace(/[\r\n]/g, " ").trim();
  return configured && configured.length >= 12 && configured.length <= 240
    ? configured
    : "Tianxun-Disaster-Watch/0.1 github.com/STU-Jankin/tianxun-disaster-watch";
}

export function parseMetWeatherForecast(
  payload: unknown,
  coordinates: { latitude: number; longitude: number },
  hours: 24 | 72,
  fetchedAt = new Date().toISOString(),
): WeatherForecastReady {
  if (!isRecord(payload) || !isRecord(payload.properties)) throw new Error("MET Norway 响应不是 Locationforecast JSON");
  const properties = payload.properties;
  if (!Array.isArray(properties.timeseries) || !properties.timeseries.length || properties.timeseries.length > 240) throw new Error("MET Norway 逐小时预报结构无效");
  const hourly = properties.timeseries.flatMap(parseHour)
    .sort((a, b) => +new Date(a.validAt) - +new Date(b.validAt))
    .slice(0, hours);
  if (!hourly.length) throw new Error("MET Norway 没有返回可用逐小时预报");
  const meta = isRecord(properties.meta) ? properties.meta : {};
  return {
    state: "ready",
    provider: "MET Norway",
    product: "Locationforecast 2.0 compact",
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    issuedAt: validIso(meta.updated_at) ?? fetchedAt,
    fetchedAt,
    sourceUrl: documentationUrl,
    attribution: ["MET Norway"],
    license: ["Norwegian Licence for Open Government Data (NLOD) 2.0 / CC BY 4.0"],
    resolution: "随区域与模式变化",
    timeZone: "UTC",
    hourly,
    note: "全球位置插值的数值天气预报，空间分辨率随区域与驱动模式变化，不等同于站点实况或官方灾害预警；光学适用性仅依据云量和降水初筛。",
  };
}

function parseHour(value: unknown): WeatherForecastHour[] {
  if (!isRecord(value) || !isRecord(value.data)) return [];
  const validAt = validIso(value.time);
  const instant = isRecord(value.data.instant) && isRecord(value.data.instant.details) ? value.data.instant.details : {};
  const nextHour = isRecord(value.data.next_1_hours) ? value.data.next_1_hours : {};
  const summary = isRecord(nextHour.summary) ? nextHour.summary : {};
  const details = isRecord(nextHour.details) ? nextHour.details : {};
  const temperatureC = boundedNumber(instant.air_temperature, -100, 70);
  const windMs = boundedNumber(instant.wind_speed, 0, 150);
  const humidityPercent = boundedNumber(instant.relative_humidity, 0, 100);
  const cloudPercent = boundedNumber(instant.cloud_area_fraction, 0, 100);
  const precipitationMm = boundedNumber(details.precipitation_amount, 0, 2_000) ?? 0;
  if (!validAt || temperatureC === null || windMs === null || humidityPercent === null) return [];
  const symbol = safeText(summary.symbol_code, 50, "unknown");
  return [{
    validAt,
    temperatureC,
    condition: conditionLabel(symbol),
    icon: symbol,
    windSpeedKmh: Math.round(windMs * 36) / 10,
    windDirection: directionLabel(boundedNumber(instant.wind_from_direction, 0, 360)),
    humidityPercent,
    precipitationMm,
    cloudPercent,
    opticalSuitability: suitability(cloudPercent, precipitationMm),
  }];
}

function conditionLabel(symbol: string) {
  const value = symbol.replace(/_(?:day|night|polartwilight)$/, "");
  if (/thunder/.test(value)) return "雷暴";
  if (/snow|sleet/.test(value)) return "降雪或雨夹雪";
  if (/rain/.test(value)) return "降雨";
  if (/fog/.test(value)) return "雾";
  if (/partlycloudy/.test(value)) return "多云";
  if (/cloudy/.test(value)) return "阴";
  if (/fair/.test(value)) return "少云";
  if (/clearsky/.test(value)) return "晴";
  return "天气状态未知";
}

function directionLabel(value: number | null) {
  if (value === null) return "风向未知";
  const labels = ["北风", "东北风", "东风", "东南风", "南风", "西南风", "西风", "西北风"];
  return labels[Math.round(value / 45) % 8];
}

function suitability(cloudPercent: number | null, precipitationMm: number): WeatherSuitability {
  if (cloudPercent === null) return "unknown";
  if (cloudPercent <= 30 && precipitationMm <= 0.1) return "good";
  if (cloudPercent <= 70 && precipitationMm <= 1) return "conditional";
  return "poor";
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function validIso(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeText(value: unknown, maximum: number, fallback: string) {
  const result = typeof value === "string" ? [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim() : "";
  return result ? result.slice(0, maximum) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
