import { screenConfiguredSarOpportunities, type AssumedSarOpportunity } from "./configured-sar-opportunities.ts";
import type { CycloneTaskAoiSlice } from "./cyclone-forecast.ts";
import {
  cycloneTrackingGeometry,
  cycloneTrackingSliceAt,
  cycloneTrackingTargets,
  type CycloneTrackingTarget,
} from "./cyclone-tracking-target.ts";
import type { SarImagingMode } from "./satellite-payloads.ts";
import type { SatelliteOrbitSnapshot } from "./satellite-orbits.ts";
import { screenTleOpportunities, type TleScreeningOpportunity } from "./tle-opportunities.ts";

export {
  cycloneTrackingGeometry,
  cycloneTrackingSliceAt,
  cycloneTrackingTargets,
};
export type { CycloneTrackingTarget };

export type CycloneTrackingMetadata = {
  trackingMode: "forecast_time_indexed";
  trackingTarget: CycloneTrackingTarget;
  trackingValidFrom: string;
  trackingValidTo: string;
  trackingLeadHours: number;
  trackingCenter: { latitude: number; longitude: number };
  trackingCenterBasis: CycloneTaskAoiSlice["centerBasis"];
  trackingThresholdKnots?: number;
  forecastAdvisoryId?: string;
};

type SharedInput = {
  slices: CycloneTaskAoiSlice[];
  target: CycloneTrackingTarget;
  imagingStart: string | Date;
  imagingEnd: string | Date;
  satellites: SatelliteOrbitSnapshot[];
  forecastAdvisoryId?: string;
  orbitDirectionPreference?: "ascending" | "descending" | "either";
  now?: Date;
};

export function screenCycloneConfiguredSarOpportunities(input: SharedInput & {
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
  spatialResolutionMeters: number;
  minimumCoveragePercent: number;
  sarImagingModeIds?: readonly SarImagingMode["id"][];
}) {
  const intervals = trackingIntervals(input);
  let rejectedByResolution = 0;
  let rejectedByCoverage = 0;
  let rejectedByIncidence = 0;
  let rejectedByFootprint = 0;
  let rejectedByTiming = 0;
  const windows: Array<AssumedSarOpportunity & CycloneTrackingMetadata> = [];
  for (const interval of intervals) {
    const result = screenConfiguredSarOpportunities({
      geometry: interval.geometry,
      imagingStart: interval.start,
      imagingEnd: interval.end,
      satellites: input.satellites,
      incidenceAngleMinDeg: input.incidenceAngleMinDeg,
      incidenceAngleMaxDeg: input.incidenceAngleMaxDeg,
      spatialResolutionMeters: input.spatialResolutionMeters,
      minimumCoveragePercent: input.minimumCoveragePercent,
      sarImagingModeIds: input.sarImagingModeIds,
      orbitDirectionPreference: input.orbitDirectionPreference,
      now: input.now,
    });
    rejectedByResolution += result.rejectedByResolution;
    rejectedByCoverage += result.rejectedByCoverage;
    rejectedByIncidence += result.rejectedByIncidence;
    rejectedByFootprint += result.rejectedByFootprint;
    rejectedByTiming += result.rejectedByTiming;
    windows.push(...result.windows.map((window) => annotateCycloneTrackingWindow(window, interval.slice, input.target, input.forecastAdvisoryId)));
  }
  return {
    schemaVersion: "tianxun.visibility.cyclone-assumed-sar/v1" as const,
    simulationLevel: "assumed_sensor" as const,
    trackingMode: "forecast_time_indexed" as const,
    trackingTarget: input.target,
    computedAt: (input.now ?? new Date()).toISOString(),
    satelliteCount: input.satellites.filter((satellite) => satellite.identityStatus === "configured" && satellite.payloadProfile && satellite.orbitStatus === "current").length,
    trackingSliceCount: intervals.length,
    windows: deduplicateTrackingWindows(windows),
    rejectedByResolution,
    rejectedByCoverage,
    rejectedByIncidence,
    rejectedByFootprint,
    rejectedByTiming,
  };
}

export function screenCycloneTleOpportunities(input: SharedInput & { searchRadiusKm?: number; stepSeconds?: number }) {
  const intervals = trackingIntervals(input);
  const windows: Array<TleScreeningOpportunity & CycloneTrackingMetadata> = [];
  for (const interval of intervals) {
    const result = screenTleOpportunities({
      geometry: interval.geometry,
      imagingStart: interval.start,
      imagingEnd: interval.end,
      satellites: input.satellites,
      orbitDirectionPreference: input.orbitDirectionPreference,
      searchRadiusKm: input.searchRadiusKm,
      stepSeconds: input.stepSeconds,
      now: input.now,
    });
    windows.push(...result.windows.map((window) => annotateCycloneTrackingWindow(window, interval.slice, input.target, input.forecastAdvisoryId)));
  }
  return {
    schemaVersion: "tianxun.visibility.cyclone-tle-screening/v1" as const,
    simulationLevel: "orbit_only" as const,
    trackingMode: "forecast_time_indexed" as const,
    trackingTarget: input.target,
    computedAt: (input.now ?? new Date()).toISOString(),
    satelliteCount: input.satellites.filter((satellite) => satellite.orbitStatus === "current" && satellite.tleLine1 && satellite.tleLine2).length,
    trackingSliceCount: intervals.length,
    windows: deduplicateTrackingWindows(windows),
  };
}

