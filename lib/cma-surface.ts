import stationCatalog from "./data/cma-surface-stations.json" with { type: "json" };

export const CMA_SURFACE_PUBLIC_URL = "https://data.cma.cn/";
export const CMA_SURFACE_DEFAULT_API_URL = "http://api.data.cma.cn:8090/api";
export const CMA_SURFACE_SOURCE = "中国气象数据网 CMA · 地面观测";
export const CMA_SURFACE_DEFAULT_STATION_IDS = ["58354", "58346", "58351", "58349"];
export const CMA_SURFACE_DEFAULT_ELEMENTS = [
  "Station_Id_C", "Year", "Mon", "Day", "Hour", "PRE_3h",
  "WIN_S_Inst_Max", "WIN_S_MAX", "WIN_S_Avg_2mi", "WEP_Now",
];

const allowedElements = new Set([
  "Station_Id_C", "Year", "Mon", "Day", "Hour", "PRS", "PRS_Sea", "PRS_Max", "PRS_Min",
  "TEM", "TEM_MAX", "TEM_MIN", "RHU", "RHU_Min", "VAP", "PRE_3h", "WIN_D_INST_Max",
  "WIN_S_MAX", "WIN_D_S_Max", "WIN_S_Avg_2mi", "WIN_D_Avg_2mi", "WEP_Now",
  "WIN_S_Inst_Max", "VIS", "CLO_Cov", "CLO_Cov_Low", "CLO_COV_LM", "Datetime",
]);

type StationRow = { id: string; province: string; name: string; longitude: number; latitude: number };
const stations = new Map((stationCatalog.stations as StationRow[]).map((station) => [station.id, station]));

export type CmaSurfaceConfig = {
  apiUrl: string;
  userId: string;
  password: string;
  stationIds: string[];
  elements: string[];
  timeZone: "UTC" | "Asia/Shanghai";
  lookbackHours: number;
  allowInsecureHttp: boolean;
};

export type CmaSurfaceCandidate = {
  id: string;
  hazard: "flood" | "cyclone";
  title: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  updatedAt: string;
  sourceSeverity: string;
  country: string;
  description: string;
};

export function cmaSurfaceConfiguration(env: NodeJS.ProcessEnv = process.env): { ready: boolean; message: string; config?: CmaSurfaceConfig } {
  const userId = env.CMA_SURFACE_USER_ID?.trim() ?? "";
  const password = env.CMA_SURFACE_PASSWORD?.trim() ?? "";
  if (!userId || !password) {
    return { ready: false, message: "需要配置 CMA_SURFACE_USER_ID 与 CMA_SURFACE_PASSWORD；真实值只保存在服务器环境变量中" };
  }

  const allowInsecureHttp = env.CMA_SURFACE_ALLOW_INSECURE_HTTP === "true";
  const apiUrl = env.CMA_SURFACE_API_URL?.trim() || CMA_SURFACE_DEFAULT_API_URL;
  try {
    validateCmaSurfaceApiUrl(apiUrl, allowInsecureHttp);
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : "CMA 地面接口配置无效" };
  }

  try {
    const stationIds = parseStationIds(env.CMA_SURFACE_STATION_IDS);
    const elements = parseElements(env.CMA_SURFACE_ELEMENTS);
    const timeZone = env.CMA_SURFACE_TIME_ZONE === "Asia/Shanghai" ? "Asia/Shanghai" : "UTC";
    const requestedLookback = Number(env.CMA_SURFACE_LOOKBACK_HOURS ?? 168);
    const lookbackHours = Number.isFinite(requestedLookback) ? Math.min(168, Math.max(3, Math.floor(requestedLookback))) : 168;
    return {
      ready: true,
      message: "已配置为滞后观测核验源；不会独立生成灾害或卫星任务",
      config: { apiUrl, userId, password, stationIds, elements, timeZone, lookbackHours, allowInsecureHttp },
    };
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : "CMA 地面接口配置无效" };
  }
}

export function buildCmaSurfaceRequestUrl(config: CmaSurfaceConfig, now = new Date()) {
  const url = new URL(validateCmaSurfaceApiUrl(config.apiUrl, config.allowInsecureHttp));
  const start = new Date(now.getTime() - config.lookbackHours * 3_600_000);
  url.search = new URLSearchParams({
    userId: config.userId,
    pwd: config.password,
    dataFormat: "json",
    interfaceId: "getSurfEleByTimeRangeAndStaID",
    dataCode: "SURF_CHN_MUL_HOR_3H",
    timeRange: `[${formatCmaTime(start, config.timeZone)},${formatCmaTime(now, config.timeZone)}]`,
    staIDs: config.stationIds.join(","),
    elements: config.elements.join(","),
  }).toString();
  return url.toString();
}

export function parseCmaSurfacePayload(payload: unknown, timeZone: CmaSurfaceConfig["timeZone"] = "UTC"): CmaSurfaceCandidate[] {
  if (!isRecord(payload)) throw new Error("CMA 地面观测响应不是 JSON 对象");
  const returnCode = payload.returnCode ?? payload.code;
  if (returnCode !== undefined && ![0, "0", "S", "success", "SUCCESS"].includes(returnCode as never)) {
    throw new Error(`CMA 接口拒绝请求：${safeUpstreamMessage(payload.returnMessage ?? payload.message)}`);
  }
  if (!Array.isArray(payload.DS)) throw new Error("CMA 地面观测响应缺少 DS 数组");
  if (payload.DS.length > 10_000) throw new Error("CMA 地面观测响应记录数超过安全上限");

  const candidates = payload.DS.flatMap((row) => observationCandidates(row, timeZone));
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
    .sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
}

