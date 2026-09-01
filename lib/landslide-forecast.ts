import type { LandslideTerrainResult } from "./landslide-planning.ts";
import type { LandslidePilotRegion } from "./landslide-pilot-regions.ts";

export type LandslideForecastModelId = "best_match" | "cma_grapes_global";

export type LandslideTriggerLevel = "low_signal" | "watch" | "elevated" | "high" | "outside_slope_scope" | "unclassified";

export type LandslideForecastHorizon = {
  leadHours: 24 | 48 | 72;
  validFrom: string;
  validTo: string;
  precipitationMm: number;
  maximumHourlyPrecipitationMm: number;
  maximumSixHourPrecipitationMm: number;
  localDailyP95Mm: number | null;
  rainfallExceedanceRatio: number | null;
  antecedent48HourPrecipitationMm: number;
  antecedentLoadRatio: number | null;
  soilMoistureFraction: number | null;
  triggerLevel: LandslideTriggerLevel;
  triggerLabel: string;
  confidence: "medium" | "low" | "unclassified";
  automaticDispatchAllowed: false;
  action: string;
  basis: string[];
};

export type LandslideForecastReady = {
  state: "ready";
  product: "tianxun-rainfall-trigger-screening-v1";
  modelStatus: "experimental_unvalidated";
  provider: string;
  weatherModel: {
    id: LandslideForecastModelId;
    label: string;
    nativeResolutionKm: number | null;
    updateIntervalHours: number | null;
    selectionReason: string;
  };
  pilotRegion: LandslidePilotRegion | null;
  latitude: number;
  longitude: number;
  radiusKm: number;
  fetchedAt: string;
  weatherModelRunAt: null;
  baselinePeriod: { start: string; end: string; validDayCount: number };
  terrain: {
    state: LandslideTerrainResult["state"];
    maximumSlopeDeg: number | null;
    sourceUrl: string;
    note: string;
  };
  inputWarnings: string[];
  horizons: LandslideForecastHorizon[];
  sourceUrls: { forecast: string; climatology: string; terrain: string; method: string };
  dataBoundary: string;
  note: string;
};

export type LandslideForecastResponse = LandslideForecastReady | {
  state: "unavailable";
  provider: string;
  message: string;
};

export type OpenMeteoForecastSeries = {
  latitude: number;
  longitude: number;
  times: string[];
  precipitationMm: number[];
  soilMoistureFraction: Array<number | null>;
};

export type OpenMeteoClimatology = {
  dailyP95Mm: number;
  validDayCount: number;
};

const forecastDocumentationUrl = "https://open-meteo.com/en/docs";
const archiveDocumentationUrl = "https://open-meteo.com/en/docs/historical-weather-api";
const terrainDocumentationUrl = "https://open-meteo.com/en/docs/elevation-api";
const nasaMethodUrl = "https://github.com/nasa/LHASA";

export function landslideForecastBaselinePeriod(now = new Date()) {
  const endYear = now.getUTCFullYear() - 2;
  const startYear = endYear - 9;
  return { start: `${startYear}-01-01`, end: `${endYear}-12-31` };
}

export function buildOpenMeteoLandslideForecastUrl(latitude: number, longitude: number, model: LandslideForecastModelId = "best_match") {
  validateCoordinate(latitude, longitude);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: latitude.toFixed(6),
    longitude: longitude.toFixed(6),
    hourly: "precipitation,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm",
    past_hours: "48",
    forecast_hours: "72",
    timezone: "UTC",
    timeformat: "iso8601",
  }).toString();
  if (model === "cma_grapes_global") url.searchParams.set("models", model);
  return url.toString();
}

export function buildOpenMeteoLandslideClimatologyUrl(latitude: number, longitude: number, period = landslideForecastBaselinePeriod()) {
  validateCoordinate(latitude, longitude);
  if (!/^\d{4}-01-01$/.test(period.start) || !/^\d{4}-12-31$/.test(period.end) || period.start >= period.end) throw new Error("降雨基准期无效");
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.search = new URLSearchParams({
    latitude: latitude.toFixed(6),
    longitude: longitude.toFixed(6),
    start_date: period.start,
    end_date: period.end,
    daily: "precipitation_sum",
    timezone: "UTC",
  }).toString();
  return url.toString();
}

