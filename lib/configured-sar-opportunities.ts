import { propagateTle } from "./orbit-simulation.ts";
import { buildConservativePlannedSceneFootprint, groundReachForIncidence } from "./satellite-imaging-geometry.ts";
import type { SarImagingMode, SarPayloadProfile } from "./satellite-payloads.ts";
import type { SatelliteOrbitSnapshot } from "./satellite-orbits.ts";
import { representativeAoi, screenTleOpportunities } from "./tle-opportunities.ts";
import type { GeoGeometry } from "./task-aoi.ts";

const EARTH_RADIUS_KM = 6371.0088;
const MAXIMUM_WINDOWS = 100;

export type AssumedSarOpportunity = {
  opportunityId: string;
  satelliteId: string;
  satelliteLabel: string;
  satelliteNoradId: number;
  instrumentId: string;
  imagingMode: string;
  simulationLevel: "assumed_sensor";
  confidence: "assumed_parameters";
  parameterStatus: SarPayloadProfile["parameterStatus"];
  orbitVersion: string;
  computedAt: string;
  start: string;
  end: string;
  closestApproachAt: string;
  closestSubpoint: { latitude: number; longitude: number };
  minimumGroundTrackDistanceKm: number;
  altitudeKm: number;
  orbitDirection: "ascending" | "descending";
  lookSide: "left" | "right";
  incidenceAngleDeg: number;
  offNadirAngleDeg: number;
  coveragePercent: number;
  spatialResolutionM: number;
  spatialResolutionLabel: string;
  polarizations: string[];
  productLevels: Array<{ level: string; code: string; name: string }>;
  nominalSceneCrossTrackKm: number;
  nominalSceneAlongTrackKm: number;
  footprintGeometry: GeoGeometry;
  reachableNearKm: number;
  reachableFarKm: number;
  sceneNearEdgeKm: number;
  sceneFarEdgeKm: number;
  footprintRangeMarginKm: number;
  reachableLookSides: Array<"left" | "right">;
  reachableBasis: "tle_sgp4_incidence_envelope";
  incidenceConstraintSemantics: "full_scene_edge_hard_limit_assumed";
  searchRadiusKm: number;
  aoiRadiusKm: number;
  candidateThresholdKm: number;
  constraintNotes: string[];
};

export type AssumedSarResult = {
  schemaVersion: "tianxun.visibility.assumed-sar/v1";
  simulationLevel: "assumed_sensor";
  computedAt: string;
  satelliteCount: number;
  windows: AssumedSarOpportunity[];
  rejectedByResolution: number;
  rejectedByCoverage: number;
  rejectedByIncidence: number;
  rejectedByFootprint: number;
  rejectedByTiming: number;
};