export function isCmaSurfaceSource(source: string) {
  return source === CMA_SURFACE_SOURCE;
}

export function redactCmaSecret(value: string) {
  return value
    .replace(/([?&](?:userId|pwd)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(?:password|pwd)\s*[:=]\s*[^,;&\s]+/gi, "pwd=[REDACTED]");
}

function observationCandidates(value: unknown, timeZone: CmaSurfaceConfig["timeZone"]): CmaSurfaceCandidate[] {
  if (!isRecord(value)) return [];
  const row = caseInsensitiveRecord(value);
  const stationId = String(row.station_id_c ?? "").trim();
  const station = stations.get(stationId);
  const occurredAt = observationTime(row, timeZone);
  if (!station || !occurredAt) return [];

  const common = {
    latitude: station.latitude,
    longitude: station.longitude,
    occurredAt,
    updatedAt: occurredAt,
    country: `中国 · ${station.province} · ${station.name}站`,
  };
  const results: CmaSurfaceCandidate[] = [];
  const precipitation = observedNumber(row.pre_3h, 0, 1_000);
  if (precipitation !== null && precipitation >= 20) {
    results.push({
      ...common,
      id: `cma-surface-${stationId}-flood-${occurredAt}`,
      hazard: "flood",
      title: `${station.name}站3小时强降水观测`,
      sourceSeverity: `核验值：3小时降水 ${formatMetric(precipitation)} mm`,
      description: "CMA质量控制地面站逐三小时资料，官方数据约滞后2天。该值仅用于核验邻近洪水事件，不是气象预警、灾情边界或实时任务触发依据。",
    });
  }

  const maximumWind = Math.max(
    observedNumber(row.win_s_inst_max, 0, 150) ?? -Infinity,
    observedNumber(row.win_s_max, 0, 150) ?? -Infinity,
    observedNumber(row.win_s_avg_2mi, 0, 150) ?? -Infinity,
  );
  if (Number.isFinite(maximumWind) && maximumWind >= 17.2) {
    results.push({
      ...common,
      id: `cma-surface-${stationId}-cyclone-${occurredAt}`,
      hazard: "cyclone",
      title: `${station.name}站大风观测`,
      sourceSeverity: `核验值：最大风速 ${formatMetric(maximumWind)} m/s`,
      description: "CMA质量控制地面站观测，官方数据约滞后2天。该值只在时空匹配时核验既有热带气旋过程，不据此把普通大风判定为台风，也不生成独立任务坐标。",
    });
  }
  return results;
}

function parseStationIds(value: string | undefined) {
  const ids = (value?.split(",") ?? CMA_SURFACE_DEFAULT_STATION_IDS).map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 30 || unique.some((id) => !/^\d{5}$/.test(id))) throw new Error("CMA_SURFACE_STATION_IDS 必须包含1至30个五位站号");
  const unknown = unique.filter((id) => !stations.has(id));
  if (unknown.length) throw new Error(`CMA站号不在官方清单中：${unknown.slice(0, 3).join(",")}`);
  return unique;
}

function parseElements(value: string | undefined) {
  const requested = (value?.split(",") ?? CMA_SURFACE_DEFAULT_ELEMENTS).map((item) => item.trim()).filter(Boolean);
  const canonical = new Map([...allowedElements].map((element) => [element.toLowerCase(), element]));
  const invalid = requested.filter((element) => !canonical.has(element.toLowerCase()));
  if (invalid.length) throw new Error(`CMA_SURFACE_ELEMENTS 含未授权字段：${invalid.slice(0, 3).join(",")}`);
  const required = ["Station_Id_C", "Year", "Mon", "Day", "Hour"];
  return [...new Set([...required, ...requested.map((element) => canonical.get(element.toLowerCase()) as string)])];
}

function validateCmaSurfaceApiUrl(value: string, allowInsecureHttp: boolean) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("CMA_SURFACE_API_URL 不得包含凭据、查询参数或片段");
  if (url.protocol === "http:") {
    const officialLegacyEndpoint = url.hostname === "api.data.cma.cn" && url.port === "8090" && url.pathname === "/api";
    if (!officialLegacyEndpoint || !allowInsecureHttp) {
      throw new Error("CMA地面API目前仅验证到明文HTTP；请配置HTTPS网关，或确认风险后设置 CMA_SURFACE_ALLOW_INSECURE_HTTP=true");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("CMA_SURFACE_API_URL 必须使用 HTTPS");
  }
  if (isPrivateHost(url.hostname)) throw new Error("CMA_SURFACE_API_URL 不得指向本机或内网地址");
  return url.toString();
}

function formatCmaTime(date: Date, timeZone: CmaSurfaceConfig["timeZone"]) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

function observationTime(row: Record<string, unknown>, timeZone: CmaSurfaceConfig["timeZone"]) {
  const compact = String(row.datetime ?? "").replace(/\D/g, "");
  const parts = compact.length >= 10
    ? [compact.slice(0, 4), compact.slice(4, 6), compact.slice(6, 8), compact.slice(8, 10), compact.slice(10, 12) || "0", compact.slice(12, 14) || "0"]
    : [row.year, row.mon, row.day, row.hour, 0, 0];
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const [year, month, day, hour, minute, second] = numbers;
  const offsetHours = timeZone === "Asia/Shanghai" ? 8 : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, second));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getTime() > Date.now() + 3_600_000) return null;
  return date.toISOString();
}

function caseInsensitiveRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

function observedNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) >= 999_000 || number < minimum || number > maximum) return null;
  return number;
}

function formatMetric(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function safeUpstreamMessage(value: unknown) {
  return redactCmaSecret(String(value ?? "未知错误")).replace(/[\r\n]+/g, " ").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPrivateHost(host: string) {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.endsWith(".local")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}
