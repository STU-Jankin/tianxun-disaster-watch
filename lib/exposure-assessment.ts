import type { DisasterEvent, EventGeometry, HazardType } from "./disasters.ts";
import { aoiFingerprint, eventRevisionFingerprint } from "./event-integrity.ts";
import { normalizeAntimeridianGeometry, validateGeoGeometry } from "./geo-geometry.ts";
import type { OverpassCacheStatus, OverpassProfile } from "./overpass-runtime.ts";
import polygonClipping, { type MultiPolygon as ClippingMultiPolygon, type Polygon as ClippingPolygon } from "polygon-clipping";

export const exposureAssessmentModelVersion = "tianxun-exposure-screening-v2" as const;
export const maximumWorldPopAreaKm2 = 50_000;
export const maximumOverpassAreaKm2 = 2_500;

export type ExposureFacilityKind = "health" | "emergency" | "shelter" | "education" | "power" | "water";

export type ExposureFacility = {
  id: string;
  kind: ExposureFacilityKind;
  name: string;
  latitude: number;
  longitude: number;
  osmType: "node" | "way" | "relation";
  osmId: number;
};

export type ExposureAoi = {
  geometry: EventGeometry;
  areaKm2: number;
  bbox: [number, number, number, number];
  basis: "official_event_geometry" | "official_cyclone_impact" | "derived_screening_buffer";
  label: string;
  crossesAntimeridian: boolean;
};

export type PopulationExposure = {
  state: "ready" | "pending" | "skipped" | "unavailable";
  provider: "WorldPop";
  year: number;
  resolution: "100m" | "1km";
  taskId?: string;
  totalPopulation?: number;
  populationDensityPerKm2?: number;
  dataSource?: string;
  processingTimeMs?: number;
  completedParts?: number;
  totalParts?: number;
  parts?: PopulationExposurePart[];
  message: string;
};

export type PopulationExposurePart = {
  chunkId: string;
  areaKm2: number;
  state: "ready" | "pending" | "unavailable";
  taskId?: string;
  totalPopulation?: number;
  populationDensityPerKm2?: number;
  dataSource?: string;
  processingTimeMs?: number;
  message: string;
};

export type WorldPopRequestChunk = {
  chunkId: string;
  areaKm2: number;
  payload: { geojson: EventGeometry; year: number; resolution: "100m" | "1km" };
};

export type OsmExposure = {
  state: "ready" | "skipped" | "unavailable";
  provider: "OpenStreetMap · Overpass";
  mappedBuildingCount?: number;
  mappedRoadWayCount?: number;
  mappedKeyFacilityCount?: number;
  facilityCounts: Partial<Record<ExposureFacilityKind, number>>;
  facilities: ExposureFacility[];
  facilitiesTruncated: boolean;
  osmBaseTimestamp?: string;
  fetchedAt?: string;
  cacheStatus?: OverpassCacheStatus;
  dataProfile?: OverpassProfile;
  updateCadence?: "upstream" | "daily";
  message: string;
};

export type ExposureAssessment = {
  masterEventId: string;
  eventRevision: string;
  aoiHash: string;
  status: "complete" | "partial" | "pending" | "unavailable";
  aoi: ExposureAoi;
  population: PopulationExposure;
  osm: OsmExposure;
  riskInput: { index: number; basis: string } | null;
  computedAt: string;
  expiresAt: string;
  updatedBy: string;
  limitations: string[];
  modelVersion: typeof exposureAssessmentModelVersion;
};

export type OverpassExposureResult = Omit<OsmExposure, "state" | "provider" | "message" | "fetchedAt">;

const derivedRadiusKm: Record<HazardType, number> = {
  earthquake: 30,
  tsunami: 50,
  wildfire: 10,
  flood: 25,
  cyclone: 100,
  volcano: 20,
  landslide: 10,
  drought: 100,
  dust: 100,
  ice: 50,
};

