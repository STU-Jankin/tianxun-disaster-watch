import { cycloneUncertaintyGeometry, cycloneWindGeometry } from "./cyclone-forecast.ts";
import type { DisasterEvent, EventGeometry, HazardType } from "./disasters";
import type { AmapRoadRoute, AmapRoadRoutingResponse, AmapTrafficSummary, AmapTravelMode } from "./amap-routing";
import { activeRoadDisruptionConflicts, type RoadDisruption, type RoadDisruptionConflict } from "./response-disruptions.ts";
import type { InfrastructureAssessment, InfrastructureCrossing, InfrastructureFeature } from "./osm-infrastructure.ts";

export type ResponseCoordinate = [number, number];
export type ResponseRouteStatus = "clear" | "limited" | "blocked" | "unverified";

export type ResponseRouteCandidate = {
  routeId: string;
  label: string;
  geometry: { type: "LineString"; coordinates: ResponseCoordinate[] };
  distanceKm: number;
  estimatedMinutes: number;
  status: ResponseRouteStatus;
  exposureKm: number;
  firstConflictAt?: string;
  firstConflictCoordinate?: ResponseCoordinate;
  roadProvider?: "高德地图";
  restriction?: boolean;
  tollsYuan?: number;
  trafficLights?: number;
  roadNames?: string[];
  traffic?: AmapTrafficSummary;
  originSnapKm?: number;
  destinationSnapKm?: number;
  disruptionConflicts?: RoadDisruptionConflict[];
  disruptionDataStatus?: "not_supplied" | "checked";
  infrastructureCrossings?: InfrastructureCrossing[];
  infrastructureDataStatus?: InfrastructureAssessment["state"];
  note: string;
};

export type ResponseScenario = {
  schemaVersion: 1;
  scenarioId: string;
  masterEventId: string;
  eventId: string;
  eventRevision: string;
  eventUpdatedAt: string;
  title: string;
  hazard: HazardType;
  createdAt: string;
  updatedAt: string;
  departureAt: string;
  origin: ResponseCoordinate;
  destination: ResponseCoordinate;
  travelSpeedKph: number;
  router: "geometric_preview_v1" | "amap_driving_v1" | "amap_multimodal_v1";
  travelTimeBasis?: "constant_speed" | "provider_traffic_estimate";
  travelMode?: AmapTravelMode;
  roadDisruptions?: RoadDisruption[];
  roadDisruptionCheckCount?: number;
  infrastructureFeatures?: InfrastructureFeature[];
  infrastructureCheckCount?: number;
  infrastructureData?: {
    state: InfrastructureAssessment["state"];
    provider: "OpenStreetMap · Overpass";
    fetchedAt?: string;
    queryBbox?: [number, number, number, number];
    queryAreaKm2?: number;
    attribution?: "© OpenStreetMap contributors · ODbL";
    sourceUrl?: "https://www.openstreetmap.org/copyright";
    note: string;
  };
  roadData?: {
    provider: "高德地图";
    fetchedAt: string;
    sourceCoordinateSystem: "GCJ-02";
    normalizedCoordinateSystem: "WGS84_APPROX";
    note: string;
  };
  selectedRouteId: string;
  routes: ResponseRouteCandidate[];
  sourceStatus: "verified" | "review_required";
  disclaimer: string;
};

