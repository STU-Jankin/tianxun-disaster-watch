export type WeatherSuitability = "good" | "conditional" | "poor" | "unknown";

export type WeatherForecastHour = {
  validAt: string;
  temperatureC: number;
  condition: string;
  icon: string;
  windSpeedKmh: number;
  windDirection: string;
  humidityPercent: number;
  precipitationMm: number;
  cloudPercent: number | null;
  opticalSuitability: WeatherSuitability;
};

export type WeatherImagingWindow = {
  start: string;
  end: string;
  minimumCloudPercent: number;
  maximumCloudPercent: number;
  maximumPrecipitationMm: number;
};

export type WeatherForecastReady = {
  state: "ready";
  provider: "QWeather" | "MET Norway";
  product: string;
  latitude: number;
  longitude: number;
  issuedAt: string;
  fetchedAt: string;
  sourceUrl: string;
  attribution: string[];
  license: string[];
  resolution: string;
  timeZone: "UTC";
  hourly: WeatherForecastHour[];
  note: string;
};

export type WeatherForecastResponse = WeatherForecastReady | {
  state: "needs_config" | "error";
  provider: "QWeather" | "MET Norway";
  message: string;
};

type QWeatherAuth =
  | { type: "api-key"; apiKey: string }
  | { type: "jwt"; projectId: string; credentialId: string; privateKey: string };

export type QWeatherConfig = { origin: string; auth: QWeatherAuth };

let cachedJwt: { identity: string; token: string; expiresAt: number } | null = null;

export function qweatherConfiguration(env: NodeJS.ProcessEnv = process.env): { ready: boolean; message: string; config?: QWeatherConfig } {
  const host = env.QWEATHER_API_HOST?.trim() ?? "";
  if (!host) return { ready: false, message: "需要在和风天气控制台创建项目，并配置专属 QWEATHER_API_HOST" };
  let origin: string;
  try {
    origin = normalizeQWeatherOrigin(host);
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : "QWeather API Host 无效" };
  }

  const apiKey = env.QWEATHER_API_KEY?.trim();
  if (apiKey && apiKey.length >= 8 && !/replace|example|placeholder/i.test(apiKey)) {
    return { ready: true, message: "已配置 QWeather API KEY", config: { origin, auth: { type: "api-key", apiKey } } };
  }

  const projectId = env.QWEATHER_PROJECT_ID?.trim();
  const credentialId = env.QWEATHER_CREDENTIAL_ID?.trim();
  const privateKey = env.QWEATHER_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (projectId && credentialId && privateKey) {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(projectId) || !/^[A-Za-z0-9_-]{4,80}$/.test(credentialId) || !privateKey.includes("BEGIN PRIVATE KEY")) {
      return { ready: false, message: "QWeather JWT 项目ID、凭据ID或 Ed25519 私钥格式无效" };
    }
    return { ready: true, message: "已配置 QWeather JWT", config: { origin, auth: { type: "jwt", projectId, credentialId, privateKey } } };
  }
  return { ready: false, message: "需要配置 QWEATHER_API_KEY，或完整配置 JWT 项目ID、凭据ID和 Ed25519 私钥" };
}