export function screenConfiguredSarOpportunities(input: {
  geometry: GeoGeometry;
  imagingStart: string | Date;
  imagingEnd: string | Date;
  satellites: SatelliteOrbitSnapshot[];
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
  spatialResolutionMeters: number;
  minimumCoveragePercent: number;
  sarImagingModeIds?: readonly SarImagingMode["id"][];
  orbitDirectionPreference?: "ascending" | "descending" | "either";
  now?: Date;
}): AssumedSarResult {
  const satellites = input.satellites.filter((satellite) => satellite.identityStatus === "configured" && satellite.payloadProfile && satellite.orbitStatus === "current" && satellite.tleLine1 && satellite.tleLine2);
  const computedAt = (input.now ?? new Date()).toISOString();
  if (!satellites.length) throw new Error("没有同时具备当前TLE和载荷参数档案的SAR卫星");
  const coarse = screenTleOpportunities({
    geometry: input.geometry,
    imagingStart: input.imagingStart,
    imagingEnd: input.imagingEnd,
    satellites,
    orbitDirectionPreference: input.orbitDirectionPreference,
    searchRadiusKm: 1_000,
    stepSeconds: 30,
    now: input.now,
  });
  const aoi = representativeAoi(input.geometry);
  const coordinates = geometryCoordinates(input.geometry);
  let rejectedByResolution = 0;
  let rejectedByCoverage = 0;
  let rejectedByIncidence = 0;
  let rejectedByFootprint = 0;
  let rejectedByTiming = 0;
  const windows: AssumedSarOpportunity[] = [];
  const taskStartMs = new Date(input.imagingStart).getTime();
  const taskEndMs = new Date(input.imagingEnd).getTime();

  for (const candidate of coarse.windows) {
    const satellite = satellites.find((item) => item.noradId === candidate.satelliteNoradId);
    const profile = satellite?.payloadProfile;
    if (!satellite || !profile || !satellite.tleLine1 || !satellite.tleLine2) continue;
    const refined = refineClosestApproach(
      satellite.tleLine1,
      satellite.tleLine2,
      candidate.closestApproachAt,
      taskStartMs,
      taskEndMs,
      aoi.center,
    );
    if (!refined) continue;
    const requestedModes = new Set(input.sarImagingModeIds ?? []);
    const enabledModes = requestedModes.size ? profile.imagingModes.filter((mode) => requestedModes.has(mode.id)) : profile.imagingModes;
    const geometry = sarLookGeometry(refined.altitudeKm, refined.distanceKm);
    const minimumIncidence = Math.max(profile.incidenceAngleDeg.min, input.incidenceAngleMinDeg);
    const maximumIncidence = Math.min(profile.incidenceAngleDeg.max, input.incidenceAngleMaxDeg);
    if (minimumIncidence > maximumIncidence || geometry.incidenceAngleDeg < minimumIncidence || geometry.incidenceAngleDeg > maximumIncidence) {
      rejectedByIncidence += enabledModes.length;
      continue;
    }
    const track = trackGeometry(satellite.tleLine1, satellite.tleLine2, refined.at, refined, aoi.center);
    if (!profile.lookSides.includes(track.lookSide)) {
      rejectedByIncidence += enabledModes.length;
      continue;
    }
    const extents = aoiExtents(coordinates, aoi.center, track.bearingDeg);
    const groundSpeedKmS = track.groundSpeedKmS > 0.1 ? track.groundSpeedKmS : 7.5;
    const maximumReachKm = groundReachForIncidence(refined.altitudeKm, profile.incidenceAngleDeg.max);
    const reachableNearKm = groundReachForIncidence(refined.altitudeKm, minimumIncidence);
    const reachableFarKm = groundReachForIncidence(refined.altitudeKm, maximumIncidence);
    for (const mode of enabledModes) {
      if (mode.resolutionM > input.spatialResolutionMeters) { rejectedByResolution += 1; continue; }
      const sceneRange = evaluateSceneRangeFeasibility({
        altitudeKm: refined.altitudeKm,
        sceneCenterGroundRangeKm: refined.distanceKm,
        sceneCrossTrackKm: mode.nominalSceneCrossTrackKm,
        incidenceAngleMinDeg: minimumIncidence,
        incidenceAngleMaxDeg: maximumIncidence,
      });
      if (!sceneRange.fullyWithinEnvelope) { rejectedByFootprint += 1; continue; }
      const coveragePercent = estimatedCoveragePercent(extents, mode);
      if (coveragePercent < input.minimumCoveragePercent) { rejectedByCoverage += 1; continue; }
      const durationSeconds = Math.max(0.1, mode.nominalSceneAlongTrackKm / groundSpeedKmS);
      const centerMs = Date.parse(refined.at);
      const startMs = centerMs - durationSeconds * 500;
      const endMs = centerMs + durationSeconds * 500;
      if (startMs < taskStartMs || endMs > taskEndMs || endMs <= startMs) {
        rejectedByTiming += 1;
        continue;
      }
      const plannedFootprint = buildConservativePlannedSceneFootprint({
        tleLine1: satellite.tleLine1,
        tleLine2: satellite.tleLine2,
        start: new Date(startMs),
        end: new Date(endMs),
        lookSide: track.lookSide,
        sceneCenterGroundRangeKm: refined.distanceKm,
        sceneCrossTrackKm: mode.nominalSceneCrossTrackKm,
        incidenceAngleMinDeg: minimumIncidence,
        incidenceAngleMaxDeg: maximumIncidence,
      });
      if (!plannedFootprint || !plannedFootprint.fullyWithinIncidenceEnvelope) {
        rejectedByFootprint += 1;
        continue;
      }
      const footprintGeometry = plannedFootprint.geometry;
      const footprintRangeMarginKm = Math.min(sceneRange.minimumMarginKm, plannedFootprint.minimumBoundaryMarginKm);
      const modeToken = mode.id.replace(/[^a-z0-9_]/gi, "").toUpperCase();
      windows.push({
        opportunityId: `ASSUMED-${candidate.satelliteNoradId}-${refined.at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${modeToken}`,
        satelliteId: candidate.satelliteId,
        satelliteLabel: candidate.satelliteLabel,
        satelliteNoradId: candidate.satelliteNoradId,
        instrumentId: profile.id,
        imagingMode: mode.name,
        simulationLevel: "assumed_sensor",
        confidence: "assumed_parameters",
        parameterStatus: profile.parameterStatus,
        orbitVersion: `${candidate.orbitVersion}:payload:${profile.id}`,
        computedAt,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        closestApproachAt: refined.at,
        closestSubpoint: { latitude: round(refined.latitude, 6), longitude: round(refined.longitude, 6) },
        minimumGroundTrackDistanceKm: round(refined.distanceKm, 1),
        altitudeKm: round(refined.altitudeKm, 1),
        orbitDirection: refined.direction,
        lookSide: track.lookSide,
        incidenceAngleDeg: round(geometry.incidenceAngleDeg, 2),
        offNadirAngleDeg: round(geometry.offNadirAngleDeg, 2),
        coveragePercent: round(coveragePercent, 1),
        spatialResolutionM: mode.resolutionM,
        spatialResolutionLabel: mode.resolutionLabel,
        polarizations: [...profile.polarizations],
        productLevels: profile.productLevels.map((product) => ({ ...product })),
        nominalSceneCrossTrackKm: mode.nominalSceneCrossTrackKm,
        nominalSceneAlongTrackKm: mode.nominalSceneAlongTrackKm,
        footprintGeometry,
        reachableNearKm: round(reachableNearKm, 1),
        reachableFarKm: round(reachableFarKm, 1),
        sceneNearEdgeKm: round(sceneRange.sceneNearEdgeKm, 1),
        sceneFarEdgeKm: round(sceneRange.sceneFarEdgeKm, 1),
        footprintRangeMarginKm: round(footprintRangeMarginKm, 1),
        reachableLookSides: [track.lookSide],
        reachableBasis: "tle_sgp4_incidence_envelope",
        incidenceConstraintSemantics: "full_scene_edge_hard_limit_assumed",
        searchRadiusKm: round(maximumReachKm, 1),
        aoiRadiusKm: candidate.aoiRadiusKm,
        candidateThresholdKm: round(maximumReachKm + candidate.aoiRadiusKm, 1),
        constraintNotes: [
          profile.parameterNote,
          `已按保守硬约束逐轨道采样验证整幅场景：近端/远端横轨地距 ${round(sceneRange.sceneNearEdgeKm, 1)}–${round(sceneRange.sceneFarEdgeKm, 1)} km 均位于入射角允许范围 ${round(reachableNearKm, 1)}–${round(reachableFarKm, 1)} km 内，最小边界余量 ${round(footprintRangeMarginKm, 1)} km。`,
          "覆盖率按以AOI为中心、与轨向对齐的标称矩形场景包络估算；入射角范围暂按整景边缘硬限制解释，待真实近端/远端波位表接入后必须替换。",
          "已按球形地球换算地面入射角与卫星离轴角；尚未验证姿态角速度、角加速度、稳定时间、功耗、存储和热控。",
          "该结果属于假设传感器模型，只能用于试排程，不得自动下发。",
        ],
      });
    }
  }

  windows.sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || left.spatialResolutionM - right.spatialResolutionM || right.coveragePercent - left.coveragePercent);
  return {
    schemaVersion: "tianxun.visibility.assumed-sar/v1",
    simulationLevel: "assumed_sensor",
    computedAt,
    satelliteCount: satellites.length,
    windows: windows.slice(0, MAXIMUM_WINDOWS),
    rejectedByResolution,
    rejectedByCoverage,
    rejectedByIncidence,
    rejectedByFootprint,
    rejectedByTiming,
  };
}

