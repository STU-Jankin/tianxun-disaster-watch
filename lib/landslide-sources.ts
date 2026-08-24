import type { DisasterEvent } from "./disasters.ts";
import type { PublicEventCandidate } from "./public-event-sources.ts";

type GeoGeometry = { type: string; coordinates: unknown };
export type NveBoundaryKey = { kind: "kommuner" | "fylker"; id: string };

const usgsGroundFailureUrl = "https://earthquake.usgs.gov/data/ground-failure/";
const nvePublicUrl = "https://www.varsom.no/en/landslide-warning/";

export function parseUsgsGroundFailureDetails(payload: unknown): PublicEventCandidate[] {
  const features = isRecord(payload) && Array.isArray(payload.features) ? payload.features.filter(isRecord) : [];
  return features.flatMap((feature): PublicEventCandidate[] => {
    const properties = record(feature.properties);
    const products = record(properties.products);
    const groundFailure = Array.isArray(products["ground-failure"])
      ? products["ground-failure"].filter(isRecord)
      : [];
    const product = [...groundFailure]
      .filter((item) => !/delete/i.test(text(item.status)))
      .sort((a, b) => numericTime(b.updateTime) - numericTime(a.updateTime))[0];
    if (!product) return [];

    const productProperties = record(product.properties);
    const alert = text(productProperties["landslide-alert"]).toLowerCase();
    if (!/^(yellow|orange|red)$/.test(alert)) return [];
    const sourceEventId = stableId(feature.id ?? productProperties.eventsourcecode ?? properties.code);
    const occurredAt = validIso(productProperties.eventtime ?? properties.time);
    const updatedAt = validIso(product.updateTime ?? properties.updated);
    const geometry = groundFailureBounds(productProperties);
    if (!sourceEventId || !occurredAt || !updatedAt || !geometry) return [];

    const magnitude = boundedNumber(productProperties.magnitude ?? properties.mag, 0, 12);
    const place = safeText(properties.place, 180, "USGS earthquake region");
    const hazardValue = boundedNumber(productProperties["landslide-hazard-alert-value"], 0, 100);
    const populationAlert = safeText(productProperties["landslide-population-alert-color"], 24, "unknown");
    const sourceUrl = safeHttps(properties.url, usgsGroundFailureUrl);
    return [{
      sourceEventId,
      title: `震生滑坡风险 · ${magnitude === null ? "地震" : `M${magnitude.toFixed(1)}`} · ${place}`,
      hazard: "landslide" as const,
      geometry,
      occurredAt,
      updatedAt,
      activityAt: updatedAt,
      issuedAt: updatedAt,
      phenomenonStage: "forecast",
      sourceUrl,
      sourceSeverity: `USGS landslide ${alert}${hazardValue === null ? "" : ` · hazard ${hazardValue.toFixed(1)}`}`,
      severity: colourSeverity(alert),
      magnitude: magnitude ?? undefined,
      magnitudeUnit: magnitude === null ? undefined : "Mw",
      country: place,
      description: `USGS Ground Failure 根据本次地震估算区域滑坡概率；人口暴露等级为 ${populationAlert}。该矩形是模型计算覆盖范围，不是已经发生滑坡的边界，也不证明范围内每处均受影响，必须结合后续遥感或现场证据复核后再下发任务。`,
      requiresReview: true,
    }];
  }).slice(0, 40);
}

export function nveWarningBoundaryKeys(value: unknown): NveBoundaryKey[] {
  const warning = record(value);
  const municipalities = recordArray(warning.MunicipalityList)
    .map((item) => stableNumericId(item.Id))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ kind: "kommuner" as const, id: id.padStart(4, "0") }));
  if (municipalities.length) return uniqueBoundaryKeys(municipalities);
  const counties = recordArray(warning.CountyList)
    .map((item) => stableNumericId(item.Id))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ kind: "fylker" as const, id: id.padStart(2, "0") }));
  return uniqueBoundaryKeys(counties);
}

