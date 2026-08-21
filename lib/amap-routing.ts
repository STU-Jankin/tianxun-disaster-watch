export type RoutingCoordinate = [number, number];
export type AmapTravelMode = "driving" | "walking" | "bicycling" | "electrobike";

export type AmapTrafficSummary = {
  unknownKm: number;
  smoothKm: number;
  slowKm: number;
  congestedKm: number;
  severeCongestionKm: number;
};

export type AmapRoadRoute = {
  routeId: string;
  label: string;
  mode: AmapTravelMode;
  strategy: number;
  coordinates: RoutingCoordinate[];
  distanceKm: number;
  estimatedMinutes: number;
  restriction: boolean;
  tollsYuan: number;
  trafficLights: number;
  roadNames: string[];
  traffic: AmapTrafficSummary;
};

export type AmapRoadRoutingResponse = {
  state: "ready";
  provider: "高德地图";
  mode: AmapTravelMode;
  fetchedAt: string;
  sourceCoordinateSystem: "GCJ-02";
  normalizedCoordinateSystem: "WGS84_APPROX";
  routes: AmapRoadRoute[];
  note: string;
} | {
  state: "needs_config" | "unsupported" | "error";
  provider: "高德地图";
  message: string;
};

export type AmapConfiguration = {
  key: string;
  origin: string;
};

const strategyLabels: Record<number, string> = {
  32: "高德推荐路线",
  33: "躲避拥堵路线",
  35: "不走高速路线",
};

export const amapTravelModeLabels: Record<AmapTravelMode, string> = {
  driving: "驾车",
  walking: "步行",
  bicycling: "骑行",
  electrobike: "电动自行车",
};

export function amapConfiguration(env: NodeJS.ProcessEnv = process.env): { ready: boolean; message: string; config?: AmapConfiguration } {
  const key = env.AMAP_WEB_SERVICE_KEY?.trim() ?? "";
  if (!key) return { ready: false, message: "需要在服务端配置 AMAP_WEB_SERVICE_KEY" };
  if (!/^[a-f0-9]{32}$/i.test(key)) return { ready: false, message: "AMAP_WEB_SERVICE_KEY 格式无效" };
  return { ready: true, message: "已配置高德 Web 服务 Key", config: { key, origin: "https://restapi.amap.com" } };
}

export function isAmapDomesticRoutingCoordinate(coordinate: RoutingCoordinate) {
  const [longitude, latitude] = coordinate;
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= 73.4 && longitude <= 135.2 && latitude >= 18 && latitude <= 53.7;
}

export function buildAmapCoordinateConversionUrl(config: AmapConfiguration, coordinates: RoutingCoordinate[]) {
  if (coordinates.length < 1 || coordinates.length > 40) throw new Error("高德坐标转换每次只接受 1–40 个点");
  const url = new URL("/v3/assistant/coordinate/convert", config.origin);
  url.search = new URLSearchParams({
    key: config.key,
    locations: coordinates.map(formatCoordinate).join("|"),
    coordsys: "gps",
    output: "json",
  }).toString();
  return url.toString();
}

export function buildAmapDrivingUrl(config: AmapConfiguration, origin: RoutingCoordinate, destination: RoutingCoordinate, strategy: number) {
  if (!Object.hasOwn(strategyLabels, strategy)) throw new Error("不支持的高德算路策略");
  const url = new URL("/v5/direction/driving", config.origin);
  url.search = new URLSearchParams({
    key: config.key,
    origin: formatCoordinate(origin),
    destination: formatCoordinate(destination),
    strategy: String(strategy),
    ferry: "1",
    show_fields: "cost,tmcs,polyline",
    output: "json",
  }).toString();
  return url.toString();
}