export function sarLookGeometry(altitudeKm: number, groundDistanceKm: number) {
  const orbitalRadius = EARTH_RADIUS_KM + altitudeKm;
  const centralAngle = Math.max(0, groundDistanceKm) / EARTH_RADIUS_KM;
  const incidenceAngleDeg = Math.atan2(orbitalRadius * Math.sin(centralAngle), orbitalRadius * Math.cos(centralAngle) - EARTH_RADIUS_KM) * 180 / Math.PI;
  const offNadirAngleDeg = Math.atan2(EARTH_RADIUS_KM * Math.sin(centralAngle), orbitalRadius - EARTH_RADIUS_KM * Math.cos(centralAngle)) * 180 / Math.PI;
  return { incidenceAngleDeg, offNadirAngleDeg };
}

export { groundReachForIncidence } from "./satellite-imaging-geometry.ts";

export function evaluateSceneRangeFeasibility(input: {
  altitudeKm: number;
  sceneCenterGroundRangeKm: number;
  sceneCrossTrackKm: number;
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
}) {
  const reachableNearKm = groundReachForIncidence(input.altitudeKm, input.incidenceAngleMinDeg);
  const reachableFarKm = groundReachForIncidence(input.altitudeKm, input.incidenceAngleMaxDeg);
  const halfWidthKm = Math.max(0, input.sceneCrossTrackKm) / 2;
  const sceneNearEdgeKm = Math.max(0, input.sceneCenterGroundRangeKm - halfWidthKm);
  const sceneFarEdgeKm = input.sceneCenterGroundRangeKm + halfWidthKm;
  const nearMarginKm = sceneNearEdgeKm - reachableNearKm;
  const farMarginKm = reachableFarKm - sceneFarEdgeKm;
  const toleranceKm = 0.01;
  return {
    reachableNearKm,
    reachableFarKm,
    sceneNearEdgeKm,
    sceneFarEdgeKm,
    nearEdgeIncidenceAngleDeg: sarLookGeometry(input.altitudeKm, sceneNearEdgeKm).incidenceAngleDeg,
    farEdgeIncidenceAngleDeg: sarLookGeometry(input.altitudeKm, sceneFarEdgeKm).incidenceAngleDeg,
    nearMarginKm,
    farMarginKm,
    minimumMarginKm: Math.min(nearMarginKm, farMarginKm),
    fullyWithinEnvelope: nearMarginKm >= -toleranceKm && farMarginKm >= -toleranceKm,
  };
}

