import { publicOverpassMaximumAreaKm2, type OverpassCacheStatus, type OverpassProfile } from "./overpass-runtime.ts";

export type InfrastructureKind = "bridge" | "tunnel" | "ford";
export type InfrastructureGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] };

export type InfrastructureFeature = {
  infrastructureId: string;
  osmType: "node" | "way";
  osmId: number;
  kind: InfrastructureKind;
  label: string;
  geometry: InfrastructureGeometry;
  highway?: string;
  ref?: string;
  bridgeTag?: string;
  tunnelTag?: string;
  maxweight?: string;
  lanes?: string;
  layer?: string;
  sourceUrl: string;
  attribution: "© OpenStreetMap contributors · ODbL";
};

export type InfrastructureRouteInput = {
  routeId: string;
  coordinates: [number, number][];
  mode?: "driving" | "walking" | "bicycling" | "electrobike";
};

export type InfrastructureCrossing = InfrastructureFeature & {
  distanceToRouteMeters: number;
};

export type InfrastructureAssessment = {
  state: "ready";
  provider: "OpenStreetMap · Overpass";
  fetchedAt: string;
  queryBbox: [number, number, number, number];
  queryAreaKm2: number;
  osmBaseTimestamp?: string;
  cacheStatus?: OverpassCacheStatus;
  dataProfile?: OverpassProfile;
  updateCadence?: "upstream" | "daily";
  features: InfrastructureFeature[];
  crossingsByRoute: Record<string, InfrastructureCrossing[]>;
  attribution: "© OpenStreetMap contributors · ODbL";
  sourceUrl: "https://www.openstreetmap.org/copyright";
  note: string;
} | {
  state: "too_large" | "unsupported" | "unavailable";
  provider: "OpenStreetMap · Overpass";
  message: string;
  queryBbox?: [number, number, number, number];
  queryAreaKm2?: number;
};

export type InfrastructureQueryPlan = {
  state: "ready";
  query: string;
  cacheKey: string;
  bbox: [number, number, number, number];
  areaKm2: number;
  routes: InfrastructureRouteInput[];
} | {
  state: "too_large" | "unsupported";
  provider: "OpenStreetMap · Overpass";
  message: string;
  queryBbox?: [number, number, number, number];
  queryAreaKm2?: number;
};

const attribution = "© OpenStreetMap contributors · ODbL" as const;
const osmCopyrightUrl = "https://www.openstreetmap.org/copyright" as const;
const maximumBboxAreaKm2 = publicOverpassMaximumAreaKm2;
const crossingToleranceKm = 0.06;