export async function qweatherAuthorizationHeaders(config: QWeatherConfig, now = Date.now()): Promise<Record<string, string>> {
  if (config.auth.type === "api-key") return { "X-QW-Api-Key": config.auth.apiKey };
  const identity = `${config.auth.projectId}:${config.auth.credentialId}`;
  if (cachedJwt?.identity === identity && cachedJwt.expiresAt - now > 60_000) return { Authorization: `Bearer ${cachedJwt.token}` };
  const issuedAt = Math.floor(now / 1000) - 30;
  const expiresAt = issuedAt + 900;
  const header = base64UrlText(JSON.stringify({ alg: "EdDSA", kid: config.auth.credentialId }));
  const payload = base64UrlText(JSON.stringify({ sub: config.auth.projectId, iat: issuedAt, exp: expiresAt }));
  const signingInput = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(config.auth.privateKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(signingInput));
  const token = `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
  cachedJwt = { identity, token, expiresAt: expiresAt * 1000 };
  return { Authorization: `Bearer ${token}` };
}

export function buildQWeatherForecastUrl(config: QWeatherConfig, latitude: number, longitude: number, hours: 24 | 72) {
  // New QWeather credentials can return `deprecated` for the legacy grid
  // product while the coordinate-based city/region hourly product remains
  // available. Keep coordinates in the request so arbitrary disaster AOIs
  // still resolve without a separate GeoAPI lookup.
  const url = new URL(`/v7/weather/${hours}h`, config.origin);
  url.search = new URLSearchParams({ location: `${longitude.toFixed(2)},${latitude.toFixed(2)}`, lang: "zh", unit: "m" }).toString();
  return url.toString();
}

export function parseQWeatherForecast(payload: unknown, coordinates: { latitude: number; longitude: number }, fetchedAt = new Date().toISOString()): WeatherForecastReady {
  if (!isRecord(payload)) throw new Error("QWeather 响应不是 JSON 对象");
  if (String(payload.code ?? "") !== "200") throw new Error(`QWeather 上游状态码 ${String(payload.code ?? "未知")}`);
  if (!Array.isArray(payload.hourly) || payload.hourly.length === 0 || payload.hourly.length > 168) throw new Error("QWeather 逐小时预报结构无效");
  const hourly = payload.hourly.flatMap((value) => parseHour(value)).sort((a, b) => +new Date(a.validAt) - +new Date(b.validAt));
  if (!hourly.length) throw new Error("QWeather 没有返回可用逐小时预报");
  const refer = isRecord(payload.refer) ? payload.refer : {};
  return {
    state: "ready",
    provider: "QWeather",
    product: "weather-hourly",
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    issuedAt: validIso(payload.updateTime) ?? fetchedAt,
    fetchedAt,
    sourceUrl: safeQWeatherSource(payload.fxLink),
    attribution: stringArray(refer.sources),
    license: stringArray(refer.license),
    resolution: "坐标匹配城市/区域",
    timeZone: "UTC",
    hourly,
    note: "基于查询坐标匹配的城市/区域逐小时预报，不等同于AOI中心点实况、站点观测或官方灾害预警；光学适用性仅依据云量和降水进行初筛。",
  };
}

export function weatherImagingWindows(hourly: WeatherForecastHour[], maximumCloudPercent = 30): WeatherImagingWindow[] {
  const threshold = Math.min(100, Math.max(0, maximumCloudPercent));
  const groups: WeatherForecastHour[][] = [];
  for (const hour of [...hourly].sort((a, b) => +new Date(a.validAt) - +new Date(b.validAt))) {
    const eligible = hour.cloudPercent !== null && hour.cloudPercent <= threshold && hour.precipitationMm <= 0.2;
    if (!eligible) continue;
    const current = groups.at(-1);
    const gap = current?.length ? +new Date(hour.validAt) - +new Date(current.at(-1)!.validAt) : Infinity;
    if (!current || gap > 90 * 60_000) groups.push([hour]);
    else current.push(hour);
  }
  return groups.filter((group) => group.length >= 2).map((group) => ({
    start: group[0].validAt,
    end: new Date(+new Date(group.at(-1)!.validAt) + 3_600_000).toISOString(),
    minimumCloudPercent: Math.min(...group.map((hour) => hour.cloudPercent ?? 100)),
    maximumCloudPercent: Math.max(...group.map((hour) => hour.cloudPercent ?? 100)),
    maximumPrecipitationMm: Math.max(...group.map((hour) => hour.precipitationMm)),
  })).slice(0, 4);
}

function parseHour(value: unknown): WeatherForecastHour[] {
  if (!isRecord(value)) return [];
  const validAt = validIso(value.fxTime);
  const temperatureC = boundedNumber(value.temp, -100, 70);
  const windSpeedKmh = boundedNumber(value.windSpeed, 0, 500);
  const humidityPercent = boundedNumber(value.humidity, 0, 100);
  const precipitationMm = boundedNumber(value.precip, 0, 2_000);
  if (!validAt || temperatureC === null || windSpeedKmh === null || humidityPercent === null || precipitationMm === null) return [];
  const cloudPercent = boundedNumber(value.cloud, 0, 100);
  return [{
    validAt,
    temperatureC,
    condition: safeText(value.text, 40, "未知天气"),
    icon: safeText(value.icon, 8, ""),
    windSpeedKmh,
    windDirection: safeText(value.windDir, 30, "风向未知"),
    humidityPercent,
    precipitationMm,
    cloudPercent,
    opticalSuitability: opticalSuitability(cloudPercent, precipitationMm),
  }];
}

function opticalSuitability(cloudPercent: number | null, precipitationMm: number): WeatherSuitability {
  if (cloudPercent === null) return "unknown";
  if (cloudPercent <= 30 && precipitationMm <= 0.1) return "good";
  if (cloudPercent <= 70 && precipitationMm <= 1) return "conditional";
  return "poor";
}

function normalizeQWeatherOrigin(value: string) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("QWEATHER_API_HOST 必须是不含路径、参数和凭据的 HTTPS Host");
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".qweatherapi.com") || host === "qweatherapi.com") throw new Error("QWEATHER_API_HOST 必须使用控制台分配的专属 qweatherapi.com 域名");
  return url.origin;
}

function pemBytes(value: string) {
  const base64 = value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, "");
  if (!base64) throw new Error("QWeather Ed25519 私钥为空");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlText(value: string) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validIso(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function safeText(value: unknown, maximum: number, fallback: string) {
  const text = [...String(value ?? "")].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim();
  return text ? text.slice(0, maximum) : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item.slice(0, 240)] : []).slice(0, 10) : [];
}

function safeQWeatherSource(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol === "https:" && (url.hostname === "qweather.com" || url.hostname.endsWith(".qweather.com"))) return url.toString();
  } catch {
    // Use the public documentation page when the upstream link is absent.
  }
  return "https://dev.qweather.com/docs/api/weather/weather-hourly-forecast/";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