function refineClosestApproach(
  tleLine1: string,
  tleLine2: string,
  coarseAt: string,
  taskStartMs: number,
  taskEndMs: number,
  target: { latitude: number; longitude: number },
) {
  const coarseMs = Date.parse(coarseAt);
  if (!Number.isFinite(coarseMs)) return null;
  let fromMs = Math.max(taskStartMs, coarseMs - 30_000);
  let toMs = Math.min(taskEndMs, coarseMs + 30_000);
  if (toMs < fromMs) return null;
  const distanceAt = (atMs: number) => {
    const position = propagateTle(tleLine1, tleLine2, new Date(atMs));
    return position ? { ...position, distanceKm: distanceKm(position.latitude, position.longitude, target.latitude, target.longitude) } : null;
  };
  for (let iteration = 0; iteration < 22 && toMs - fromMs > 100; iteration += 1) {
    const third = (toMs - fromMs) / 3;
    const leftMs = fromMs + third;
    const rightMs = toMs - third;
    const left = distanceAt(leftMs);
    const right = distanceAt(rightMs);
    if (!left || !right) break;
    if (left.distanceKm <= right.distanceKm) toMs = rightMs;
    else fromMs = leftMs;
  }
  const candidates = [fromMs, (fromMs + toMs) / 2, toMs, coarseMs]
    .map(distanceAt)
    .filter((value): value is NonNullable<ReturnType<typeof distanceAt>> => Boolean(value));
  if (!candidates.length) return null;
  return candidates.reduce((best, value) => value.distanceKm < best.distanceKm ? value : best, candidates[0]);
}