export function parseNveLandslideWarning(
  value: unknown,
  geometry: GeoGeometry | null,
  now = Date.now(),
): PublicEventCandidate | null {
  const warning = record(value);
  const activityLevel = boundedNumber(warning.ActivityLevel, 0, 4);
  const status = text(warning.CapStatus);
  const validFrom = parseNveLocalDate(warning.ValidFrom);
  const validTo = parseNveLocalDate(warning.ValidTo);
  const issuedAt = parseNveLocalDate(warning.PublishTime ?? warning.CreatedTime);
  const sourceEventId = stableId(warning.MasterId ?? warning.EventId ?? warning.Id);
  if (activityLevel === null || activityLevel < 2 || /test|exercise|cancel/i.test(status)
      || !validFrom || !validTo || !issuedAt || !sourceEventId || !geometry
      || +new Date(validTo) <= now) return null;

  const area = safeText(warning.Area, 180, "Norway");
  const dangerType = safeText(warning.DangerTypeName, 120, "landslide danger");
  const mainText = safeText(warning.MainText, 700, "NVE official regional landslide warning.");
  const consequence = safeText(warning.ConsequenceText, 500, "");
  return {
    sourceEventId,
    title: `挪威滑坡预警 · ${area}`,
    hazard: "landslide",
    geometry,
    occurredAt: validFrom,
    updatedAt: issuedAt,
    activityAt: issuedAt,
    issuedAt,
    validFrom,
    validTo,
    phenomenonStage: "warning",
    sourceUrl: nvePublicUrl,
    sourceSeverity: `NVE ${activityLevel}/4 · ${dangerType}`,
    severity: nveSeverity(activityLevel),
    country: `Norway · ${area}`,
    description: `${mainText}${consequence ? ` ${consequence}` : ""} 几何来自 Kartverket 官方行政区边界，表示预警适用区域，不是已发生滑坡的遥感提取边界；下发成像前仍需人工缩小 AOI。`,
    requiresReview: true,
  };
}

export function geoJsonBoundaryGeometry(payload: unknown): GeoGeometry | null {
  if (isRecord(payload) && payload.type === "Feature") return geometryValue(payload.geometry);
  if (isRecord(payload) && payload.type === "FeatureCollection" && Array.isArray(payload.features)) {
    return combinePolygonGeometries(payload.features.filter(isRecord).map((feature) => geometryValue(feature.geometry)).filter(nonNull));
  }
  return geometryValue(payload);
}

export function combinePolygonGeometries(geometries: GeoGeometry[]): GeoGeometry | null {
  const polygons = geometries.flatMap(polygonParts)
    .map((polygon) => simplifyPolygon(polygon))
    .filter(nonNull)
    .sort((a, b) => approximatePolygonArea(b) - approximatePolygonArea(a))
    .slice(0, 100);
  if (!polygons.length) return null;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
}

export function parseNveLocalDate(value: unknown): string | null {
  if (typeof value === "number") return validIso(value);
  const source = text(value).trim();
  if (!source) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(source)) return validIso(source);
  const match = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second = "0"] = match;
  const local = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)] as const;
  const guess = Date.UTC(local[0], local[1] - 1, local[2], local[3], local[4], local[5]);
  if (!validDateParts(local, new Date(guess))) return null;
  let instant = guess;
  for (let pass = 0; pass < 2; pass += 1) instant = guess - osloOffsetMs(instant);
  return new Date(instant).toISOString();
}

function groundFailureBounds(properties: Record<string, unknown>): GeoGeometry | null {
  const minLatitude = boundedNumber(properties["landslide-min-latitude"], -90, 90);
  const maxLatitude = boundedNumber(properties["landslide-max-latitude"], -90, 90);
  const minLongitude = boundedNumber(properties["landslide-min-longitude"], -180, 180);
  const maxLongitude = boundedNumber(properties["landslide-max-longitude"], -180, 180);
  if (minLatitude === null || maxLatitude === null || minLongitude === null || maxLongitude === null
      || minLatitude >= maxLatitude || minLongitude >= maxLongitude
      || maxLatitude - minLatitude > 40 || maxLongitude - minLongitude > 80) return null;
  return { type: "Polygon", coordinates: [[
    [minLongitude, minLatitude], [maxLongitude, minLatitude], [maxLongitude, maxLatitude],
    [minLongitude, maxLatitude], [minLongitude, minLatitude],
  ]] };
}