export function prepareInfrastructureQuery(input: unknown, options: { maximumAreaKm2?: number; serviceLabel?: string; queryTimeoutSeconds?: number } = {}): InfrastructureQueryPlan {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error("基础设施查询必须包含 1–3 条路线");
  const routeIds = new Set<string>();
  const routes = input.map((item, routeIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${routeIndex + 1} 条路线无效`);
    const record = item as Record<string, unknown>;
    const routeId = safeText(record.routeId, 80);
    if (!routeId || routeIds.has(routeId)) throw new Error("路线 ID 缺失或重复");
    routeIds.add(routeId);
    const mode = ["driving", "walking", "bicycling", "electrobike"].includes(String(record.mode)) ? record.mode as InfrastructureRouteInput["mode"] : undefined;
    if (!Array.isArray(record.coordinates) || record.coordinates.length < 2 || record.coordinates.length > 2_000) throw new Error(`路线 ${routeId} 的坐标点数无效`);
    const coordinates = record.coordinates.map((coordinate, coordinateIndex) => validCoordinate(coordinate, `路线 ${routeId} 第 ${coordinateIndex + 1} 点`));
    return { routeId, coordinates, mode };
  });
  const allCoordinates = routes.flatMap((route) => route.coordinates);
  const longitudes = allCoordinates.map((coordinate) => coordinate[0]);
  if (Math.max(...longitudes) - Math.min(...longitudes) > 180) {
    return { state: "unsupported", provider: "OpenStreetMap · Overpass", message: "跨越国际日期变更线的路线暂不使用公共 Overpass 包围盒查询" };
  }
  const latitudes = allCoordinates.map((coordinate) => coordinate[1]);
  const meanLatitude = latitudes.reduce((sum, latitude) => sum + latitude, 0) / latitudes.length;
  const latitudePadding = 1 / 110.57;
  const longitudePadding = 1 / (111.32 * Math.max(0.15, Math.cos(meanLatitude * Math.PI / 180)));
  const south = Math.max(-90, Math.min(...latitudes) - latitudePadding);
  const west = Math.max(-180, Math.min(...longitudes) - longitudePadding);
  const north = Math.min(90, Math.max(...latitudes) + latitudePadding);
  const east = Math.min(180, Math.max(...longitudes) + longitudePadding);
  const bbox: [number, number, number, number] = [round(south, 6), round(west, 6), round(north, 6), round(east, 6)];
  const heightKm = Math.max(0, (north - south) * 110.57);
  const widthKm = Math.max(0, (east - west) * 111.32 * Math.max(0.15, Math.cos(meanLatitude * Math.PI / 180)));
  const areaKm2 = round(heightKm * widthKm, 1);
  const maximumAreaKm2 = Math.max(1, options.maximumAreaKm2 ?? maximumBboxAreaKm2);
  const maximumSpanKm = Math.max(120, Math.min(450, Math.sqrt(maximumAreaKm2) * 1.4));
  const serviceLabel = safeText(options.serviceLabel, 80) || "公共 Overpass";
  if (areaKm2 > maximumAreaKm2 || heightKm > maximumSpanKm || widthKm > maximumSpanKm) {
    return {
      state: "too_large",
      provider: "OpenStreetMap · Overpass",
      message: `路线包围盒约 ${areaKm2.toFixed(1)} km²，超过${serviceLabel}单次 ${Math.round(maximumAreaKm2).toLocaleString()} km² 的保守查询范围；路线仍可推演，但基础设施覆盖标记为未知`,
      queryBbox: bbox,
      queryAreaKm2: areaKm2,
    };
  }
  const box = bbox.map((value) => value.toFixed(6)).join(",");
  const timeoutSeconds = Math.max(10, Math.min(120, Math.round(options.queryTimeoutSeconds ?? 12)));
  const query = `[out:json][timeout:${timeoutSeconds}];\n(\n  way["highway"]["bridge"]["bridge"!="no"](${box});\n  way["highway"]["tunnel"]["tunnel"!="no"](${box});\n  way["highway"]["ford"](${box});\n  way["ford"](${box});\n  node["highway"="ford"](${box});\n  node["ford"](${box});\n);\nout tags geom qt 500;`;
  return { state: "ready", query, cacheKey: bbox.map((value) => value.toFixed(4)).join(":"), bbox, areaKm2, routes };
}

export function parseOverpassBaseTimestamp(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const osm3s = (payload as { osm3s?: unknown }).osm3s;
  if (!osm3s || typeof osm3s !== "object" || Array.isArray(osm3s)) return undefined;
  const value = (osm3s as { timestamp_osm_base?: unknown }).timestamp_osm_base;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function parseOverpassInfrastructure(payload: unknown): InfrastructureFeature[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Overpass 返回不是有效 JSON 对象");
  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) throw new Error("Overpass 返回缺少 elements");
  if (elements.length > 2_000) throw new Error("Overpass 返回要素超过安全上限");
  const result = new Map<string, InfrastructureFeature>();
  let coordinateCount = 0;
  for (const raw of elements) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const element = raw as Record<string, unknown>;
    const osmType = element.type === "node" || element.type === "way" ? element.type : null;
    const osmId = Number(element.id);
    if (!osmType || !Number.isSafeInteger(osmId) || osmId <= 0) continue;
    const tags = safeTags(element.tags);
    const kind = infrastructureKind(tags);
    if (!kind) continue;
    let geometry: InfrastructureGeometry | null = null;
    if (osmType === "node") {
      const coordinate = finiteCoordinate(Number(element.lon), Number(element.lat));
      if (coordinate) geometry = { type: "Point", coordinates: coordinate };
    } else if (Array.isArray(element.geometry)) {
      const coordinates = element.geometry.slice(0, 600).flatMap((point) => {
        if (!point || typeof point !== "object" || Array.isArray(point)) return [];
        const record = point as Record<string, unknown>;
        const coordinate = finiteCoordinate(Number(record.lon), Number(record.lat));
        return coordinate ? [coordinate] : [];
      });
      if (coordinates.length >= 2) geometry = { type: "LineString", coordinates };
    }
    if (!geometry) continue;
    coordinateCount += geometry.type === "Point" ? 1 : geometry.coordinates.length;
    if (coordinateCount > 15_000) throw new Error("Overpass 返回坐标超过安全上限");
    const infrastructureId = `osm-${osmType}-${osmId}`;
    result.set(infrastructureId, {
      infrastructureId,
      osmType,
      osmId,
      kind,
      label: featureLabel(kind, tags),
      geometry,
      highway: tags.highway,
      ref: tags.ref,
      bridgeTag: tags.bridge,
      tunnelTag: tags.tunnel,
      maxweight: tags.maxweight,
      lanes: tags.lanes,
      layer: tags.layer,
      sourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
      attribution,
    });
    if (result.size >= 500) break;
  }
  return [...result.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.osmId - right.osmId);
}

export function assessInfrastructureRoutes(
  plan: Extract<InfrastructureQueryPlan, { state: "ready" }>,
  features: InfrastructureFeature[],
  fetchedAt = new Date().toISOString(),
  metadata: { osmBaseTimestamp?: string; cacheStatus?: OverpassCacheStatus; dataProfile?: OverpassProfile; updateCadence?: "upstream" | "daily" } = {},
): Extract<InfrastructureAssessment, { state: "ready" }> {
  const crossingsByRoute: Record<string, InfrastructureCrossing[]> = {};
  for (const route of plan.routes) {
    crossingsByRoute[route.routeId] = features.filter((feature) => routeModeCompatible(route, feature)).flatMap((feature) => {
      const distanceKm = distanceToRouteKm(feature.geometry, route.coordinates, crossingToleranceKm);
      return distanceKm <= crossingToleranceKm ? [{ ...feature, distanceToRouteMeters: Math.max(0, Math.round(distanceKm * 1_000)) }] : [];
    }).sort((left, right) => left.distanceToRouteMeters - right.distanceToRouteMeters || left.osmId - right.osmId);
  }
  return {
    state: "ready",
    provider: "OpenStreetMap · Overpass",
    fetchedAt,
    queryBbox: plan.bbox,
    queryAreaKm2: plan.areaKm2,
    ...metadata,
    features,
    crossingsByRoute,
    attribution,
    sourceUrl: osmCopyrightUrl,
    note: "OSM/Overpass 仅用于识别社区地图中已标注的桥梁、隧道和涉水点。存在标注不代表设施当前完好；未检出标注也不代表不存在设施，任何穿越都必须结合桥梁监测、交通管制或现场核验。",
  };
}

export function infrastructureKindLabel(kind: InfrastructureKind) {
  if (kind === "tunnel") return "隧道";
  if (kind === "ford") return "涉水点";
  return "桥梁";
}

export function isInfrastructureAssessment(value: unknown): value is InfrastructureAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.provider !== "OpenStreetMap · Overpass" || !["ready", "too_large", "unsupported", "unavailable"].includes(String(record.state))) return false;
  if (record.state !== "ready") return typeof record.message === "string";
  return typeof record.fetchedAt === "string"
    && Array.isArray(record.queryBbox)
    && Number.isFinite(Number(record.queryAreaKm2))
    && Array.isArray(record.features)
    && Boolean(record.crossingsByRoute && typeof record.crossingsByRoute === "object" && !Array.isArray(record.crossingsByRoute));
}

function infrastructureKind(tags: Record<string, string>): InfrastructureKind | null {
  if (presentTag(tags.ford) || tags.highway === "ford") return "ford";
  if (presentTag(tags.tunnel)) return "tunnel";
  if (presentTag(tags.bridge) || tags.man_made === "bridge") return "bridge";
  return null;
}

function presentTag(value: string | undefined) {
  return Boolean(value && !["no", "false", "0"].includes(value.toLowerCase()));
}

function featureLabel(kind: InfrastructureKind, tags: Record<string, string>) {
  const name = tags["name:zh"] || tags.name || tags.ref;
  return name ? `${infrastructureKindLabel(kind)} · ${name}` : `${infrastructureKindLabel(kind)} · OSM ${tags.highway || tags.man_made || "设施"}`;
}

function safeTags(value: unknown) {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") continue;
    const text = safeText(item, 120);
    if (text) result[key.slice(0, 60)] = text;
  }
  return result;
}

function safeText(value: unknown, maximumLength: number) {
  return typeof value === "string" ? value.trim().replace(/[\r\n\t]+/g, " ").slice(0, maximumLength) : "";
}

function validCoordinate(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}坐标无效`);
  const coordinate = finiteCoordinate(Number(value[0]), Number(value[1]));
  if (!coordinate) throw new Error(`${label}坐标无效`);
  return coordinate;
}

function finiteCoordinate(longitude: number, latitude: number): [number, number] | null {
  return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
}

function distanceToRouteKm(geometry: InfrastructureGeometry, route: [number, number][], stopAtKm: number) {
  if (geometry.type === "Point") return pointToPolylineKm(geometry.coordinates, route, stopAtKm);
  let minimum = Number.POSITIVE_INFINITY;
  for (let featureIndex = 1; featureIndex < geometry.coordinates.length; featureIndex += 1) {
    const featureStart = geometry.coordinates[featureIndex - 1];
    const featureEnd = geometry.coordinates[featureIndex];
    for (let routeIndex = 1; routeIndex < route.length; routeIndex += 1) {
      const distance = segmentDistanceKm(featureStart, featureEnd, route[routeIndex - 1], route[routeIndex]);
      if (distance <= stopAtKm && !segmentsAligned(featureStart, featureEnd, route[routeIndex - 1], route[routeIndex])) continue;
      if (distance < minimum) minimum = distance;
      if (minimum <= stopAtKm) return minimum;
    }
  }
  return minimum;
}

function pointToPolylineKm(point: [number, number], route: [number, number][], stopAtKm: number) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < route.length; index += 1) {
    const distance = pointSegmentDistanceKm(point, route[index - 1], route[index]);
    if (distance < minimum) minimum = distance;
    if (minimum <= stopAtKm) return minimum;
  }
  return minimum;
}