export function buildAmapRouteUrl(config: AmapConfiguration, origin: RoutingCoordinate, destination: RoutingCoordinate, mode: AmapTravelMode, strategy = 32) {
  if (mode === "driving") return buildAmapDrivingUrl(config, origin, destination, strategy);
  const url = new URL(`/v5/direction/${mode}`, config.origin);
  url.search = new URLSearchParams({
    key: config.key,
    origin: formatCoordinate(origin),
    destination: formatCoordinate(destination),
    alternative_route: "3",
    show_fields: "cost,polyline",
    output: "json",
  }).toString();
  return url.toString();
}

export function parseAmapConvertedCoordinates(payload: unknown, expectedCount: number): RoutingCoordinate[] {
  const record = asRecord(payload, "高德坐标转换响应无效");
  if (String(record.status ?? "") !== "1") throw new Error(amapFailure(record, "高德坐标转换失败"));
  const text = typeof record.locations === "string" ? record.locations : "";
  const coordinates = text.split(";").map(parseCoordinate).filter((value): value is RoutingCoordinate => Boolean(value));
  if (coordinates.length !== expectedCount) throw new Error("高德坐标转换返回点数不一致");
  return coordinates;
}

export function parseAmapDriving(payload: unknown, strategy: number, routeIndex = 0): AmapRoadRoute {
  return parseAmapRoute(payload, "driving", strategy, routeIndex);
}

export function parseAmapRoute(payload: unknown, mode: AmapTravelMode, strategy = 32, routeIndex = 0): AmapRoadRoute {
  const record = asRecord(payload, "高德路径规划响应无效");
  if (String(record.status ?? "") !== "1") throw new Error(amapFailure(record, "高德路径规划失败"));
  const route = asRecord(record.route, "高德路径规划缺少 route");
  const paths = Array.isArray(route.paths) ? route.paths : [];
  const path = asRecord(paths[routeIndex], "高德没有返回可用道路路线");
  const steps = Array.isArray(path.steps) ? path.steps.map((value) => asRecord(value, "高德道路分段无效")) : [];
  const gcjCoordinates = deduplicateCoordinates(steps.flatMap((step) => parsePolyline(step.polyline)));
  if (gcjCoordinates.length < 2) throw new Error("高德道路路线缺少有效折线");
  const wgs84Coordinates = capCoordinates(simplifyCoordinates(gcjCoordinates.map(gcj02ToWgs84), 0.012), 2_000);
  if (wgs84Coordinates.length < 2) throw new Error("高德道路路线坐标转换失败");

  const cost = isRecord(path.cost) ? path.cost : {};
  const distanceKm = finiteNumber(path.distance) / 1_000;
  const durationSeconds = finiteNumber(cost.duration) || steps.reduce((sum, step) => sum + finiteNumber(isRecord(step.cost) ? step.cost.duration : undefined), 0);
  const roadNames = [...new Set(steps.map((step) => cleanText(step.road_name, 80)).filter(Boolean))].slice(0, 24);
  const traffic: AmapTrafficSummary = { unknownKm: 0, smoothKm: 0, slowKm: 0, congestedKm: 0, severeCongestionKm: 0 };
  for (const step of steps) {
    const tmcs = Array.isArray(step.tmcs) ? step.tmcs : [];
    for (const item of tmcs) {
      if (!isRecord(item)) continue;
      const distance = finiteNumber(item.tmc_distance) / 1_000;
      const status = cleanText(item.tmc_status, 20);
      if (status === "畅通") traffic.smoothKm += distance;
      else if (status === "缓行") traffic.slowKm += distance;
      else if (status === "拥堵") traffic.congestedKm += distance;
      else if (status === "严重拥堵") traffic.severeCongestionKm += distance;
      else traffic.unknownKm += distance;
    }
  }
  for (const key of Object.keys(traffic) as Array<keyof AmapTrafficSummary>) traffic[key] = round(traffic[key], 1);
  return {
    routeId: `amap-${mode}-${strategy}-${routeIndex + 1}`,
    label: mode === "driving" ? strategyLabels[strategy] ?? `高德驾车路线 ${routeIndex + 1}` : `${amapTravelModeLabels[mode]}候选 ${routeIndex + 1}`,
    mode,
    strategy,
    coordinates: wgs84Coordinates,
    distanceKm: round(distanceKm > 0 ? distanceKm : polylineDistanceKm(wgs84Coordinates), 1),
    estimatedMinutes: Math.max(1, Math.round(durationSeconds > 0 ? durationSeconds / 60 : polylineDistanceKm(wgs84Coordinates) / 35 * 60)),
    restriction: String(path.restriction ?? "0") === "1",
    tollsYuan: round(finiteNumber(cost.tolls), 1),
    trafficLights: Math.max(0, Math.round(finiteNumber(cost.traffic_lights))),
    roadNames,
    traffic,
  };
}

