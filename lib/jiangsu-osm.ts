import type { EventGeometry } from "./disasters.ts";
import type { ExposureFacility, ExposureFacilityKind, OsmExposureScope } from "./exposure-assessment.ts";

export const jiangsuOsmDataProfile = "jiangsu_daily" as const;

export type JiangsuOsmRuntimeConfig = {
  endpoint: URL;
  token: string;
  maximumAreaKm2: number;
  timeoutMs: number;
};

export type JiangsuOsmExposureResult = {
  supported: true;
  provider: "OpenStreetMap · 江苏本地日更索引";
  sourceTimestamp: string;
  generatedAt: string;
  sourceUrl?: string;
  gridSizeDegrees: number;
  aggregationMethod: "feature_bbox_centroid_grid";
  coverageMode: "full" | "jiangsu_intersection";
  mappedBuildingCount: number;
  mappedRoadWayCount: number;
  mappedKeyFacilityCount: number;
  facilityCounts: Partial<Record<ExposureFacilityKind, number>>;
  facilities: ExposureFacility[];
  facilitiesTruncated: boolean;
};

export function resolveJiangsuOsmRuntimeConfig(environment: Record<string, string | undefined> = process.env): JiangsuOsmRuntimeConfig | null {
  const rawEndpoint = environment.JIANGSU_OSM_API_URL?.trim();
  const token = environment.JIANGSU_OSM_API_TOKEN?.trim();
  if (!rawEndpoint && !token) return null;
  if (!rawEndpoint || !token) throw new Error("江苏 OSM 本地索引必须同时配置 API 地址和访问令牌");
  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); } catch { throw new Error("JIANGSU_OSM_API_URL 无效"); }
  if (endpoint.username || endpoint.password || !endpoint.hostname || endpoint.pathname !== "/v1/exposure") throw new Error("江苏 OSM API 地址必须指向无凭据的 /v1/exposure");
  const privateEndpoint = privateLiteral(endpoint.hostname);
  const allowPrivate = environment.JIANGSU_OSM_ALLOW_PRIVATE_ENDPOINT === "true";
  if (privateEndpoint && !allowPrivate) throw new Error("内网江苏 OSM 地址需要设置 JIANGSU_OSM_ALLOW_PRIVATE_ENDPOINT=true");
  if (endpoint.protocol !== "https:" && !(allowPrivate && privateEndpoint && endpoint.protocol === "http:")) throw new Error("江苏 OSM API 必须使用 HTTPS；仅显式允许的内网地址可使用 HTTP");
  return {
    endpoint,
    token,
    maximumAreaKm2: boundedNumber(environment.JIANGSU_OSM_MAX_AREA_KM2, 120_000, 100, 150_000),
    timeoutMs: boundedNumber(environment.JIANGSU_OSM_TIMEOUT_SECONDS, 15, 3, 60) * 1_000,
  };
}

export function isJiangsuOsmCandidate(geometry: EventGeometry) {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return false;
  const bbox = geometryBbox(geometry);
  // Broad intersection gate only avoids needless service calls. The data
  // service performs the authoritative polygon intersection check.
  return bbox[2] >= 116 && bbox[3] >= 30.4 && bbox[0] <= 122.3 && bbox[1] <= 35.4;
}