type AreaGeometry = {
  type: "Polygon";
  coordinates: number[][][];
} | {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

type HazardSlice = {
  validFrom: number;
  validTo: number;
  geometries: AreaGeometry[];
  label: string;
  timeIndexed: boolean;
};

const staticRadiusKm: Record<HazardType, number> = {
  earthquake: 50,
  tsunami: 100,
  wildfire: 25,
  flood: 40,
  cyclone: 200,
  volcano: 30,
  landslide: 10,
  drought: 100,
  dust: 300,
  ice: 100,
};

export function planResponseScenario(event: DisasterEvent, options: {
  eventRevision: string;
  origin: ResponseCoordinate;
  destination: ResponseCoordinate;
  departureAt: string;
  travelSpeedKph?: number;
  travelMode?: AmapTravelMode;
  scenarioId?: string;
  createdAt?: string;
}): ResponseScenario {
  const origin = validCoordinate(options.origin, "起点");
  const destination = validCoordinate(options.destination, "目的地");
  const departure = Date.parse(options.departureAt);
  if (!Number.isFinite(departure)) throw new Error("出发时间无效");
  const speed = Number(options.travelSpeedKph ?? 35);
  if (!Number.isFinite(speed) || speed < 5 || speed > 160) throw new Error("直线估算速度必须在 5–160 km/h 之间");
  if (haversineKm(origin, destination) < 0.5) throw new Error("起点与目的地至少相距 0.5 km");

  const slices = eventHazardSlices(event);
  const coordinates = candidateRouteCoordinates(origin, destination);
  const routes = coordinates.map((candidate, index) => evaluateRoute(
    `route-${index + 1}`,
    index === 0 ? "最短几何路径" : index === 1 ? "左侧绕行参考" : "右侧绕行参考",
    candidate,
    departure,
    speed,
    slices,
    event.dispatchEligibility === "ready",
  )).sort(compareRoutes);
  const now = new Date().toISOString();
  const selected = routes.find((route) => route.status === "clear")
    ?? routes.find((route) => route.status === "limited")
    ?? routes[0];
  return {
    schemaVersion: 1,
    scenarioId: options.scenarioId ?? `response-${event.masterEventId}-${Date.now().toString(36)}`,
    masterEventId: event.masterEventId,
    eventId: event.id,
    eventRevision: options.eventRevision,
    eventUpdatedAt: event.updatedAt,
    title: event.title,
    hazard: event.hazard,
    createdAt: options.createdAt ?? now,
    updatedAt: now,
    departureAt: new Date(departure).toISOString(),
    origin,
    destination,
    travelSpeedKph: speed,
    router: "geometric_preview_v1",
    travelTimeBasis: "constant_speed",
    travelMode: options.travelMode ?? "driving",
    selectedRouteId: selected.routeId,
    routes,
    sourceStatus: event.dispatchEligibility === "ready" ? "verified" : "review_required",
    disclaimer: "直线几何敏感性估算，不代表真实道路或预计耗时；正式处置前必须使用权威路网、交通管制与现场核验。",
  };
}

export function planRoadResponseScenario(event: DisasterEvent, options: {
  eventRevision: string;
  origin: ResponseCoordinate;
  destination: ResponseCoordinate;
  departureAt: string;
  roadRouting: Extract<AmapRoadRoutingResponse, { state: "ready" }>;
  roadDisruptions?: RoadDisruption[];
  infrastructure?: InfrastructureAssessment;
  scenarioId?: string;
  createdAt?: string;
}): ResponseScenario {
  const origin = validCoordinate(options.origin, "起点");
  const destination = validCoordinate(options.destination, "目的地");
  const departure = Date.parse(options.departureAt);
  if (!Number.isFinite(departure)) throw new Error("出发时间无效");
  if (haversineKm(origin, destination) < 0.2) throw new Error("起点与目的地至少相距 0.2 km");
  if (!options.roadRouting.routes.length || options.roadRouting.routes.length > 3) throw new Error("真实道路候选数量无效");
  const disruptions = options.roadDisruptions ?? [];

  const slices = eventHazardSlices(event);
  const routes = options.roadRouting.routes.map((roadRoute) => evaluateRoadRoute(
    roadRoute,
    origin,
    destination,
    departure,
    slices,
    event.dispatchEligibility === "ready",
    options.roadRouting.mode,
    disruptions,
    options.infrastructure,
  )).sort(compareRoutes);
  const selected = routes.find((route) => route.status === "clear")
    ?? routes.find((route) => route.status === "limited")
    ?? routes.find((route) => route.status === "unverified")
    ?? routes[0];
  const now = new Date().toISOString();
  const selectedAverageSpeed = selected.distanceKm > 0 && selected.estimatedMinutes > 0
    ? Math.max(5, Math.min(160, selected.distanceKm / selected.estimatedMinutes * 60))
    : 35;
  const conflictIds = new Set(routes.flatMap((route) => route.disruptionConflicts ?? []).map((conflict) => conflict.disruptionId));
  const infrastructureIds = new Set(routes.flatMap((route) => route.infrastructureCrossings ?? []).map((feature) => feature.infrastructureId));
  const infrastructureData = options.infrastructure ? {
    state: options.infrastructure.state,
    provider: options.infrastructure.provider,
    fetchedAt: options.infrastructure.state === "ready" ? options.infrastructure.fetchedAt : undefined,
    queryBbox: options.infrastructure.state === "ready" ? options.infrastructure.queryBbox : options.infrastructure.queryBbox,
    queryAreaKm2: options.infrastructure.state === "ready" ? options.infrastructure.queryAreaKm2 : options.infrastructure.queryAreaKm2,
    attribution: options.infrastructure.state === "ready" ? options.infrastructure.attribution : undefined,
    sourceUrl: options.infrastructure.state === "ready" ? options.infrastructure.sourceUrl : undefined,
    note: options.infrastructure.state === "ready" ? options.infrastructure.note : options.infrastructure.message,
  } : undefined;
  return {
    schemaVersion: 1,
    scenarioId: options.scenarioId ?? `response-${event.masterEventId}-${Date.now().toString(36)}`,
    masterEventId: event.masterEventId,
    eventId: event.id,
    eventRevision: options.eventRevision,
    eventUpdatedAt: event.updatedAt,
    title: event.title,
    hazard: event.hazard,
    createdAt: options.createdAt ?? now,
    updatedAt: now,
    departureAt: new Date(departure).toISOString(),
    origin,
    destination,
    travelSpeedKph: round(selectedAverageSpeed, 1),
    router: "amap_multimodal_v1",
    travelTimeBasis: "provider_traffic_estimate",
    travelMode: options.roadRouting.mode,
    roadDisruptions: disruptions.filter((disruption) => conflictIds.has(disruption.disruptionId)),
    roadDisruptionCheckCount: disruptions.length,
    infrastructureFeatures: options.infrastructure?.state === "ready" ? options.infrastructure.features.filter((feature) => infrastructureIds.has(feature.infrastructureId)) : [],
    infrastructureCheckCount: options.infrastructure?.state === "ready" ? options.infrastructure.features.length : 0,
    infrastructureData,
    roadData: {
      provider: options.roadRouting.provider,
      fetchedAt: options.roadRouting.fetchedAt,
      sourceCoordinateSystem: options.roadRouting.sourceCoordinateSystem,
      normalizedCoordinateSystem: options.roadRouting.normalizedCoordinateSystem,
      note: options.roadRouting.note,
    },
    selectedRouteId: selected.routeId,
    routes,
    sourceStatus: event.dispatchEligibility === "ready" ? "verified" : "review_required",
    disclaimer: `真实道路候选来自高德${travelModeLabel(options.roadRouting.mode)}规划，并由天巡按灾害影响场、道路中断和 OSM 基础设施暴露进行二次筛查；OSM 标注不证明设施完好，未上报道路毁损不代表道路安全，正式处置前必须核验交通管制、桥梁监测和现场通行条件。`,
  };
}

export function defaultResponseEndpoints(event: DisasterEvent, departureAt = new Date().toISOString()) {
  const origin: ResponseCoordinate = [event.longitude, event.latitude];
  const slices = eventHazardSlices(event);
  const departure = Date.parse(departureAt);
  const active = activeHazards(slices, departure).geometries;
  const searchDistances = [30, 60, 120, 240, 480, 960];
  const bearings = [90, 0, 180, 270, 45, 135, 225, 315];
  for (const distance of searchDistances) {
    for (const bearing of bearings) {
      const candidate = destinationPoint(origin, distance, bearing);
      if (!active.some((geometry) => pointInArea(candidate, geometry))) return { origin, destination: candidate };
    }
  }
  return { origin, destination: destinationPoint(origin, 1200, 90) };
}

export function responseScenarioGeoJson(scenario: ResponseScenario) {
  return {
    type: "FeatureCollection" as const,
    name: `天巡处置推演-${scenario.scenarioId}`,
    generatedAt: new Date().toISOString(),
    disclaimer: scenario.disclaimer,
    features: [
      {
        type: "Feature" as const,
        properties: { role: "origin", scenarioId: scenario.scenarioId, eventId: scenario.masterEventId },
        geometry: { type: "Point" as const, coordinates: scenario.origin },
      },
      {
        type: "Feature" as const,
        properties: { role: "destination", scenarioId: scenario.scenarioId, eventId: scenario.masterEventId },
        geometry: { type: "Point" as const, coordinates: scenario.destination },
      },
      ...scenario.routes.map((route) => ({
        type: "Feature" as const,
        properties: {
          role: "route_candidate",
          scenarioId: scenario.scenarioId,
          eventId: scenario.masterEventId,
          routeId: route.routeId,
          label: route.label,
          selected: route.routeId === scenario.selectedRouteId,
          status: route.status,
          distanceKm: route.distanceKm,
          estimatedMinutes: route.estimatedMinutes,
          exposureKm: route.exposureKm,
          departureAt: scenario.departureAt,
          router: scenario.router,
          roadProvider: route.roadProvider,
          restriction: route.restriction,
          originSnapKm: route.originSnapKm,
          destinationSnapKm: route.destinationSnapKm,
          disruptionConflictCount: route.disruptionConflicts?.length ?? 0,
          infrastructureCrossingCount: route.infrastructureCrossings?.length ?? 0,
          infrastructureDataStatus: route.infrastructureDataStatus,
          roadDataFetchedAt: scenario.roadData?.fetchedAt,
          coordinateNormalization: scenario.roadData?.normalizedCoordinateSystem,
          eventRevision: scenario.eventRevision,
        },
        geometry: route.geometry,
      })),
      ...(scenario.roadDisruptions ?? []).map((disruption) => ({
        type: "Feature" as const,
        properties: {
          role: "road_disruption",
          scenarioId: scenario.scenarioId,
          eventId: scenario.masterEventId,
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
          importedAt: disruption.importedAt,
          lifecycleStatus: disruption.lifecycleStatus,
          revision: disruption.revision,
          reportedAt: disruption.reportedAt,
          updatedAt: disruption.updatedAt,
          reportedBy: disruption.reportedBy,
          verifiedAt: disruption.verifiedAt,
          verifiedBy: disruption.verifiedBy,
          resolvedAt: disruption.resolvedAt,
          resolvedBy: disruption.resolvedBy,
        },
        geometry: disruption.geometry,
      })),
      ...(scenario.infrastructureFeatures ?? []).map((feature) => ({
        type: "Feature" as const,
        properties: {
          role: "infrastructure_exposure",
          scenarioId: scenario.scenarioId,
          eventId: scenario.masterEventId,
          infrastructureId: feature.infrastructureId,
          kind: feature.kind,
          label: feature.label,
          osmType: feature.osmType,
          osmId: feature.osmId,
          highway: feature.highway,
          ref: feature.ref,
          bridgeTag: feature.bridgeTag,
          tunnelTag: feature.tunnelTag,
          maxweight: feature.maxweight,
          lanes: feature.lanes,
          sourceUrl: feature.sourceUrl,
          attribution: feature.attribution,
          structuralStatus: "unknown",
        },
        geometry: feature.geometry,
      })),
    ],
  };
}

export function responseRouteStatusLabel(status: ResponseRouteStatus) {
  if (status === "clear") return "未检出影响区相交";
  if (status === "limited") return "从影响区内向外撤离";
  if (status === "blocked") return "穿越影响区或已核验中断";
  return "数据不足，禁止判定安全";
}

function eventHazardSlices(event: DisasterEvent): HazardSlice[] {
  const frames = event.cycloneForecast?.impactField?.frames;
  if (frames?.length) {
    return frames.map((frame, index) => {
      const geometries: AreaGeometry[] = [];
      const outerWind = [...frame.windFields].sort((left, right) => left.thresholdKnots - right.thresholdKnots)[0];
      if (outerWind) geometries.push(asArea(cycloneWindGeometry(frame, outerWind)));
      const uncertainty = cycloneUncertaintyGeometry(frame);
      if (uncertainty) geometries.push(asArea(uncertainty));
      const start = Date.parse(frame.forecastAt);
      const next = frames[index + 1] ? Date.parse(frames[index + 1].forecastAt) : start + 3_600_000;
      return {
        validFrom: start,
        validTo: Number.isFinite(next) ? next : start + 3_600_000,
        geometries,
        label: `官方台风4D影响场 +${frame.leadHours}h`,
        timeIndexed: true,
      };
    }).filter((slice) => Number.isFinite(slice.validFrom) && slice.geometries.length > 0);
  }

  const forecast = event.cycloneForecast;
  if (forecast) {
    const geometries = [forecast.impactGeometry, forecast.uncertaintyGeometry]
      .filter((geometry): geometry is EventGeometry => Boolean(geometry))
      .filter(isAreaGeometry)
      .map(asArea);
    if (geometries.length) return [{
      validFrom: Date.parse(forecast.issuedAt),
      validTo: Date.parse(forecast.forecastValidUntil),
      geometries,
      label: "官方台风预报影响范围",
      timeIndexed: true,
    }];
  }

  const geometries: AreaGeometry[] = [];
  if (event.geometry.type === "Polygon" || event.geometry.type === "MultiPolygon") geometries.push(asArea(event.geometry));
  else if (event.geometry.type === "LineString" && Array.isArray(event.geometry.coordinates)) {
    const points = (event.geometry.coordinates as unknown[]).filter(isCoordinate).slice(0, 80) as ResponseCoordinate[];
    geometries.push(...points.map((point) => circleGeometry(point, Math.max(2, Math.min(25, event.locationAccuracyKm || staticRadiusKm[event.hazard] / 4)))));
  } else geometries.push(circleGeometry([event.longitude, event.latitude], Math.max(staticRadiusKm[event.hazard], event.locationAccuracyKm || 0)));
  return [{ validFrom: Number.NEGATIVE_INFINITY, validTo: Number.POSITIVE_INFINITY, geometries, label: "当前事件影响范围", timeIndexed: false }];
}

function evaluateRoute(routeId: string, label: string, coordinates: ResponseCoordinate[], departure: number, speedKph: number, slices: HazardSlice[], sourceVerified: boolean): ResponseRouteCandidate {
  const samples: Array<{ coordinate: ResponseCoordinate; distanceKm: number; time: number; inside: boolean; covered: boolean }> = [];
  let cumulative = 0;
  coordinates.forEach((coordinate, index) => {
    if (index === coordinates.length - 1) return;
    const next = coordinates[index + 1];
    const segmentKm = haversineKm(coordinate, next);
    const steps = Math.max(1, Math.min(2000, Math.ceil(segmentKm / 2)));
    for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const point = interpolateCoordinate(coordinate, next, ratio);
      const distanceKm = cumulative + segmentKm * ratio;
      const time = departure + distanceKm / speedKph * 3_600_000;
      const active = activeHazards(slices, time);
      samples.push({ coordinate: point, distanceKm, time, covered: active.covered, inside: active.geometries.some((geometry) => pointInArea(point, geometry)) });
    }
    cumulative += segmentKm;
  });
  const initialInside = samples[0]?.inside ?? false;
  const destinationInside = samples.at(-1)?.inside ?? false;
  let exited = !initialInside;
  let reentered = false;
  let priorInside = initialInside;
  let exposureKm = 0;
  let firstConflict = samples.find((sample) => sample.inside);
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const prior = samples[index - 1];
    if (sample.inside || prior.inside) exposureKm += Math.max(0, sample.distanceKm - prior.distanceKm);
    if (priorInside && !sample.inside) exited = true;
    if (exited && !priorInside && sample.inside) reentered = true;
    priorInside = sample.inside;
  }
  const coverageMissing = slices.some((slice) => slice.timeIndexed) && samples.some((sample) => !sample.covered);
  let status: ResponseRouteStatus;
  if (destinationInside || reentered || (!initialInside && samples.some((sample) => sample.inside))) status = "blocked";
  else if (!sourceVerified || coverageMissing || slices.length === 0) status = "unverified";
  else if (initialInside) status = "limited";
  else status = "clear";
  if (status === "unverified" && !firstConflict && coverageMissing) firstConflict = samples.find((sample) => !sample.covered);
  const note = status === "clear"
    ? "在当前事件几何与预计通行时刻内未检出相交；仍未校验真实道路。"
    : status === "limited"
      ? "起点位于影响区内，路径仅在持续向外且不再进入时作为撤离参考，不能标记为安全路线。"
      : status === "blocked"
        ? "候选路径进入、重返或终止于影响区，禁止作为可用路线。"
        : coverageMissing
          ? "预计通行时间超出4D影响场有效期，禁止判定安全。"
          : "事件几何尚未可靠核验，禁止判定安全。";
  return {
    routeId,
    label,
    geometry: { type: "LineString", coordinates },
    distanceKm: round(cumulative, 1),
    estimatedMinutes: Math.max(1, Math.round(cumulative / speedKph * 60)),
    status,
    exposureKm: round(exposureKm, 1),
    firstConflictAt: firstConflict ? new Date(firstConflict.time).toISOString() : undefined,
    firstConflictCoordinate: firstConflict?.coordinate,
    note,
  };
}

