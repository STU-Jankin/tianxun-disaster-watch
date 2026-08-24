import { normalizeCustomAoiGeoJson, type CustomAoiGeometry } from "./task-aoi.ts";
import type { AmapTravelMode, RoutingCoordinate } from "./amap-routing.ts";

export type RoadDisruptionKind = "road_destroyed" | "bridge_failure" | "flooded" | "landslide" | "closure" | "restricted";
export type RoadDisruptionImpact = "blocked" | "restricted";
export type RoadDisruptionVerification = "verified" | "reported";
export type RoadDisruptionLifecycle = "active" | "resolved" | "rejected";
export type RoadDisruptionGeometry =
  | { type: "Point"; coordinates: RoutingCoordinate }
  | { type: "LineString"; coordinates: RoutingCoordinate[] }
  | CustomAoiGeometry;

export type RoadDisruption = {
  disruptionId: string;
  label: string;
  kind: RoadDisruptionKind;
  impact: RoadDisruptionImpact;
  verification: RoadDisruptionVerification;
  affectedModes: AmapTravelMode[];
  geometry: RoadDisruptionGeometry;
  radiusMeters: number;
  validFrom?: string;
  validTo?: string;
  validityBasis?: "reported" | "default_24h";
  source?: string;
  importedAt: string;
  lifecycleStatus?: RoadDisruptionLifecycle;
  revision?: number;
  reportedAt?: string;
  updatedAt?: string;
  reportedBy?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type RoadDisruptionRegistryEntry = RoadDisruption & {
  lifecycleStatus: RoadDisruptionLifecycle;
  revision: number;
  reportedAt: string;
  updatedAt: string;
  reportedBy: string;
};

export type RoadDisruptionConflict = Pick<RoadDisruption,
  "disruptionId" | "label" | "kind" | "impact" | "verification" | "validFrom" | "validTo" | "source"
>;

const modes: AmapTravelMode[] = ["driving", "walking", "bicycling", "electrobike"];
const kinds: RoadDisruptionKind[] = ["road_destroyed", "bridge_failure", "flooded", "landslide", "closure", "restricted"];
const kindLabels: Record<RoadDisruptionKind, string> = {
  road_destroyed: "道路毁损",
  bridge_failure: "桥梁故障/垮塌",
  flooded: "道路积水/淹没",
  landslide: "滑坡阻断",
  closure: "道路封闭",
  restricted: "限制通行",
};

export function normalizeRoadDisruptionGeoJson(input: unknown, importedAt = new Date().toISOString()): RoadDisruption[] {
  const features = geoJsonFeatures(input);
  if (!features.length) throw new Error("GeoJSON 没有可用的道路中断要素");
  if (features.length > 50) throw new Error("单次最多导入 50 条道路中断要素");
  let coordinateCount = 0;
  const disruptions = features.map((feature, index) => {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const geometry = normalizeGeometry(feature.geometry);
    coordinateCount += countCoordinates(geometry);
    if (coordinateCount > 5_000) throw new Error("道路中断 GeoJSON 坐标总数超过 5000");
    const kind = normalizeKind(properties.kind ?? properties.type ?? properties.disruptionType);
    const impact = normalizeImpact(properties.impact ?? properties.status, kind);
    const verification = normalizeVerification(properties.verification ?? properties.verified);
    const validFrom = optionalIso(properties.validFrom ?? properties.start ?? properties.startTime, "validFrom");
    const validTo = optionalIso(properties.validTo ?? properties.end ?? properties.endTime, "validTo");
    if (validFrom && validTo && Date.parse(validFrom) >= Date.parse(validTo)) throw new Error(`第 ${index + 1} 条道路中断的有效期先后顺序无效`);
    const label = text(properties.label ?? properties.name ?? properties.title, 120) || `${kindLabels[kind]} ${index + 1}`;
    const suppliedId = text(feature.id ?? properties.id ?? properties.disruptionId, 100).replace(/[^\p{L}\p{N}._-]+/gu, "-");
    return {
      disruptionId: suppliedId || `road-disruption-${index + 1}`,
      label,
      kind,
      impact,
      verification,
      affectedModes: normalizeModes(properties.affectedModes ?? properties.modes),
      geometry,
      radiusMeters: clampNumber(properties.radiusMeters ?? properties.radius_m, geometry.type === "Point" ? 100 : geometry.type === "LineString" ? 40 : 0, geometry.type === "Point" || geometry.type === "LineString" ? 20 : 0, 5_000),
      validFrom,
      validTo,
      source: text(properties.source ?? properties.sourceUrl, 300) || undefined,
      importedAt,
    } satisfies RoadDisruption;
  });
  if (new Set(disruptions.map((item) => item.disruptionId)).size !== disruptions.length) throw new Error("道路中断 ID 重复");
  return disruptions;
}

export function activeRoadDisruptionConflicts(route: RoutingCoordinate[], disruptions: RoadDisruption[], mode: AmapTravelMode, departureAt: string, estimatedMinutes: number): RoadDisruptionConflict[] {
  const departure = Date.parse(departureAt);
  const arrival = departure + estimatedMinutes * 60_000;
  if (!Number.isFinite(departure) || !Number.isFinite(arrival)) return [];
  return disruptions.filter((disruption) => (disruption.lifecycleStatus ?? "active") === "active"
    && disruption.affectedModes.includes(mode)
    && disruptionActive(disruption, departure, arrival)
    && routeIntersectsGeometry(route, disruption.geometry, disruption.radiusMeters / 1_000))
    .map(({ disruptionId, label, kind, impact, verification, validFrom, validTo, source }) => ({ disruptionId, label, kind, impact, verification, validFrom, validTo, source }));
}

export function roadDisruptionFeatureCollection(disruptions: RoadDisruption[]) {
  return {
    type: "FeatureCollection" as const,
    features: disruptions.map((disruption) => ({
      type: "Feature" as const,
      id: disruption.disruptionId,
      properties: {
        disruptionId: disruption.disruptionId,
        label: disruption.label,
        kind: disruption.kind,
        impact: disruption.impact,
        verification: disruption.verification,
        affectedModes: disruption.affectedModes,
        radiusMeters: disruption.radiusMeters,
        validFrom: disruption.validFrom,
        validTo: disruption.validTo,
        validityBasis: disruption.validityBasis,
        source: disruption.source,
      },
      geometry: disruption.geometry,
    })),
  };
}

export function isRoadDisruptionList(value: unknown, maximum = 50): value is RoadDisruption[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  try {
    for (const item of value) {
      if (!isRecord(item)) return false;
      if (item.lifecycleStatus !== undefined && !["active", "resolved", "rejected"].includes(String(item.lifecycleStatus))) return false;
      if (item.revision !== undefined && (!Number.isInteger(Number(item.revision)) || Number(item.revision) < 1)) return false;
      for (const key of ["reportedAt", "updatedAt", "verifiedAt", "resolvedAt"]) {
        if (item[key] !== undefined && !Number.isFinite(Date.parse(String(item[key])))) return false;
      }
      for (const key of ["reportedBy", "verifiedBy", "resolvedBy"]) if (item[key] !== undefined && typeof item[key] !== "string") return false;
    }
    const normalized = normalizeRoadDisruptionGeoJson({
      type: "FeatureCollection",
      features: value.map((item) => isRecord(item) ? {
        type: "Feature",
        id: item.disruptionId,
        properties: {
          label: item.label,
          kind: item.kind,
          impact: item.impact,
          verification: item.verification,
          affectedModes: item.affectedModes,
          radiusMeters: item.radiusMeters,
          validFrom: item.validFrom,
          validTo: item.validTo,
          source: item.source,
        },
        geometry: item.geometry,
      } : item),
    }, "2000-01-01T00:00:00.000Z");
    return normalized.length === value.length;
  } catch {
    return false;
  }
}

export function roadDisruptionKindLabel(kind: RoadDisruptionKind) {
  return kindLabels[kind];
}

function geoJsonFeatures(input: unknown) {
  if (!isRecord(input)) throw new Error("道路中断文件必须是 GeoJSON 对象");
  if (input.type === "FeatureCollection") {
    if (!Array.isArray(input.features)) throw new Error("FeatureCollection 缺少 features");
    return input.features.map((feature) => asFeature(feature));
  }
  if (input.type === "Feature") return [asFeature(input)];
  if (["Point", "LineString", "Polygon", "MultiPolygon"].includes(String(input.type))) return [{ type: "Feature", properties: {}, geometry: input }];
  throw new Error("仅支持 Point、LineString、Polygon 或 MultiPolygon 道路中断要素");
}

function asFeature(value: unknown) {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.geometry)) throw new Error("道路中断 Feature 结构无效");
  return value;
}