export function buildExposureAoi(event: DisasterEvent): ExposureAoi {
  const preferred = event.cycloneForecast?.impactGeometry ?? event.geometry;
  const polygonal = preferred.type === "Polygon" || preferred.type === "MultiPolygon" ? normalizeAntimeridianGeometry(preferred) : null;
  if (polygonal) {
    const validation = validateGeoGeometry(polygonal, { maximumAreaKm2: 25_000_000, maximumVertices: 20_000, maximumRingVertices: 5_000, allowOverlappingMultiPolygon: true });
    if (validation.ok) {
      return {
        geometry: polygonal,
        areaKm2: validation.areaKm2,
        bbox: geometryBbox(polygonal),
        basis: event.cycloneForecast?.impactGeometry === preferred ? "official_cyclone_impact" : "official_event_geometry",
        label: event.cycloneForecast?.impactGeometry === preferred ? "官方台风影响范围" : "来源事件范围",
        crossesAntimeridian: validation.crossesAntimeridian,
      };
    }
  }

  const accuracy = Number.isFinite(event.locationAccuracyKm) ? Math.max(0, event.locationAccuracyKm) : 0;
  const radiusKm = Math.min(200, Math.max(derivedRadiusKm[event.hazard], accuracy));
  const geometry = circlePolygon(event.longitude, event.latitude, radiusKm, 48);
  const validation = validateGeoGeometry(geometry, { maximumAreaKm2: 200_000, maximumVertices: 100 });
  if (!validation.ok) throw new Error(validation.reason || "无法建立暴露度筛查范围");
  return {
    geometry,
    areaKm2: validation.areaKm2,
    bbox: geometryBbox(geometry),
    basis: "derived_screening_buffer",
    label: `事件代表点 ${radiusKm} km 筛查缓冲区（非官方影响边界）`,
    crossesAntimeridian: validation.crossesAntimeridian,
  };
}

export function exposureAssessmentIdentity(event: DisasterEvent) {
  const aoi = buildExposureAoi(event);
  return { aoi, eventRevision: eventRevisionFingerprint(event), aoiHash: aoiFingerprint(aoi.geometry) };
}

export function worldPopRequestPlan(aoi: ExposureAoi, requestedYear = new Date().getUTCFullYear(), maximumAreaKm2 = maximumWorldPopAreaKm2) {
  const year = Math.max(2015, Math.min(2030, Math.round(requestedYear)));
  const resolution = aoi.areaKm2 <= 10_000 ? "100m" as const : "1km" as const;
  if (aoi.crossesAntimeridian) return { state: "skipped" as const, year, resolution, message: "范围跨越日期变更线，未向 WorldPop 提交可能改变面积的查询" };
  const safeMaximumAreaKm2 = Math.max(1_000, Math.min(500_000, maximumAreaKm2));
  if (aoi.areaKm2 > safeMaximumAreaKm2) {
    const geometries = partitionExposureGeometry(aoi.geometry, safeMaximumAreaKm2 * 0.9);
    const chunks: WorldPopRequestChunk[] = geometries.map((geometry) => {
      const validation = validateGeoGeometry(geometry, { maximumAreaKm2: safeMaximumAreaKm2, maximumVertices: 20_000, maximumRingVertices: 5_000, allowOverlappingMultiPolygon: true });
      if (!validation.ok) throw new Error(validation.reason || "WorldPop 分块几何无效");
      return {
        chunkId: aoiFingerprint(geometry),
        areaKm2: validation.areaKm2,
        payload: { geojson: geometry, year, resolution: "1km" as const },
      };
    });
    return {
      state: "ready" as const,
      year,
      resolution: "1km" as const,
      chunks,
      message: `范围 ${Math.round(aoi.areaKm2).toLocaleString()} km² 将按 ${chunks.length} 个安全分块计算 WorldPop 人口`,
    };
  }
  return { state: "ready" as const, year, resolution, payload: { geojson: aoi.geometry, year, resolution } };
}