function evaluateRoadRoute(roadRoute: AmapRoadRoute, origin: ResponseCoordinate, destination: ResponseCoordinate, departure: number, slices: HazardSlice[], sourceVerified: boolean, mode: AmapTravelMode, disruptions: RoadDisruption[], infrastructure?: InfrastructureAssessment): ResponseRouteCandidate {
  if (roadRoute.mode !== mode) throw new Error("真实道路候选的出行方式不一致");
  if (!Array.isArray(roadRoute.coordinates) || roadRoute.coordinates.length < 2 || roadRoute.coordinates.length > 2_000) throw new Error("真实道路折线点数无效");
  const coordinates = roadRoute.coordinates.map((coordinate, index) => validCoordinate(coordinate, `真实道路点 ${index + 1}`));
  const originSnapKm = haversineKm(origin, coordinates[0]);
  const destinationSnapKm = haversineKm(destination, coordinates.at(-1)!);
  if (originSnapKm > 50 || destinationSnapKm > 50) throw new Error("真实道路端点与请求坐标偏差超过 50 km；请重新设置可通行道路附近的起终点");
  const polylineKm = coordinates.slice(1).reduce((sum, coordinate, index) => sum + haversineKm(coordinates[index], coordinate), 0);
  if (!Number.isFinite(polylineKm) || polylineKm < 0.1 || polylineKm > 3_000) throw new Error("真实道路里程无效");
  const estimatedMinutes = Number(roadRoute.estimatedMinutes);
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 7 * 24 * 60) throw new Error("真实道路预计耗时无效");
  const timingSpeedKph = Math.max(2, Math.min(160, polylineKm / estimatedMinutes * 60));
  const evaluated = evaluateRoute(roadRoute.routeId, roadRoute.label, coordinates, departure, timingSpeedKph, slices, sourceVerified);
  const providerDistance = Number(roadRoute.distanceKm);
  evaluated.distanceKm = round(Number.isFinite(providerDistance) && providerDistance > 0 ? providerDistance : polylineKm, 1);
  evaluated.estimatedMinutes = Math.round(estimatedMinutes);
  evaluated.roadProvider = "高德地图";
  evaluated.restriction = roadRoute.restriction;
  evaluated.tollsYuan = roadRoute.tollsYuan;
  evaluated.trafficLights = roadRoute.trafficLights;
  evaluated.roadNames = roadRoute.roadNames.slice(0, 24);
  evaluated.traffic = roadRoute.traffic;
  evaluated.originSnapKm = round(originSnapKm, 1);
  evaluated.destinationSnapKm = round(destinationSnapKm, 1);
  evaluated.disruptionDataStatus = disruptions.length ? "checked" : "not_supplied";
  evaluated.disruptionConflicts = activeRoadDisruptionConflicts(coordinates, disruptions, mode, new Date(departure).toISOString(), estimatedMinutes);
  evaluated.infrastructureDataStatus = infrastructure?.state ?? "unavailable";
  evaluated.infrastructureCrossings = infrastructure?.state === "ready" ? infrastructure.crossingsByRoute[roadRoute.routeId] ?? [] : [];
  const endpointNeedsReview = originSnapKm > 1 || destinationSnapKm > 1;
  const verifiedBlock = evaluated.disruptionConflicts.some((conflict) => conflict.verification === "verified" && conflict.impact === "blocked");
  if (verifiedBlock) evaluated.status = "blocked";
  else if ((roadRoute.restriction || endpointNeedsReview || evaluated.disruptionConflicts.length || evaluated.infrastructureCrossings.length) && evaluated.status !== "blocked") evaluated.status = "unverified";
  const trafficWarning = roadRoute.traffic.congestedKm + roadRoute.traffic.severeCongestionKm > 0
    ? `高德报告拥堵/严重拥堵约 ${round(roadRoute.traffic.congestedKm + roadRoute.traffic.severeCongestionKm, 1)} km。`
    : "";
  const restrictionWarning = roadRoute.restriction ? "高德报告存在未能规避的限行，禁止自动判定可用。" : "";
  const endpointWarning = endpointNeedsReview ? `道路吸附偏差：起点 ${round(originSnapKm, 1)} km、终点 ${round(destinationSnapKm, 1)} km，必须人工核对。` : "";
  const disruptionWarning = evaluated.disruptionConflicts.length
    ? `与 ${evaluated.disruptionConflicts.length} 条有效道路中断相交：${evaluated.disruptionConflicts.slice(0, 3).map((item) => item.label).join("、")}。${verifiedBlock ? "存在已核验硬阻断。" : "中断尚未形成已核验硬阻断，禁止自动判定可用。"}`
    : disruptions.length
      ? `已核对 ${disruptions.length} 条导入的道路中断且未检出相交，但不代表不存在其他毁损。`
      : "未导入道路毁损/封闭数据，道路状态未知。";
  const infrastructureWarning = infrastructure?.state === "ready"
    ? evaluated.infrastructureCrossings.length
      ? `OSM 识别到 ${evaluated.infrastructureCrossings.length} 处桥梁/隧道/涉水设施穿越；这只表示地图存在标注，结构和通行状态未知，禁止自动判定可用。`
      : `已在约 ${infrastructure.queryAreaKm2.toFixed(1)} km² 的 OSM 查询范围核对 ${infrastructure.features.length} 个设施要素，未检出本路线穿越；地图可能漏标，且不代表设施安全。`
    : infrastructure
      ? `基础设施暴露查询未完成：${infrastructure.message}`
      : "未执行基础设施暴露查询，桥梁、隧道和涉水点覆盖未知。";
  evaluated.note = `${evaluated.note.replace("仍未校验真实道路。", "已使用真实道路折线复核灾害相交。")}${restrictionWarning}${endpointWarning}${trafficWarning}${disruptionWarning}${infrastructureWarning}`;
  return evaluated;
}