function trackGeometry(tleLine1: string, tleLine2: string, at: string, subpoint: { latitude: number; longitude: number }, target: { latitude: number; longitude: number }) {
  const centerMs = Date.parse(at);
  const before = propagateTle(tleLine1, tleLine2, new Date(centerMs - 10_000));
  const after = propagateTle(tleLine1, tleLine2, new Date(centerMs + 10_000));
  const bearingDeg = before && after ? initialBearing(before.latitude, before.longitude, after.latitude, after.longitude) : 0;
  const targetBearing = initialBearing(subpoint.latitude, subpoint.longitude, target.latitude, target.longitude);
  const sideDelta = normalizeAngle(targetBearing - bearingDeg);
  const lookSide = sideDelta >= 0 ? "right" as const : "left" as const;
  const groundSpeedKmS = before && after ? distanceKm(before.latitude, before.longitude, after.latitude, after.longitude) / 20 : 7.5;
  return { bearingDeg, lookSide, groundSpeedKmS };
}

function aoiExtents(coordinates: Array<[number, number]>, center: { latitude: number; longitude: number }, bearingDeg: number) {
  const bearing = bearingDeg * Math.PI / 180;
  const along: number[] = [];
  const cross: number[] = [];
  for (const [longitude, latitude] of coordinates) {
    const east = EARTH_RADIUS_KM * Math.cos(center.latitude * Math.PI / 180) * normalizeLongitude(longitude - center.longitude) * Math.PI / 180;
    const north = EARTH_RADIUS_KM * (latitude - center.latitude) * Math.PI / 180;
    along.push(east * Math.sin(bearing) + north * Math.cos(bearing));
    cross.push(east * Math.cos(bearing) - north * Math.sin(bearing));
  }
  return {
    alongTrackKm: Math.max(0.1, Math.max(...along) - Math.min(...along)),
    crossTrackKm: Math.max(0.1, Math.max(...cross) - Math.min(...cross)),
  };
}

function estimatedCoveragePercent(extents: ReturnType<typeof aoiExtents>, mode: SarImagingMode) {
  const alongFraction = Math.min(1, mode.nominalSceneAlongTrackKm / extents.alongTrackKm);
  const crossFraction = Math.min(1, mode.nominalSceneCrossTrackKm / extents.crossTrackKm);
  return Math.max(0, Math.min(100, alongFraction * crossFraction * 100));
}

function geometryCoordinates(geometry: GeoGeometry) {
  const result: Array<[number, number]> = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      result.push([Number(value[0]), Number(value[1])]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  if (!result.length) throw new Error("AOI几何没有有效坐标");
  return result;
}

function initialBearing(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;
  const deltaLon = normalizeLongitude(longitude2 - longitude1) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function distanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = normalizeLongitude(longitude2 - longitude1) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function normalizeAngle(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function normalizeLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