export function prepareOverpassExposureQuery(aoi: ExposureAoi, options: { maximumAreaKm2?: number; serviceLabel?: string; queryTimeoutSeconds?: number } = {}) {
  const maximumAreaKm2 = Math.max(1, options.maximumAreaKm2 ?? maximumOverpassAreaKm2);
  const serviceLabel = typeof options.serviceLabel === "string" && options.serviceLabel.trim() ? options.serviceLabel.trim().slice(0, 80) : "公共 Overpass";
  if (aoi.crossesAntimeridian) return { state: "skipped" as const, message: `范围跨越日期变更线，${serviceLabel}矩形查询未执行` };
  if (aoi.areaKm2 > maximumAreaKm2) return {
    state: "skipped" as const,
    message: `范围 ${Math.round(aoi.areaKm2).toLocaleString()} km²，超过${serviceLabel}单次 ${Math.round(maximumAreaKm2).toLocaleString()} km² 的保守查询范围，已安全跳过 OSM；人口统计请以 WorldPop 状态为准`,
  };
  const polygons = outerPolygonRings(aoi.geometry);
  const polygonVertexCount = polygons.reduce((sum, ring) => sum + ring.length, 0);
  if (!polygons.length || polygons.length > 12 || polygonVertexCount > 400) return { state: "skipped" as const, message: `AOI 分块或顶点过多，未向${serviceLabel}提交高负载查询` };
  const polygonFilters = polygons.map((ring) => `(poly:"${ring.map(([longitude, latitude]) => `${latitude.toFixed(6)} ${longitude.toFixed(6)}`).join(" ")}")`);
  const facilityAmenity = "hospital|clinic|doctors|pharmacy|fire_station|police|school|kindergarten|college|university|shelter|community_centre";
  const selectors = (prefix: string, suffix = "") => polygonFilters.map((filter) => `  ${prefix}${filter}${suffix};`).join("\n");
  const timeoutSeconds = Math.max(15, Math.min(120, Math.round(options.queryTimeoutSeconds ?? 15)));
  return {
    state: "ready" as const,
    bbox: aoi.bbox,
    cacheIdentity: aoiFingerprint(aoi.geometry),
    queryBasis: "AOI 外环多边形筛查；内洞暂不从公共 OSM 查询中扣除" as const,
    query: `[out:json][timeout:${timeoutSeconds}];\n(\n${selectors("way[\"building\"]")}\n)->.buildings;\n(\n${selectors("way[\"highway\"]")}\n)->.roads;\n(\n${selectors(`nwr["amenity"~"^(${facilityAmenity})$"]`)}\n${selectors("nwr[\"emergency\"=\"ambulance_station\"]")}\n${selectors("nwr[\"power\"~\"^(plant|substation)$\"]")}\n${selectors("nwr[\"man_made\"~\"^(water_works|wastewater_plant|pumping_station)$\"]")}\n)->.facilities;\n.buildings out count;\n.roads out count;\n.facilities out count;\n.facilities out center qt 300;`,
  };
}

export function parseOverpassExposure(payload: unknown): OverpassExposureResult {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { elements?: unknown }).elements)) throw new Error("Overpass 响应结构无效");
  const record = payload as { osm3s?: { timestamp_osm_base?: unknown }; elements: Array<Record<string, unknown>> };
  const countElements = record.elements.filter((element) => element.type === "count");
  const mappedBuildingCount = countTotal(countElements[0]);
  const mappedRoadWayCount = countTotal(countElements[1]);
  const mappedKeyFacilityCount = countTotal(countElements[2]);
  if ([mappedBuildingCount, mappedRoadWayCount, mappedKeyFacilityCount].some((value) => value === null)) throw new Error("Overpass 统计响应缺少建筑、道路或设施计数");
  const facilities = record.elements.flatMap((element) => overpassFacility(element));
  const unique = [...new Map(facilities.map((facility) => [facility.id, facility])).values()];
  const facilityCounts: Partial<Record<ExposureFacilityKind, number>> = {};
  for (const facility of unique) facilityCounts[facility.kind] = (facilityCounts[facility.kind] ?? 0) + 1;
  return {
    mappedBuildingCount: mappedBuildingCount!,
    mappedRoadWayCount: mappedRoadWayCount!,
    mappedKeyFacilityCount: mappedKeyFacilityCount!,
    facilityCounts,
    facilities: unique,
    facilitiesTruncated: mappedKeyFacilityCount! > unique.length,
    osmBaseTimestamp: typeof record.osm3s?.timestamp_osm_base === "string" ? record.osm3s.timestamp_osm_base : undefined,
  };
}

export function parseWorldPopTask(payload: unknown, year: number, resolution: "100m" | "1km", priorTaskId?: string): PopulationExposure {
  if (!payload || typeof payload !== "object") throw new Error("WorldPop 响应结构无效");
  const value = payload as Record<string, unknown>;
  const taskId = textValue(value.task_id) || textValue(value.taskId) || priorTaskId;
  const status = (textValue(value.status) || textValue(value.state) || "").toLowerCase();
  const result = objectValue(value.result) ?? objectValue(value.data) ?? value;
  const totalPopulation = numberValue(result.total_population ?? result.totalPopulation ?? result.population);
  const density = numberValue(result.population_density ?? result.populationDensity ?? result.density);
  if (totalPopulation !== null) {
    return {
      state: "ready",
      provider: "WorldPop",
      year: Math.round(numberValue(result.data_year) ?? year),
      resolution,
      taskId,
      totalPopulation: Math.max(0, totalPopulation),
      populationDensityPerKm2: density === null ? undefined : Math.max(0, density),
      dataSource: textValue(result.data_source) || undefined,
      processingTimeMs: numberValue(result.processing_time_ms) ?? undefined,
      message: "人口为 WorldPop 指定年份模型估计，不是实时人口或现场普查",
    };
  }
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) throw new Error(textValue(value.message) || textValue(value.error) || "WorldPop 任务失败");
  if (!taskId) throw new Error("WorldPop 响应未返回 task_id 或人口结果");
  return { state: "pending", provider: "WorldPop", year, resolution, taskId, message: "WorldPop 正在计算；稍后点击继续查询，不会重复提交任务" };
}