function travelModeLabel(mode: AmapTravelMode) {
  if (mode === "walking") return "步行";
  if (mode === "bicycling") return "骑行";
  if (mode === "electrobike") return "电动自行车";
  return "驾车";
}

function candidateRouteCoordinates(origin: ResponseCoordinate, destination: ResponseCoordinate) {
  const midpoint = interpolateCoordinate(origin, destination, 0.5);
  const latitudeRadians = midpoint[1] * Math.PI / 180;
  const eastKm = shortestLongitudeDelta(origin[0], destination[0]) * 111.32 * Math.max(0.08, Math.cos(latitudeRadians));
  const northKm = (destination[1] - origin[1]) * 110.57;
  const distance = Math.max(0.001, Math.hypot(eastKm, northKm));
  const offsetKm = Math.min(350, Math.max(12, distance * 0.45));
  const perpendicularEast = -northKm / distance;
  const perpendicularNorth = eastKm / distance;
  const offsetPoint = (sign: number): ResponseCoordinate => [
    normalizeLongitude(midpoint[0] + sign * perpendicularEast * offsetKm / (111.32 * Math.max(0.08, Math.cos(latitudeRadians)))),
    Math.max(-89.5, Math.min(89.5, midpoint[1] + sign * perpendicularNorth * offsetKm / 110.57)),
  ];
  return [[origin, destination], [origin, offsetPoint(1), destination], [origin, offsetPoint(-1), destination]] as ResponseCoordinate[][];
}