function normalizeGeometry(value: unknown): RoadDisruptionGeometry {
  if (!isRecord(value)) throw new Error("道路中断 geometry 无效");
  if (value.type === "Point") return { type: "Point", coordinates: coordinate(value.coordinates, "道路中断点") };
  if (value.type === "LineString") {
    if (!Array.isArray(value.coordinates) || value.coordinates.length < 2 || value.coordinates.length > 5_000) throw new Error("道路中断线至少需要 2 个点且不能超过 5000 点");
    return { type: "LineString", coordinates: value.coordinates.map((item) => coordinate(item, "道路中断线")) };
  }
  if (value.type === "Polygon" || value.type === "MultiPolygon") {
    const normalized = normalizeCustomAoiGeoJson(value);
    if (!normalized) throw new Error("道路中断面几何无效、自相交或范围过大");
    return normalized;
  }
  throw new Error("道路中断 geometry 类型不受支持");
}

function normalizeKind(value: unknown): RoadDisruptionKind {
  const normalized = String(value ?? "closure").trim().toLowerCase();
  if (kinds.includes(normalized as RoadDisruptionKind)) return normalized as RoadDisruptionKind;
  if (/毁|destroy|washout/.test(normalized)) return "road_destroyed";
  if (/桥|bridge|collapse/.test(normalized)) return "bridge_failure";
  if (/水|flood|inundat/.test(normalized)) return "flooded";
  if (/滑坡|landslide|debris/.test(normalized)) return "landslide";
  if (/限|restrict/.test(normalized)) return "restricted";
  return "closure";
}

