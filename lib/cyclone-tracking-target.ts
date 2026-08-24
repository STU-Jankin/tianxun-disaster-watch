import type { CycloneTaskAoiSlice } from "./cyclone-forecast.ts";
import type { CycloneImpactFrame } from "./disasters.ts";
import type { GeoGeometry } from "./task-aoi.ts";

export const cycloneTrackingTargets = ["center", "wind_field", "uncertainty_area"] as const;
export type CycloneTrackingTarget = (typeof cycloneTrackingTargets)[number];

export function cycloneTrackingGeometry(slice: CycloneTaskAoiSlice, target: CycloneTrackingTarget): GeoGeometry | null {
  if (target === "center") return { type: "Point", coordinates: [slice.center[0], slice.center[1]] };
  const candidate = target === "wind_field" ? slice.windGeometry : slice.uncertaintyGeometry;
  return candidate && ["Polygon", "MultiPolygon"].includes(candidate.type) ? candidate as GeoGeometry : null;
}

export function cycloneTrackingSliceAt(slices: CycloneTaskAoiSlice[], at: string | Date) {
  const timestamp = new Date(at).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return slices.find((slice, index) => {
    const start = Date.parse(slice.validFrom);
    const end = Date.parse(slice.validTo);
    return timestamp >= start && (timestamp < end || index === slices.length - 1 && timestamp <= end);
  });
}

export function nearestCycloneFrameIndex(frames: CycloneImpactFrame[], at?: string) {
  if (!frames.length || !at || !Number.isFinite(Date.parse(at))) return 0;
  const target = Date.parse(at);
  return frames.reduce((bestIndex, frame, index) => Math.abs(Date.parse(frame.forecastAt) - target) < Math.abs(Date.parse(frames[bestIndex].forecastAt) - target) ? index : bestIndex, 0);
}