function activeHazards(slices: HazardSlice[], time: number) {
  const active = slices.filter((slice) => time >= slice.validFrom && time < slice.validTo);
  const timeIndexed = slices.some((slice) => slice.timeIndexed);
  return { covered: !timeIndexed || active.length > 0, geometries: active.flatMap((slice) => slice.geometries) };
}

function pointInArea(point: ResponseCoordinate, geometry: AreaGeometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => {
    const rings = polygon as number[][][];
    if (!rings.length || !pointInRing(point, rings[0])) return false;
    return !rings.slice(1).some((ring) => pointInRing(point, ring));
  });
}

function pointInRing(point: ResponseCoordinate, ring: number[][]) {
  let inside = false;
  for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
    const left = ring[index];
    const right = ring[prior];
    if (!isCoordinate(left) || !isCoordinate(right)) continue;
    if (pointOnSegment(point, left as ResponseCoordinate, right as ResponseCoordinate)) return true;
    const intersects = (left[1] > point[1]) !== (right[1] > point[1])
      && point[0] < (right[0] - left[0]) * (point[1] - left[1]) / ((right[1] - left[1]) || Number.EPSILON) + left[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point: ResponseCoordinate, start: ResponseCoordinate, end: ResponseCoordinate) {
  const length = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2;
  if (length < 1e-16) return Math.hypot(point[0] - start[0], point[1] - start[1]) < 1e-8;
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-8) return false;
  const dot = (point[0] - start[0]) * (end[0] - start[0]) + (point[1] - start[1]) * (end[1] - start[1]);
  return dot >= -1e-8 && dot <= length + 1e-8;
}