function normalizeImpact(value: unknown, kind: RoadDisruptionKind): RoadDisruptionImpact {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/restrict|partial|limited|限/.test(normalized) || kind === "restricted") return "restricted";
  return "blocked";
}

function normalizeVerification(value: unknown): RoadDisruptionVerification {
  return value === true || /^(verified|official|confirmed|已核验|官方)$/i.test(String(value ?? "").trim()) ? "verified" : "reported";
}

function normalizeModes(value: unknown): AmapTravelMode[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;|\s]+/) : [];
  if (!values.length || values.some((item) => String(item).toLowerCase() === "all")) return [...modes];
  const normalized = values.map((item) => String(item).trim().toLowerCase()).filter((item): item is AmapTravelMode => modes.includes(item as AmapTravelMode));
  if (!normalized.length) throw new Error("道路中断 affectedModes 不包含受支持的出行方式");
  return [...new Set(normalized)];
}

function optionalIso(value: unknown, label: string) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`道路中断 ${label} 时间无效`);
  return new Date(parsed).toISOString();
}

function disruptionActive(disruption: RoadDisruption, departure: number, arrival: number) {
  const start = disruption.validFrom ? Date.parse(disruption.validFrom) : Number.NEGATIVE_INFINITY;
  const end = disruption.validTo ? Date.parse(disruption.validTo) : Number.POSITIVE_INFINITY;
  return start < arrival && end > departure;
}