export function parseOpenMeteoLandslideForecast(payload: unknown): OpenMeteoForecastSeries {
  const root = record(payload, "Open-Meteo预报响应不是JSON对象");
  const hourly = record(root.hourly, "Open-Meteo预报缺少hourly字段");
  const times = stringArray(hourly.time, 130, "逐小时时间").map(utcIso);
  const precipitationMm = numberArray(hourly.precipitation, times.length, 0, 2_000, "逐小时降雨");
  const shallow = nullableNumberArray(hourly.soil_moisture_9_to_27cm, times.length, 0, 1, "9–27厘米土壤含水量");
  const deep = nullableNumberArray(hourly.soil_moisture_27_to_81cm, times.length, 0, 1, "27–81厘米土壤含水量");
  if (times.length < 96) throw new Error("Open-Meteo返回的前期与未来逐小时序列不足");
  for (let index = 1; index < times.length; index += 1) {
    const step = Date.parse(times[index]) - Date.parse(times[index - 1]);
    if (step < 50 * 60_000 || step > 70 * 60_000) throw new Error("Open-Meteo逐小时时间轴不连续");
  }
  const latitude = boundedNumber(root.latitude, -90, 90, "返回纬度");
  const longitude = boundedNumber(root.longitude, -180, 180, "返回经度");
  return {
    latitude,
    longitude,
    times,
    precipitationMm,
    soilMoistureFraction: shallow.map((value, index) => averageNullable(value, deep[index])),
  };
}

export function parseOpenMeteoLandslideClimatology(payload: unknown): OpenMeteoClimatology {
  const root = record(payload, "Open-Meteo历史响应不是JSON对象");
  const daily = record(root.daily, "Open-Meteo历史响应缺少daily字段");
  const values = nullableNumberArrayFlexible(daily.precipitation_sum, 0, 2_000, "历史日降雨").filter((value): value is number => value !== null);
  if (values.length < 3_000) throw new Error("本地降雨基准期有效日数不足3000天");
  return { dailyP95Mm: round(quantile(values, 0.95), 1), validDayCount: values.length };
}