export function parseAmapRouteAlternatives(payload: unknown, mode: Exclude<AmapTravelMode, "driving">) {
  const record = asRecord(payload, "高德路径规划响应无效");
  if (String(record.status ?? "") !== "1") throw new Error(amapFailure(record, "高德路径规划失败"));
  const route = asRecord(record.route, "高德路径规划缺少 route");
  const paths = Array.isArray(route.paths) ? route.paths : [];
  if (!paths.length) throw new Error("高德没有返回可用道路路线");
  return paths.slice(0, 3).map((_, index) => parseAmapRoute(payload, mode, 0, index));
}

export function deduplicateAmapRoutes(routes: AmapRoadRoute[]) {
  const output: AmapRoadRoute[] = [];
  for (const route of routes) {
    const duplicate = output.some((candidate) => {
      const distanceDifference = Math.abs(candidate.distanceKm - route.distanceKm);
      const candidateMidpoint = candidate.coordinates[Math.floor(candidate.coordinates.length / 2)];
      const routeMidpoint = route.coordinates[Math.floor(route.coordinates.length / 2)];
      return distanceDifference <= Math.max(0.15, candidate.distanceKm * 0.01) && haversineKm(candidateMidpoint, routeMidpoint) < 0.25;
    });
    if (!duplicate) output.push(route);
  }
  return output.slice(0, 3);
}

export function gcj02ToWgs84(coordinate: RoutingCoordinate): RoutingCoordinate {
  if (outsideChina(coordinate)) return [...coordinate];
  let estimate: RoutingCoordinate = [...coordinate];
  for (let index = 0; index < 4; index += 1) {
    const projected = wgs84ToGcj02(estimate);
    estimate = [estimate[0] + coordinate[0] - projected[0], estimate[1] + coordinate[1] - projected[1]];
  }
  return [round(estimate[0], 6), round(estimate[1], 6)];
}

export function wgs84ToGcj02(coordinate: RoutingCoordinate): RoutingCoordinate {
  if (outsideChina(coordinate)) return [...coordinate];
  const [longitude, latitude] = coordinate;
  let latitudeDelta = transformLatitude(longitude - 105, latitude - 35);
  let longitudeDelta = transformLongitude(longitude - 105, latitude - 35);
  const latitudeRadians = latitude / 180 * Math.PI;
  let magic = Math.sin(latitudeRadians);
  magic = 1 - 0.006693421622965943 * magic * magic;
  const rootMagic = Math.sqrt(magic);
  latitudeDelta = latitudeDelta * 180 / ((6_378_245 * (1 - 0.006693421622965943)) / (magic * rootMagic) * Math.PI);
  longitudeDelta = longitudeDelta * 180 / (6_378_245 / rootMagic * Math.cos(latitudeRadians) * Math.PI);
  return [longitude + longitudeDelta, latitude + latitudeDelta];
}