function segmentDistanceKm(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const latitude = (a[1] + b[1] + c[1] + d[1]) / 4;
  const projected = [a, b, c, d].map((coordinate) => project(coordinate, latitude));
  if (segmentsIntersect(projected[0], projected[1], projected[2], projected[3])) return 0;
  return Math.min(
    pointSegmentDistance(projected[0], projected[2], projected[3]),
    pointSegmentDistance(projected[1], projected[2], projected[3]),
    pointSegmentDistance(projected[2], projected[0], projected[1]),
    pointSegmentDistance(projected[3], projected[0], projected[1]),
  );
}

function pointSegmentDistanceKm(point: [number, number], start: [number, number], end: [number, number]) {
  const latitude = (point[1] + start[1] + end[1]) / 3;
  return pointSegmentDistance(project(point, latitude), project(start, latitude), project(end, latitude));
}

function project(coordinate: [number, number], latitude: number): [number, number] {
  return [coordinate[0] * 111.32 * Math.max(0.15, Math.cos(latitude * Math.PI / 180)), coordinate[1] * 110.57];
}

function pointSegmentDistance(point: [number, number], start: [number, number], end: [number, number]) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dy));
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  const epsilon = 1e-9;
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
  const onSegment = (p: [number, number], q: [number, number], r: [number, number]) => q[0] >= Math.min(p[0], r[0]) - epsilon && q[0] <= Math.max(p[0], r[0]) + epsilon && q[1] >= Math.min(p[1], r[1]) - epsilon && q[1] <= Math.max(p[1], r[1]) + epsilon;
  return (Math.abs(abC) <= epsilon && onSegment(a, c, b))
    || (Math.abs(abD) <= epsilon && onSegment(a, d, b))
    || (Math.abs(cdA) <= epsilon && onSegment(c, a, d))
    || (Math.abs(cdB) <= epsilon && onSegment(c, b, d));
}

function segmentsAligned(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const latitude = (a[1] + b[1] + c[1] + d[1]) / 4;
  const [pa, pb, pc, pd] = [a, b, c, d].map((coordinate) => project(coordinate, latitude));
  const first = [pb[0] - pa[0], pb[1] - pa[1]];
  const second = [pd[0] - pc[0], pd[1] - pc[1]];
  const firstLength = Math.hypot(first[0], first[1]);
  const secondLength = Math.hypot(second[0], second[1]);
  if (firstLength < 0.005 || secondLength < 0.005) return true;
  return Math.abs((first[0] * second[0] + first[1] * second[1]) / (firstLength * secondLength)) >= Math.cos(Math.PI / 4);
}

function routeModeCompatible(route: InfrastructureRouteInput, feature: InfrastructureFeature) {
  if (route.mode !== "driving") return true;
  return !["footway", "pedestrian", "path", "cycleway", "steps", "bridleway"].includes(feature.highway ?? "");
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