export function exposureRiskInput(population: PopulationExposure, osm: OsmExposure) {
  if (population.state !== "ready" || population.totalPopulation === undefined) return null;
  const total = Math.max(0, population.totalPopulation);
  const density = Math.max(0, population.populationDensityPerKm2 ?? 0);
  const totalScore = clamp(((Math.log10(total + 1) - 1) / 5) * 100, 0, 100);
  const densityScore = clamp((Math.log10(density + 1) / 4) * 100, 0, 100);
  const populationBaseline = Math.min(85, Math.round(totalScore * 0.72 + densityScore * 0.28));
  const osmContext = osm.state === "ready" ? Math.min(15,
    Math.min(5, Math.log10((osm.mappedBuildingCount ?? 0) + 1) * 1.5)
    + Math.min(3, Math.log10((osm.mappedRoadWayCount ?? 0) + 1))
    + Math.min(7, Math.log10((osm.mappedKeyFacilityCount ?? 0) + 1) * 2.2)) : 0;
  const index = Math.min(100, Math.round(populationBaseline + osmContext));
  const osmBasis = osm.state === "ready"
    ? `；OSM 已映射建筑 ${osm.mappedBuildingCount?.toLocaleString()}、道路 way ${osm.mappedRoadWayCount?.toLocaleString()}、关键设施 ${osm.mappedKeyFacilityCount?.toLocaleString()} 仅作上调背景，不以缺失记录降低指数`
    : "；本指数仅含人口暴露，未计入建筑、道路和关键设施存量";
  return {
    index,
    basis: `WorldPop ${population.year} 年模型估计人口 ${Math.round(total).toLocaleString()}，密度 ${Math.round(density).toLocaleString()} 人/km²${osmBasis}`,
  };
}

export function exposureAssessmentStatus(population: PopulationExposure, osm: OsmExposure): ExposureAssessment["status"] {
  if (population.state === "pending") return "pending";
  if (population.state === "ready" && osm.state === "ready") return "complete";
  if (population.state === "ready" || osm.state === "ready") return "partial";
  return "unavailable";
}

export function exposureFacilityKindLabel(kind: ExposureFacilityKind) {
  return { health: "医疗", emergency: "应急", shelter: "避难", education: "教育", power: "电力", water: "供排水" }[kind];
}

function circlePolygon(longitude: number, latitude: number, radiusKm: number, steps: number): EventGeometry {
  const angular = radiusKm / 6371.0088;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const ring: Array<[number, number]> = [];
  for (let index = 0; index < steps; index += 1) {
    const bearing = index / steps * Math.PI * 2;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([normalizeLongitude(lon2 * 180 / Math.PI), lat2 * 180 / Math.PI]);
  }
  ring.push([...ring[0]]);
  const raw: EventGeometry = { type: "Polygon", coordinates: [ring] };
  return normalizeAntimeridianGeometry(raw) ?? raw;
}

function geometryBbox(geometry: EventGeometry): [number, number, number, number] {
  const points: Array<[number, number]> = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  if (!points.length) throw new Error("暴露度范围没有有效坐标");
  return [Math.min(...points.map(([lon]) => lon)), Math.min(...points.map(([, lat]) => lat)), Math.max(...points.map(([lon]) => lon)), Math.max(...points.map(([, lat]) => lat))];
}

function outerPolygonRings(geometry: EventGeometry): Array<Array<[number, number]>> {
  if (geometry.type === "Polygon") return [(geometry.coordinates as Array<Array<[number, number]>>)[0] ?? []];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Array<Array<Array<[number, number]>>>).map((polygon) => polygon[0] ?? []);
  return [];
}