function transformLatitude(longitude: number, latitude: number) {
  let result = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude ** 2 + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude));
  result += (20 * Math.sin(6 * longitude * Math.PI) + 20 * Math.sin(2 * longitude * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(latitude * Math.PI) + 40 * Math.sin(latitude / 3 * Math.PI)) * 2 / 3;
  result += (160 * Math.sin(latitude / 12 * Math.PI) + 320 * Math.sin(latitude * Math.PI / 30)) * 2 / 3;
  return result;
}

function transformLongitude(longitude: number, latitude: number) {
  let result = 300 + longitude + 2 * latitude + 0.1 * longitude ** 2 + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude));
  result += (20 * Math.sin(6 * longitude * Math.PI) + 20 * Math.sin(2 * longitude * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(longitude * Math.PI) + 40 * Math.sin(longitude / 3 * Math.PI)) * 2 / 3;
  result += (150 * Math.sin(longitude / 12 * Math.PI) + 300 * Math.sin(longitude / 30 * Math.PI)) * 2 / 3;
  return result;
}

function outsideChina([longitude, latitude]: RoutingCoordinate) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function parsePolyline(value: unknown) {
  if (typeof value !== "string") return [];
  return value.split(";").map(parseCoordinate).filter((coordinate): coordinate is RoutingCoordinate => Boolean(coordinate));
}

function parseCoordinate(value: string): RoutingCoordinate | null {
  const parts = value.trim().split(",");
  if (parts.length !== 2) return null;
  const longitude = Number(parts[0]);
  const latitude = Number(parts[1]);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  return [longitude, latitude];
}

function formatCoordinate(coordinate: RoutingCoordinate) {
  const parsed = parseCoordinate(`${coordinate[0]},${coordinate[1]}`);
  if (!parsed) throw new Error("高德算路坐标无效");
  return `${parsed[0].toFixed(6)},${parsed[1].toFixed(6)}`;
}

function simplifyCoordinates(coordinates: RoutingCoordinate[], toleranceKm: number) {
  if (coordinates.length <= 2) return coordinates;
  const keep = new Set([0, coordinates.length - 1]);
  const stack: Array<[number, number]> = [[0, coordinates.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let furthest = 0;
    let furthestIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistanceKm(coordinates[index], coordinates[start], coordinates[end]);
      if (distance > furthest) { furthest = distance; furthestIndex = index; }
    }
    if (furthestIndex > start && furthest > toleranceKm) {
      keep.add(furthestIndex);
      stack.push([start, furthestIndex], [furthestIndex, end]);
    }
  }
  return coordinates.filter((_, index) => keep.has(index));
}

function capCoordinates(coordinates: RoutingCoordinate[], maximum: number) {
  if (coordinates.length <= maximum) return coordinates;
  const output: RoutingCoordinate[] = [coordinates[0]];
  const step = (coordinates.length - 1) / (maximum - 1);
  for (let index = 1; index < maximum - 1; index += 1) output.push(coordinates[Math.round(index * step)]);
  output.push(coordinates.at(-1)!);
  return deduplicateCoordinates(output);
}

function deduplicateCoordinates(coordinates: RoutingCoordinate[]) {
  return coordinates.filter((coordinate, index) => index === 0 || coordinate[0] !== coordinates[index - 1][0] || coordinate[1] !== coordinates[index - 1][1]);
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

function polylineDistanceKm(coordinates: RoutingCoordinate[]) {
  return coordinates.slice(1).reduce((sum, coordinate, index) => sum + haversineKm(coordinates[index], coordinate), 0);
}

function haversineKm(start: RoutingCoordinate, end: RoutingCoordinate) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(end[1] - start[1]);
  const longitudeDelta = radians(end[0] - start[0]);
  const startLatitude = radians(start[1]);
  const endLatitude = radians(end[1]);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function amapFailure(record: Record<string, unknown>, fallback: string) {
  const info = cleanText(record.info, 120);
  const code = cleanText(record.infocode, 30);
  return `${fallback}${info ? `：${info}` : ""}${code ? `（${code}）` : ""}`;
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum) : "";
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
