import { propagateTle, type GroundPosition } from "./orbit-simulation.ts";
import type { SatelliteOrbitSnapshot } from "./satellite-orbits.ts";
import type { GeoGeometry } from "./task-aoi.ts";

const EARTH_RADIUS_KM = 6371.0088;
const MAXIMUM_HORIZON_HOURS = 14 * 24;
const MAXIMUM_TOTAL_SAMPLES = 100_000;
const MAXIMUM_WINDOWS = 100;

export type TleScreeningOpportunity = {
  opportunityId: string;
  satelliteId: string;
  satelliteLabel: string;
  satelliteNoradId: number;
  identityStatus: SatelliteOrbitSnapshot["identityStatus"];
  imagingMode: "TLE轨道级粗筛";
  simulationLevel: "orbit_only";
  confidence: "screening_only";
  orbitVersion: string;
  computedAt: string;
  start: string;
  end: string;
  closestApproachAt: string;
  closestSubpoint: { latitude: number; longitude: number };
  minimumGroundTrackDistanceKm: number;
  altitudeKm: number;
  orbitDirection: GroundPosition["direction"];
  searchRadiusKm: number;
  aoiRadiusKm: number;
  candidateThresholdKm: number;
  constraintNotes: string[];
};

export type TleScreeningResult = {
  schemaVersion: "tianxun.visibility.tle-screening/v1";
  simulationLevel: "orbit_only";
  computedAt: string;
  searchRadiusKm: number;
  aoiCenter: { latitude: number; longitude: number };
  aoiRadiusKm: number;
  stepSeconds: number;
  satelliteCount: number;
  windows: TleScreeningOpportunity[];
};

export function screenTleOpportunities(input: {
  geometry: GeoGeometry;
  imagingStart: string | Date;
  imagingEnd: string | Date;
  satellites: SatelliteOrbitSnapshot[];
  orbitDirectionPreference?: "ascending" | "descending" | "either";
  searchRadiusKm?: number;
  stepSeconds?: number;
  now?: Date;
}): TleScreeningResult {
  const start = new Date(input.imagingStart);
  const end = new Date(input.imagingEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("轨道粗筛需要有效且递增的 UTC 时间窗");
  const horizonHours = (end.getTime() - start.getTime()) / 3_600_000;
  if (horizonHours > MAXIMUM_HORIZON_HOURS) throw new Error(`本地 TLE 粗筛的单次时间窗不能超过 ${MAXIMUM_HORIZON_HOURS / 24} 天`);
  const satellites = input.satellites.filter((satellite) => satellite.orbitStatus === "current" && satellite.tleLine1 && satellite.tleLine2);
  if (!satellites.length) throw new Error("没有可用于仿真的当前 TLE；请先刷新卫星轨道缓存");
  const aoi = representativeAoi(input.geometry);
  const searchRadiusKm = boundedNumber(input.searchRadiusKm, 50, 1_000, 350);
  const requestedStep = boundedNumber(input.stepSeconds, 15, 300, horizonHours <= 72 ? 60 : 120);
  const durationSeconds = (end.getTime() - start.getTime()) / 1_000;
  const sampleBudgetStep = Math.ceil(durationSeconds * satellites.length / MAXIMUM_TOTAL_SAMPLES);
  const stepSeconds = Math.max(requestedStep, sampleBudgetStep);
  const computedAt = (input.now ?? new Date()).toISOString();
  const directionPreference = input.orbitDirectionPreference ?? "either";
  const windows = satellites.flatMap((satellite) => screenSatellite({
    satellite,
    start,
    end,
    stepSeconds,
    searchRadiusKm,
    aoi,
    directionPreference,
    computedAt,
  })).sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || left.minimumGroundTrackDistanceKm - right.minimumGroundTrackDistanceKm).slice(0, MAXIMUM_WINDOWS);
  return {
    schemaVersion: "tianxun.visibility.tle-screening/v1",
    simulationLevel: "orbit_only",
    computedAt,
    searchRadiusKm,
    aoiCenter: aoi.center,
    aoiRadiusKm: round(aoi.radiusKm, 1),
    stepSeconds,
    satelliteCount: satellites.length,
    windows,
  };
}