function routeIntersectsGeometry(route: RoutingCoordinate[], geometry: RoadDisruptionGeometry, radiusKm: number) {
  if (geometry.type === "Point") return route.some((point, index) => index > 0 && pointSegmentDistanceKm(geometry.coordinates, route[index - 1], point) <= radiusKm);
  if (geometry.type === "LineString") {
    for (let routeIndex = 1; routeIndex < route.length; routeIndex += 1) {
      for (let lineIndex = 1; lineIndex < geometry.coordinates.length; lineIndex += 1) {
        const routeStart = route[routeIndex - 1];
        const routeEnd = route[routeIndex];
        const lineStart = geometry.coordinates[lineIndex - 1];
        const lineEnd = geometry.coordinates[lineIndex];
        if (segmentsIntersect(routeStart, routeEnd, lineStart, lineEnd)
          || pointSegmentDistanceKm(lineStart, routeStart, routeEnd) <= radiusKm
          || pointSegmentDistanceKm(lineEnd, routeStart, routeEnd) <= radiusKm
          || pointSegmentDistanceKm(routeStart, lineStart, lineEnd) <= radiusKm
          || pointSegmentDistanceKm(routeEnd, lineStart, lineEnd) <= radiusKm) return true;
      }
    }
    return false;
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => route.some((point) => pointInPolygon(point, polygon))
    || polygon.some((ring) => route.some((routeEnd, routeIndex) => routeIndex > 0 && ring.some((ringEnd, ringIndex) => ringIndex > 0 && segmentsIntersect(route[routeIndex - 1], routeEnd, ring[ringIndex - 1] as RoutingCoordinate, ringEnd as RoutingCoordinate)))));
}

function pointInPolygon(point: RoutingCoordinate, polygon: RoutingCoordinate[][]) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((ring) => pointInRing(point, ring));
}

function pointInRing(point: RoutingCoordinate, ring: RoutingCoordinate[]) {
  let inside = false;
  for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
    const left = ring[index];
    const right = ring[prior];
    if (!validCoordinate(left) || !validCoordinate(right)) continue;
    if ((left[1] > point[1]) !== (right[1] > point[1]) && point[0] < (right[0] - left[0]) * (point[1] - left[1]) / ((right[1] - left[1]) || Number.EPSILON) + left[0]) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: RoutingCoordinate, b: RoutingCoordinate, c: RoutingCoordinate, d: RoutingCoordinate) {
  const cross = (p: RoutingCoordinate, q: RoutingCoordinate, r: RoutingCoordinate) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
}

function pointSegmentDistanceKm(point: RoutingCoordinate, start: RoutingCoordinate, end: RoutingCoordinate) {
  const referenceLatitude = (point[1] + start[1] + end[1]) / 3 * Math.PI / 180;
  const scaleLongitude = 111.32 * Math.max(0.08, Math.cos(referenceLatitude));
  const project = ([longitude, latitude]: RoutingCoordinate): [number, number] => [longitude * scaleLongitude, latitude * 110.57];
  const [px, py] = project(point);
  const [ax, ay] = project(start);
  const [bx, by] = project(end);
  const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared));
  return Math.hypot(px - (ax + ratio * (bx - ax)), py - (ay + ratio * (by - ay)));
}

function coordinate(value: unknown, label: string): RoutingCoordinate {
  if (!validCoordinate(value)) throw new Error(`${label}坐标无效`);
  return [Number(value[0]), Number(value[1])];
}

function validCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number(value[0]) >= -180 && Number(value[0]) <= 180 && Number.isFinite(Number(value[1])) && Number(value[1]) >= -90 && Number(value[1]) <= 90;
}

function countCoordinates(geometry: RoadDisruptionGeometry): number {
  if (geometry.type === "Point") return 1;
  if (geometry.type === "LineString") return geometry.coordinates.length;
  if (geometry.type === "Polygon") return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
  return geometry.coordinates.reduce((sum, polygon) => sum + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0), 0);
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