function circleGeometry(center: ResponseCoordinate, radiusKm: number): AreaGeometry {
  const ring: number[][] = [];
  for (let index = 0; index <= 72; index += 1) ring.push(destinationPoint(center, radiusKm, index * 5));
  return { type: "Polygon", coordinates: [ring] };
}

function destinationPoint(origin: ResponseCoordinate, distanceKm: number, bearingDegrees: number): ResponseCoordinate {
  const radius = 6371.0088;
  const angular = distanceKm / radius;
  const bearing = bearingDegrees * Math.PI / 180;
  const latitude = origin[1] * Math.PI / 180;
  const longitude = origin[0] * Math.PI / 180;
  const destinationLatitude = Math.asin(Math.sin(latitude) * Math.cos(angular) + Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing));
  const destinationLongitude = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude), Math.cos(angular) - Math.sin(latitude) * Math.sin(destinationLatitude));
  return [normalizeLongitude(destinationLongitude * 180 / Math.PI), destinationLatitude * 180 / Math.PI];
}

function interpolateCoordinate(start: ResponseCoordinate, end: ResponseCoordinate, ratio: number): ResponseCoordinate {
  return [normalizeLongitude(start[0] + shortestLongitudeDelta(start[0], end[0]) * ratio), start[1] + (end[1] - start[1]) * ratio];
}