export function buildLandslideForecast(input: {
  series: OpenMeteoForecastSeries;
  climatology?: OpenMeteoClimatology | null;
  terrain: LandslideTerrainResult;
  radiusKm: number;
  fetchedAt?: string;
  baselinePeriod?: { start: string; end: string };
  inputWarnings?: string[];
  pilotRegion?: LandslidePilotRegion | null;
  weatherModel?: LandslideForecastModelId;
}): LandslideForecastReady {
  const fetchedAt = utcIso(input.fetchedAt ?? new Date().toISOString());
  const fetchedAtMs = Date.parse(fetchedAt);
  const firstFuture = input.series.times.findIndex((time) => Date.parse(time) >= Math.floor(fetchedAtMs / 3_600_000) * 3_600_000);
  if (firstFuture < 24 || input.series.times.length - firstFuture < 72) throw new Error("逐小时序列不能完整覆盖前期48小时和未来72小时");
  const pastStart = Math.max(0, firstFuture - 48);
  const antecedent48HourPrecipitationMm = round(sum(input.series.precipitationMm.slice(pastStart, firstFuture)), 1);
  const soilMoistureFraction = latestFinite(input.series.soilMoistureFraction.slice(pastStart, firstFuture + 1));
  const maximumSlopeDeg = "maximumSlopeDeg" in input.terrain && Number.isFinite(input.terrain.maximumSlopeDeg)
    ? Number(input.terrain.maximumSlopeDeg)
    : null;
  const baseline = input.climatology?.dailyP95Mm && input.climatology.dailyP95Mm > 0 ? input.climatology : null;
  const horizons = ([24, 48, 72] as const).map((leadHours, horizonIndex) => {
    const start = firstFuture + horizonIndex * 24;
    const end = start + 24;
    const precipitation = input.series.precipitationMm.slice(start, end);
    const precipitationMm = round(sum(precipitation), 1);
    const maximumHourlyPrecipitationMm = round(Math.max(...precipitation), 1);
    const maximumSixHourPrecipitationMm = round(rollingMaximum(precipitation, 6), 1);
    const rainfallExceedanceRatio = baseline ? round(precipitationMm / baseline.dailyP95Mm, 2) : null;
    const antecedentLoadRatio = baseline ? round(antecedent48HourPrecipitationMm / (2 * baseline.dailyP95Mm), 2) : null;
    const triggerLevel = classifyTrigger({ maximumSlopeDeg, rainfallExceedanceRatio, antecedentLoadRatio });
    return {
      leadHours,
      validFrom: input.series.times[start],
      validTo: new Date(Date.parse(input.series.times[end - 1]) + 3_600_000).toISOString(),
      precipitationMm,
      maximumHourlyPrecipitationMm,
      maximumSixHourPrecipitationMm,
      localDailyP95Mm: baseline?.dailyP95Mm ?? null,
      rainfallExceedanceRatio,
      antecedent48HourPrecipitationMm,
      antecedentLoadRatio,
      soilMoistureFraction: soilMoistureFraction === null ? null : round(soilMoistureFraction, 3),
      triggerLevel,
      triggerLabel: triggerLabel(triggerLevel),
      confidence: triggerLevel === "unclassified" ? "unclassified" as const : leadHours === 72 ? "low" as const : "medium" as const,
      automaticDispatchAllowed: false as const,
      action: triggerAction(triggerLevel, leadHours),
      basis: triggerBasis({ maximumSlopeDeg, rainfallExceedanceRatio, antecedentLoadRatio, soilMoistureFraction, baselineAvailable: Boolean(baseline), leadHours }),
    };
  });
  const baselinePeriod = input.baselinePeriod ?? landslideForecastBaselinePeriod(new Date(fetchedAt));
  const weatherModel = input.weatherModel ?? input.pilotRegion?.forecastModel.id ?? "best_match";
  const regionalModel = weatherModel === "cma_grapes_global";
  return {
    state: "ready",
    product: "tianxun-rainfall-trigger-screening-v1",
    modelStatus: "experimental_unvalidated",
    provider: regionalModel ? "Open-Meteo · CMA GRAPES Global · Copernicus DEM" : "Open-Meteo Best Match · Copernicus DEM",
    weatherModel: regionalModel ? {
      id: "cma_grapes_global",
      label: "CMA GRAPES Global",
      nativeResolutionKm: 15,
      updateIntervalHours: 6,
      selectionReason: "重庆/江苏区域试验固定选择中国气象局全球模式；Open-Meteo按小时插值输出不代表模式原生时间分辨率。",
    } : {
      id: "best_match",
      label: "Open-Meteo Best Match",
      nativeResolutionKm: null,
      updateIntervalHours: null,
      selectionReason: "区域试验范围外继续使用按位置自动选择的全球天气模式。",
    },
    pilotRegion: input.pilotRegion ?? null,
    latitude: input.series.latitude,
    longitude: input.series.longitude,
    radiusKm: input.radiusKm,
    fetchedAt,
    weatherModelRunAt: null,
    baselinePeriod: { ...baselinePeriod, validDayCount: baseline?.validDayCount ?? 0 },
    terrain: {
      state: input.terrain.state,
      maximumSlopeDeg,
      sourceUrl: "sourceUrl" in input.terrain && input.terrain.sourceUrl ? input.terrain.sourceUrl : terrainDocumentationUrl,
      note: input.terrain.state === "ready" ? input.terrain.note : "message" in input.terrain ? input.terrain.message : "地形输入不可用。",
    },
    inputWarnings: (input.inputWarnings ?? []).map((item) => item.replace(/[\r\n]+/g, " ").slice(0, 180)).slice(0, 4),
    horizons,
    sourceUrls: { forecast: forecastDocumentationUrl, climatology: archiveDocumentationUrl, terrain: terrainDocumentationUrl, method: nasaMethodUrl },
    dataBoundary: "这是地点/AOI中心的降雨触发条件筛查，不是空间概率栅格、滑坡体边界或官方地质灾害预警。24/48小时可用于人工预置任务；72小时只作趋势监视。重庆/江苏试验配置只改变数据路由和复核口径，不冒充已标定的地方模型。",
    note: "规则使用未来24小时降雨相对本地10年日降雨P95的倍数、前期48小时降雨和NASA LHASA采用的10°坡度显示门槛。它没有复刻NASA XGBoost模型，也未使用岩性、PGA、SMAP剖面湿度或完成区域样本标定，因此不输出滑坡概率，不允许自动下发。Open-Meteo许可需按实际使用场景核对，正式业务应使用自建或有服务保障的数据链路。",
  };
}