function screenSatellite(input: {
  satellite: SatelliteOrbitSnapshot;
  start: Date;
  end: Date;
  stepSeconds: number;
  searchRadiusKm: number;
  aoi: ReturnType<typeof representativeAoi>;
  directionPreference: "ascending" | "descending" | "either";
  computedAt: string;
}) {
  const { satellite, start, end, stepSeconds, searchRadiusKm, aoi, directionPreference, computedAt } = input;
  const tleLine1 = satellite.tleLine1 as string;
  const tleLine2 = satellite.tleLine2 as string;
  const thresholdKm = searchRadiusKm + aoi.radiusKm;
  const windows: TleScreeningOpportunity[] = [];
  let active: Array<GroundPosition & { distanceKm: number }> = [];
  const finalize = () => {
    if (!active.length) return;
    const coarseClosest = active.reduce((best, sample) => sample.distanceKm < best.distanceKm ? sample : best);
    const closest = refineClosest(tleLine1, tleLine2, coarseClosest, start, end, stepSeconds, aoi.center);
    if (closest.distanceKm <= thresholdKm) windows.push(toOpportunity({ satellite, active, closest, start, end, stepSeconds, searchRadiusKm, aoi, computedAt }));
    active = [];
  };
  for (let atMs = start.getTime(); atMs <= end.getTime(); atMs += stepSeconds * 1_000) {
    const position = propagateTle(tleLine1, tleLine2, new Date(atMs));
    if (!position) { finalize(); continue; }
    const distanceKm = greatCircleDistanceKm(position.latitude, position.longitude, aoi.center.latitude, aoi.center.longitude);
    const sample = { ...position, distanceKm };
    const directionAllowed = directionPreference === "either" || directionPreference === position.direction;
    const samePass = !active.length || active[active.length - 1].direction === position.direction;
    if (distanceKm <= thresholdKm && directionAllowed && samePass) active.push(sample);
    else {
      finalize();
      if (distanceKm <= thresholdKm && directionAllowed) active.push(sample);
    }
  }
  finalize();
  return windows;
}

function refineClosest(tleLine1: string, tleLine2: string, coarse: GroundPosition & { distanceKm: number }, start: Date, end: Date, stepSeconds: number, center: { latitude: number; longitude: number }) {
  let best = coarse;
  const coarseMs = Date.parse(coarse.at);
  const refinementStepSeconds = Math.max(5, Math.min(15, Math.floor(stepSeconds / 6)));
  const from = Math.max(start.getTime(), coarseMs - stepSeconds * 1_000);
  const to = Math.min(end.getTime(), coarseMs + stepSeconds * 1_000);
  for (let atMs = from; atMs <= to; atMs += refinementStepSeconds * 1_000) {
    const position = propagateTle(tleLine1, tleLine2, new Date(atMs));
    if (!position) continue;
    const distanceKm = greatCircleDistanceKm(position.latitude, position.longitude, center.latitude, center.longitude);
    if (distanceKm < best.distanceKm) best = { ...position, distanceKm };
  }
  return best;
}