function haversineKm(start: ResponseCoordinate, end: ResponseCoordinate) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(end[1] - start[1]);
  const longitudeDelta = radians(shortestLongitudeDelta(start[0], end[0]));
  const startLatitude = radians(start[1]);
  const endLatitude = radians(end[1]);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function shortestLongitudeDelta(start: number, end: number) {
  return ((end - start + 540) % 360) - 180;
}

function normalizeLongitude(value: number) {
  return ((value + 540) % 360) - 180;
}

function validCoordinate(value: ResponseCoordinate, label: string): ResponseCoordinate {
  const longitude = Number(value?.[0]);
  const latitude = Number(value?.[1]);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`${label}坐标无效`);
  return [longitude, latitude];
}

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

function asArea(geometry: EventGeometry): AreaGeometry {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") throw new Error("处置推演只接受面状影响场");
  return geometry as AreaGeometry;
}

function isAreaGeometry(geometry: EventGeometry): boolean {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

function compareRoutes(left: ResponseRouteCandidate, right: ResponseRouteCandidate) {
  const statusRank: Record<ResponseRouteStatus, number> = { clear: 0, limited: 1, unverified: 2, blocked: 3 };
  return statusRank[left.status] - statusRank[right.status] || left.exposureKm - right.exposureKm || left.distanceKm - right.distanceKm;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