function classifyTrigger(input: { maximumSlopeDeg: number | null; rainfallExceedanceRatio: number | null; antecedentLoadRatio: number | null }): LandslideTriggerLevel {
  if (input.maximumSlopeDeg === null || input.rainfallExceedanceRatio === null || input.antecedentLoadRatio === null) return "unclassified";
  if (input.maximumSlopeDeg < 10) return "outside_slope_scope";
  if (input.rainfallExceedanceRatio >= 1.5 || (input.rainfallExceedanceRatio >= 1 && input.antecedentLoadRatio >= 1)) return "high";
  if (input.rainfallExceedanceRatio >= 1 || (input.rainfallExceedanceRatio >= 0.7 && input.antecedentLoadRatio >= 0.75)) return "elevated";
  if (input.rainfallExceedanceRatio >= 0.5) return "watch";
  return "low_signal";
}

function triggerLabel(level: LandslideTriggerLevel) {
  return {
    low_signal: "低触发信号",
    watch: "关注",
    elevated: "加强关注",
    high: "高触发信号",
    outside_slope_scope: "坡度门槛外",
    unclassified: "输入不足",
  }[level];
}

function triggerAction(level: LandslideTriggerLevel, leadHours: 24 | 48 | 72) {
  if (leadHours === 72) return "仅跟踪趋势；等待下一报次，不据此自动建立或下发卫星任务。";
  if (level === "high") return "人工复核地方地质预警和AOI，可预置灾前参考影像与灾后快速重访窗口。";
  if (level === "elevated") return "提高刷新频率，核对坡面、沟道和在册隐患点，准备任务候选。";
  if (level === "watch") return "继续监测下一报次；当前信号不足以单独触发卫星任务。";
  if (level === "outside_slope_scope") return "当前粗格网未达到10°显示门槛；如代表点误差较大，应扩大或人工修正AOI。";
  if (level === "unclassified") return "补齐地形或本地降雨基准后再分类。";
  return "保持常规监测；低信号不等于不会发生局地滑坡。";
}

function triggerBasis(input: { maximumSlopeDeg: number | null; rainfallExceedanceRatio: number | null; antecedentLoadRatio: number | null; soilMoistureFraction: number | null; baselineAvailable: boolean; leadHours: 24 | 48 | 72 }) {
  const basis = [
    input.maximumSlopeDeg === null ? "缺少DEM坡度" : `DEM最大近似坡度${input.maximumSlopeDeg.toFixed(1)}°`,
    input.baselineAvailable && input.rainfallExceedanceRatio !== null ? `本时段雨量为本地日雨P95的${input.rainfallExceedanceRatio.toFixed(2)}倍` : "缺少本地日雨P95基准",
    input.antecedentLoadRatio === null ? "前期雨量无法归一" : `前期48小时雨量负荷${input.antecedentLoadRatio.toFixed(2)}倍`,
    input.soilMoistureFraction === null ? "土壤含水量缺测" : `模式土壤含水量${input.soilMoistureFraction.toFixed(3)} m³/m³（仅展示，不参与阈值）`,
  ];
  if (input.leadHours === 72) basis.push("第3天超过NASA当前代码声明的2天可靠预报范围，仅作低置信趋势");
  return basis;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, maximum: number, label: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((item) => typeof item !== "string")) throw new Error(`${label}结构无效`);
  return value as string[];
}

function numberArray(value: unknown, length: number, minimum: number, maximum: number, label: string) {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${label}长度无效`);
  return value.map((item) => boundedNumber(item, minimum, maximum, label));
}

function nullableNumberArray(value: unknown, length: number, minimum: number, maximum: number, label: string) {
  if (value === undefined) return Array.from({ length }, () => null);
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${label}长度无效`);
  return value.map((item) => item === null ? null : boundedNumber(item, minimum, maximum, label));
}

function nullableNumberArrayFlexible(value: unknown, minimum: number, maximum: number, label: string) {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${label}结构无效`);
  return value.map((item) => item === null ? null : boundedNumber(item, minimum, maximum, label));
}

function boundedNumber(value: unknown, minimum: number, maximum: number, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label}包含越界值`);
  return number;
}

function utcIso(value: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error("时间字段无效");
  return date.toISOString();
}

function validateCoordinate(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || latitude < -85 || latitude > 85 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("滑坡预报查询坐标无效或接近极区");
}

function quantile(values: number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]) * fraction;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function rollingMaximum(values: number[], window: number) {
  let maximum = 0;
  for (let index = 0; index <= values.length - window; index += 1) maximum = Math.max(maximum, sum(values.slice(index, index + window)));
  return maximum;
}

function latestFinite(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] !== null && Number.isFinite(values[index])) return values[index];
  return null;
}

function averageNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return (left + right) / 2;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}