function trackingIntervals(input: SharedInput) {
  const requestedStart = new Date(input.imagingStart).getTime();
  const requestedEnd = new Date(input.imagingEnd).getTime();
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd <= requestedStart) throw new Error("台风跟踪需要有效且递增的 UTC 时间窗");
  const intervals = input.slices.flatMap((slice) => {
    const start = Math.max(requestedStart, Date.parse(slice.validFrom));
    const end = Math.min(requestedEnd, Date.parse(slice.validTo));
    const geometry = cycloneTrackingGeometry(slice, input.target);
    // The source slices are half-open [validFrom, validTo). Keeping the
    // screening end one millisecond inside the slice prevents a pass exactly
    // on an hourly boundary from being attributed to two forecast centers.
    return geometry && Number.isFinite(start) && Number.isFinite(end) && end > start + 1
      ? [{ slice, geometry, start: new Date(start), end: new Date(end - 1) }]
      : [];
  });
  if (!intervals.length) {
    const label = input.target === "wind_field" ? "风圈" : input.target === "uncertainty_area" ? "不确定区" : "预测中心";
    throw new Error(`当前成像窗内没有可用于${label}跟踪的逐时官方预测 AOI`);
  }
  return intervals;
}

export function annotateCycloneTrackingWindow<T extends { opportunityId: string; closestApproachAt: string; constraintNotes: string[] }>(window: T, slice: CycloneTaskAoiSlice, target: CycloneTrackingTarget, forecastAdvisoryId?: string): T & CycloneTrackingMetadata {
  const targetLabel = target === "center" ? "预测中心" : target === "wind_field" ? `${slice.thresholdKnots ?? "最低阈值"} kt 风圈` : "路径不确定区";
  const interpolationNote = slice.centerBasis === "official_node" ? "官方预报节点" : "相邻官方节点间逐时插值中心";
  return {
    ...window,
    opportunityId: `${window.opportunityId}-TC${slice.leadHours}-${target === "center" ? "C" : target === "wind_field" ? "W" : "U"}`.slice(0, 220),
    trackingMode: "forecast_time_indexed",
    trackingTarget: target,
    trackingValidFrom: slice.validFrom,
    trackingValidTo: slice.validTo,
    trackingLeadHours: slice.leadHours,
    trackingCenter: { longitude: slice.center[0], latitude: slice.center[1] },
    trackingCenterBasis: slice.centerBasis,
    trackingThresholdKnots: target === "wind_field" ? slice.thresholdKnots : undefined,
    forecastAdvisoryId,
    constraintNotes: [
      `按卫星过境时刻匹配台风 +${slice.leadHours}h ${targetLabel}，中心 ${slice.center[1].toFixed(3)}°, ${slice.center[0].toFixed(3)}°（${interpolationNote}）。`,
      "台风路径和风圈会随官方新报次改变；新报次到达后必须重新计算，已选机会不会自动视为继续有效。",
      ...window.constraintNotes,
    ],
  };
}

function deduplicateTrackingWindows<T extends CycloneTrackingMetadata & { satelliteNoradId: number; imagingMode?: string; orbitDirection: string; closestApproachAt: string; minimumGroundTrackDistanceKm: number; coveragePercent?: number }>(windows: T[]) {
  const ordered = [...windows].sort((left, right) => Date.parse(left.closestApproachAt) - Date.parse(right.closestApproachAt));
  const result: T[] = [];
  for (const candidate of ordered) {
    const duplicateIndex = result.findIndex((existing) => existing.satelliteNoradId === candidate.satelliteNoradId
      && existing.imagingMode === candidate.imagingMode
      && existing.orbitDirection === candidate.orbitDirection
      && Math.abs(Date.parse(existing.closestApproachAt) - Date.parse(candidate.closestApproachAt)) <= 20 * 60_000);
    if (duplicateIndex < 0) result.push(candidate);
    else if (trackingQuality(candidate) > trackingQuality(result[duplicateIndex])) result[duplicateIndex] = candidate;
  }
  return result.slice(0, 100);
}

function trackingQuality(window: { coveragePercent?: number; minimumGroundTrackDistanceKm: number }) {
  return (window.coveragePercent ?? 0) * 10_000 - window.minimumGroundTrackDistanceKm;
}