function toOpportunity(input: {
  satellite: SatelliteOrbitSnapshot;
  active: Array<GroundPosition & { distanceKm: number }>;
  closest: GroundPosition & { distanceKm: number };
  start: Date;
  end: Date;
  stepSeconds: number;
  searchRadiusKm: number;
  aoi: ReturnType<typeof representativeAoi>;
  computedAt: string;
}): TleScreeningOpportunity {
  const { satellite, active, closest, start, end, stepSeconds, searchRadiusKm, aoi, computedAt } = input;
  const firstMs = Math.max(start.getTime(), Date.parse(active[0].at) - stepSeconds * 1_000);
  const lastMs = Math.min(end.getTime(), Date.parse(active[active.length - 1].at) + stepSeconds * 1_000);
  const endMs = Math.max(firstMs + 1_000, lastMs);
  const satelliteId = satellite.interfaceName || satellite.commonName;
  const satelliteLabel = satellite.interfaceName && satellite.commonName !== satellite.interfaceName ? `${satellite.interfaceName} / ${satellite.commonName}` : satelliteId;
  const closestToken = closest.at.replace(/[-:.TZ]/g, "").slice(0, 14);
  const constraintNotes = [
    "仅按 TLE/SGP4 子星点与 AOI 的保守距离做轨道近接粗筛，不代表 SAR 可成像。",
    "尚未验证真实幅宽、左右视能力、姿态机动、地面入射角、分辨率、阴影与叠掩。",
    `地图搜索圈半径 ${round(searchRadiusKm, 1)} km 是候选检索参数，不是载荷覆盖宽度。`,
  ];
  if (satellite.identityStatus === "unverified") constraintNotes.push("该卫星业务身份尚未核验，不得据此自动下发。");
  return {
    opportunityId: `TLE-${satellite.noradId}-${closestToken}-${closest.direction === "ascending" ? "A" : "D"}`,
    satelliteId,
    satelliteLabel,
    satelliteNoradId: satellite.noradId,
    identityStatus: satellite.identityStatus,
    imagingMode: "TLE轨道级粗筛",
    simulationLevel: "orbit_only",
    confidence: "screening_only",
    orbitVersion: `celestrak:${satellite.noradId}:${satellite.epoch ?? "unknown"}${satellite.orbitModel ? `:model:${satellite.orbitModel.id}` : ""}`,
    computedAt,
    start: new Date(firstMs).toISOString(),
    end: new Date(endMs).toISOString(),
    closestApproachAt: closest.at,
    closestSubpoint: { latitude: round(closest.latitude, 6), longitude: round(closest.longitude, 6) },
    minimumGroundTrackDistanceKm: round(closest.distanceKm, 1),
    altitudeKm: round(closest.altitudeKm, 1),
    orbitDirection: closest.direction,
    searchRadiusKm: round(searchRadiusKm, 1),
    aoiRadiusKm: round(aoi.radiusKm, 1),
    candidateThresholdKm: round(searchRadiusKm + aoi.radiusKm, 1),
    constraintNotes,
  };
}

export function representativeAoi(geometry: GeoGeometry) {
  const coordinates: Array<[number, number]> = [];
  collectCoordinates(geometry.coordinates, coordinates);
  if (!coordinates.length) throw new Error("AOI 几何没有有效坐标");
  const latitude = coordinates.reduce((total, point) => total + point[1], 0) / coordinates.length;
  const sin = coordinates.reduce((total, point) => total + Math.sin(point[0] * Math.PI / 180), 0);
  const cos = coordinates.reduce((total, point) => total + Math.cos(point[0] * Math.PI / 180), 0);
  const longitude = normalizeLongitude(Math.atan2(sin, cos) * 180 / Math.PI);
  const center = { latitude: round(latitude, 7), longitude: round(longitude, 7) };
  const radiusKm = coordinates.reduce((maximum, point) => Math.max(maximum, greatCircleDistanceKm(center.latitude, center.longitude, point[1], point[0])), 0);
  return { center, radiusKm };
}

function collectCoordinates(value: unknown, result: Array<[number, number]>) {
  if (result.length >= 10_000 || !Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    const longitude = Number(value[0]);
    const latitude = Number(value[1]);
    if (longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90) result.push([longitude, latitude]);
    return;
  }
  for (const child of value) collectCoordinates(child, result);
}

function greatCircleDistanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = normalizeLongitude(longitude2 - longitude1) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function normalizeLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