function polygonParts(geometry: GeoGeometry): unknown[][][] {
  if (!Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as unknown[][]];
  return geometry.type === "MultiPolygon" ? geometry.coordinates as unknown[][][] : [];
}

function simplifyPolygon(value: unknown[][]): unknown[][] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const rings = value.map((ring) => simplifyRing(ring)).filter(nonNull);
  return rings.length ? rings : null;
}

function simplifyRing(value: unknown): number[][] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const points = value.map(coordinatePair).filter(nonNull);
  if (points.length < 4) return null;
  const open = points[0][0] === points.at(-1)?.[0] && points[0][1] === points.at(-1)?.[1] ? points.slice(0, -1) : points;
  const stride = Math.max(1, Math.ceil(open.length / 700));
  const sampled = open.filter((_, index) => index % stride === 0);
  if (sampled.length < 3) return null;
  return [...sampled, [...sampled[0]]];
}

function approximatePolygonArea(polygon: unknown[][]) {
  const ring = Array.isArray(polygon[0]) ? polygon[0].map(coordinatePair).filter(nonNull) : [];
  let total = 0;
  for (let index = 1; index < ring.length; index += 1) total += ring[index - 1][0] * ring[index][1] - ring[index][0] * ring[index - 1][1];
  return Math.abs(total / 2);
}

function coordinatePair(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
}

function geometryValue(value: unknown): GeoGeometry | null {
  if (!isRecord(value) || !/^(Polygon|MultiPolygon)$/.test(text(value.type)) || !Array.isArray(value.coordinates)) return null;
  return { type: text(value.type), coordinates: value.coordinates };
}

function nveSeverity(level: number): DisasterEvent["severity"] {
  if (level >= 4) return "red";
  if (level >= 3) return "orange";
  return "yellow";
}

function colourSeverity(value: string): DisasterEvent["severity"] {
  if (/red/i.test(value)) return "red";
  if (/orange/i.test(value)) return "orange";
  if (/yellow/i.test(value)) return "yellow";
  return "blue";
}

function osloOffsetMs(instant: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    timeZoneName: "longOffset",
    year: "numeric",
  }).formatToParts(new Date(instant));
  const offset = parts.find((part) => part.type === "timeZoneName")?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!offset) return 0;
  const milliseconds = (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  return offset[1] === "-" ? -milliseconds : milliseconds;
}

function validDateParts(parts: readonly number[], date: Date) {
  return date.getUTCFullYear() === parts[0] && date.getUTCMonth() + 1 === parts[1] && date.getUTCDate() === parts[2]
    && date.getUTCHours() === parts[3] && date.getUTCMinutes() === parts[4] && date.getUTCSeconds() === parts[5];
}

function uniqueBoundaryKeys(keys: NveBoundaryKey[]) {
  return [...new Map(keys.map((key) => [`${key.kind}:${key.id}`, key])).values()].slice(0, 60);
}

function recordArray(value: unknown) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return Object.values(value).filter(isRecord);
  return [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numericTime(value: unknown) {
  const date = validIso(value);
  return date ? +new Date(date) : 0;
}

function validIso(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const numeric = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function stableNumericId(value: unknown) {
  const id = text(value).trim();
  return /^\d{1,8}$/.test(id) ? id : null;
}

function stableId(value: unknown) {
  const id = text(value).trim();
  return id && id.length <= 220 && !/(?:^|[-_:])(undefined|null|nan|unknown)(?:$|[-_:])/i.test(id) ? id : null;
}

function safeText(value: unknown, maximum: number, fallback: string) {
  const result = [...text(value)].map((character) => character.charCodeAt(0) < 32 ? " " : character).join("").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, maximum) : fallback;
}

function safeHttps(value: unknown, fallback: string) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