export function parseJiangsuOsmExposure(payload: unknown): JiangsuOsmExposureResult | { supported: false; reason: string; sourceTimestamp?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("江苏 OSM 响应结构无效");
  const value = payload as Record<string, unknown>;
  if (value.supported === false) return {
    supported: false,
    reason: safeText(value.reason, 240) || "AOI 不在江苏本地索引覆盖范围内",
    sourceTimestamp: validTimestamp(value.sourceTimestamp),
  };
  if (value.supported !== true) throw new Error("江苏 OSM 响应缺少 supported 状态");
  const sourceTimestamp = validTimestamp(value.sourceTimestamp);
  const generatedAt = validTimestamp(value.generatedAt);
  if (!sourceTimestamp || !generatedAt) throw new Error("江苏 OSM 响应缺少有效数据时点");
  const mappedBuildingCount = safeCount(value.mappedBuildingCount, "建筑");
  const mappedRoadWayCount = safeCount(value.mappedRoadWayCount, "道路");
  const mappedKeyFacilityCount = safeCount(value.mappedKeyFacilityCount, "关键设施");
  const rawFacilities = Array.isArray(value.facilities) ? value.facilities : [];
  if (rawFacilities.length > 300) throw new Error("江苏 OSM 返回的设施点超过安全上限");
  const facilities = rawFacilities.map(validFacility);
  const facilityCounts: Partial<Record<ExposureFacilityKind, number>> = {};
  if (value.facilityCounts && typeof value.facilityCounts === "object" && !Array.isArray(value.facilityCounts)) {
    for (const kind of facilityKinds) {
      const count = (value.facilityCounts as Record<string, unknown>)[kind];
      if (count !== undefined) facilityCounts[kind] = safeCount(count, `${kind}设施`);
    }
  }
  const gridSizeDegrees = Number(value.gridSizeDegrees);
  if (!Number.isFinite(gridSizeDegrees) || gridSizeDegrees < 0.001 || gridSizeDegrees > 0.1) throw new Error("江苏 OSM 网格分辨率无效");
  return {
    supported: true,
    provider: "OpenStreetMap · 江苏本地日更索引",
    sourceTimestamp,
    generatedAt,
    sourceUrl: safeHttpUrl(value.sourceUrl),
    gridSizeDegrees,
    aggregationMethod: "feature_bbox_centroid_grid",
    coverageMode: value.coverageMode === "jiangsu_intersection" ? "jiangsu_intersection" : "full",
    mappedBuildingCount,
    mappedRoadWayCount,
    mappedKeyFacilityCount,
    facilityCounts,
    facilities,
    facilitiesTruncated: value.facilitiesTruncated === true || mappedKeyFacilityCount > facilities.length,
  };
}

export function localOsmScopeMetadata(scope: OsmExposureScope) {
  return {
    coverage: scope.coverage,
    scopeLabel: scope.label,
    scopeAreaKm2: scope.aoi.areaKm2,
    sourceAoiAreaKm2: scope.sourceAoiAreaKm2,
  } as const;
}

const facilityKinds = ["health", "emergency", "shelter", "education", "power", "water"] as const;

function validFacility(raw: unknown): ExposureFacility {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("江苏 OSM 设施结构无效");
  const value = raw as Record<string, unknown>;
  const kind = safeText(value.kind, 20) as ExposureFacilityKind;
  const osmType = safeText(value.osmType, 20) as ExposureFacility["osmType"];
  const osmId = Number(value.osmId);
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!facilityKinds.includes(kind) || !["node", "way", "relation"].includes(osmType)) throw new Error("江苏 OSM 设施分类无效");
  if (!Number.isSafeInteger(osmId) || osmId <= 0 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("江苏 OSM 设施坐标或ID无效");
  return {
    id: safeText(value.id, 180) || `${osmType}:${osmId}`,
    kind,
    name: safeText(value.name, 160) || "未命名设施",
    latitude,
    longitude,
    osmType,
    osmId,
  };
}

function geometryBbox(geometry: EventGeometry): [number, number, number, number] {
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates as number[][][]]
    : geometry.type === "MultiPolygon" ? geometry.coordinates as number[][][][] : [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) {
    west = Math.min(west, point[0]); south = Math.min(south, point[1]); east = Math.max(east, point[0]); north = Math.max(north, point[1]);
  }
  return [west, south, east, north];
}

function validTimestamp(value: unknown) {
  const text = safeText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

function safeCount(value: unknown, label: string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 50_000_000) throw new Error(`江苏 OSM ${label}计数无效`);
  return count;
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().replace(/[\r\n\0]+/g, " ").slice(0, maximum) : "";
}

function safeHttpUrl(value: unknown) {
  const text = safeText(value, 500);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
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