export function partitionExposureGeometry(geometry: EventGeometry, maximumAreaKm2: number): EventGeometry[] {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") throw new Error("WorldPop 分块仅支持 Polygon/MultiPolygon");
  const targetAreaKm2 = Math.max(1_000, maximumAreaKm2);
  const queue: EventGeometry[] = [geometry];
  const completed: EventGeometry[] = [];
  let splits = 0;
  while (queue.length) {
    const current = queue.shift()!;
    const validation = validateGeoGeometry(current, { maximumAreaKm2: 25_000_000, maximumVertices: 20_000, maximumRingVertices: 5_000, allowOverlappingMultiPolygon: true });
    if (!validation.ok) throw new Error(validation.reason || "WorldPop 分块前几何无效");
    if (validation.areaKm2 <= targetAreaKm2) {
      completed.push(current);
      continue;
    }
    if (splits >= 64) throw new Error("WorldPop 范围分块过多，请缩小 AOI");
    splits += 1;
    const bbox = geometryBbox(current);
    const centerLatitude = (bbox[1] + bbox[3]) / 2;
    const widthKm = (bbox[2] - bbox[0]) * 111.32 * Math.max(0.1, Math.cos(centerLatitude * Math.PI / 180));
    const heightKm = (bbox[3] - bbox[1]) * 110.57;
    const vertical = widthKm >= heightKm;
    const midpoint = vertical ? (bbox[0] + bbox[2]) / 2 : (bbox[1] + bbox[3]) / 2;
    const boxes: Array<[number, number, number, number]> = vertical
      ? [[bbox[0], bbox[1], midpoint, bbox[3]], [midpoint, bbox[1], bbox[2], bbox[3]]]
      : [[bbox[0], bbox[1], bbox[2], midpoint], [bbox[0], midpoint, bbox[2], bbox[3]]];
    const children = boxes.flatMap((box) => intersectGeometryWithBbox(current, box));
    if (children.length < 2) throw new Error("WorldPop 范围无法安全分块，请缩小 AOI");
    queue.push(...children);
  }
  return completed.sort((left, right) => {
    const leftBox = geometryBbox(left);
    const rightBox = geometryBbox(right);
    return leftBox[1] - rightBox[1] || leftBox[0] - rightBox[0];
  });
}

function intersectGeometryWithBbox(geometry: EventGeometry, bbox: [number, number, number, number]): EventGeometry[] {
  const subject = geometry.type === "Polygon"
    ? geometry.coordinates as ClippingPolygon
    : geometry.coordinates as ClippingMultiPolygon;
  const [west, south, east, north] = bbox;
  const clip: ClippingPolygon = [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
  const clipped = polygonClipping.intersection(subject, clip);
  if (!clipped.length) return [];
  const candidate: EventGeometry = clipped.length === 1
    ? { type: "Polygon", coordinates: clipped[0] }
    : { type: "MultiPolygon", coordinates: clipped };
  const normalized = normalizeAntimeridianGeometry(candidate) ?? candidate;
  const validation = validateGeoGeometry(normalized, { maximumAreaKm2: 25_000_000, maximumVertices: 20_000, maximumRingVertices: 5_000, allowOverlappingMultiPolygon: true });
  return validation.ok && validation.areaKm2 > 0.01 ? [normalized] : [];
}

function overpassFacility(element: Record<string, unknown>): ExposureFacility[] {
  const type = element.type;
  const osmId = numberValue(element.id);
  if (!(["node", "way", "relation"].includes(String(type))) || osmId === null) return [];
  const tags = objectValue(element.tags) ?? {};
  const center = objectValue(element.center);
  const latitude = numberValue(element.lat) ?? numberValue(center?.lat);
  const longitude = numberValue(element.lon) ?? numberValue(center?.lon);
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
  const kind = facilityKind(tags);
  if (!kind) return [];
  const name = textValue(tags["name:zh"]) || textValue(tags.name) || textValue(tags.operator) || `${exposureFacilityKindLabel(kind)}设施`;
  return [{ id: `osm-${type}-${osmId}`, kind, name: name.slice(0, 160), latitude, longitude, osmType: type as ExposureFacility["osmType"], osmId }];
}

function facilityKind(tags: Record<string, unknown>): ExposureFacilityKind | null {
  const amenity = textValue(tags.amenity);
  if (["hospital", "clinic", "doctors", "pharmacy"].includes(amenity)) return "health";
  if (["fire_station", "police"].includes(amenity) || textValue(tags.emergency) === "ambulance_station") return "emergency";
  if (["shelter", "community_centre"].includes(amenity)) return "shelter";
  if (["school", "kindergarten", "college", "university"].includes(amenity)) return "education";
  if (["plant", "substation"].includes(textValue(tags.power))) return "power";
  if (["water_works", "wastewater_plant", "pumping_station"].includes(textValue(tags.man_made))) return "water";
  return null;
}

function countTotal(element: Record<string, unknown> | undefined) {
  const tags = objectValue(element?.tags);
  return numberValue(tags?.total);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeLongitude(value: number) {
  return ((value + 540) % 360) - 180;
}
