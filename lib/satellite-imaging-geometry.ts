import { normalizeAntimeridianGeometry } from "./geo-geometry.ts";
import { propagateTle } from "./orbit-simulation.ts";
import type { SarLookSide } from "./satellite-payloads.ts";
import type { GeoGeometry } from "./task-aoi.ts";

const EARTH_RADIUS_KM = 6371.0088;

export type ReachableImagingCorridor = {
  geometry: GeoGeometry;
  nearGroundRangeKm: number;
  farGroundRangeKm: number;
  lookSides: SarLookSide[];
  sampledFrom: string;
  sampledTo: string;
  sampleCount: number;
  basis: "tle_sgp4_incidence_envelope";
};

export type InstantaneousReachableSlice = ReachableImagingCorridor & {
  centeredAt: string;
  displaySpanSeconds: number;
};

/**
 * Builds a time-local ground-access envelope, not an antenna beam pattern.
 * Each side is the strip swept between the near/far incidence limits while
 * the TLE subpoint moves through the selected acquisition interval.
 */
export function buildReachableImagingCorridor(input: {
  tleLine1: string;
  tleLine2: string;
  start: string | Date;
  end: string | Date;
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
  lookSides: readonly SarLookSide[];
  stepSeconds?: number;
}): ReachableImagingCorridor | null {
  const requestedStart = new Date(input.start).getTime();
  const requestedEnd = new Date(input.end).getTime();
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd <= requestedStart) return null;
  const startMs = requestedStart;
  const endMs = Math.min(requestedEnd, requestedStart + 15 * 60_000);
  const incidenceMin = clamp(input.incidenceAngleMinDeg, 0.1, 80);
  const incidenceMax = clamp(input.incidenceAngleMaxDeg, incidenceMin, 80);
  const lookSides = [...new Set(input.lookSides)].filter((side): side is SarLookSide => side === "left" || side === "right");
  if (!lookSides.length) return null;

  const durationSeconds = Math.max(1, (endMs - startMs) / 1_000);
  const stepSeconds = clamp(input.stepSeconds ?? Math.ceil(durationSeconds / 12), 1, 30);
  const sampleTimes = new Set<number>([startMs, endMs]);
  for (let at = startMs; at < endMs; at += stepSeconds * 1_000) sampleTimes.add(at);
  const samples = [...sampleTimes]
    .sort((left, right) => left - right)
    .slice(0, 64)
    .map((at) => propagateTle(input.tleLine1, input.tleLine2, new Date(at)))
    .filter((position): position is NonNullable<ReturnType<typeof propagateTle>> => Boolean(position));
  if (samples.length < 2) return null;

  const polygons: Array<Array<Array<[number, number]>>> = [];
  for (const side of lookSides) {
    const far: Array<[number, number]> = [];
    const near: Array<[number, number]> = [];
    for (let index = 0; index < samples.length; index += 1) {
      const position = samples[index];
      const previous = samples[Math.max(0, index - 1)];
      const next = samples[Math.min(samples.length - 1, index + 1)];
      const bearing = initialBearing(previous.latitude, previous.longitude, next.latitude, next.longitude);
      const sideBearing = bearing + (side === "right" ? 90 : -90);
      near.push(destinationPoint(position.latitude, position.longitude, sideBearing, groundReachForIncidence(position.altitudeKm, incidenceMin)));
      far.push(destinationPoint(position.latitude, position.longitude, sideBearing, groundReachForIncidence(position.altitudeKm, incidenceMax)));
    }
    const ring = [...far, ...near.reverse(), far[0]];
    const normalized = normalizeAntimeridianGeometry({ type: "Polygon", coordinates: [ring] });
    if (!normalized) continue;
    if (normalized.type === "Polygon") polygons.push(normalized.coordinates as Array<Array<[number, number]>>);
    else if (normalized.type === "MultiPolygon") polygons.push(...normalized.coordinates as Array<Array<Array<[number, number]>>>);
  }
  if (!polygons.length) return null;

  const midpoint = samples[Math.floor(samples.length / 2)];
  return {
    geometry: polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons },
    nearGroundRangeKm: round(groundReachForIncidence(midpoint.altitudeKm, incidenceMin), 1),
    farGroundRangeKm: round(groundReachForIncidence(midpoint.altitudeKm, incidenceMax), 1),
    lookSides,
    sampledFrom: new Date(startMs).toISOString(),
    sampledTo: new Date(endMs).toISOString(),
    sampleCount: samples.length,
    basis: "tle_sgp4_incidence_envelope",
  };
}

/**
 * Builds a short, moving cross-track slice for pass playback. The short
 * along-track span is deliberately labelled as a display slice: it shows
 * where the incidence envelope is at one moment, not an antenna beam pattern
 * or an executed image footprint.
 */
export function buildInstantaneousReachableSlice(input: {
  tleLine1: string;
  tleLine2: string;
  at: string | Date;
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
  lookSides: readonly SarLookSide[];
  displaySpanSeconds?: number;
}): InstantaneousReachableSlice | null {
  const centeredAtMs = new Date(input.at).getTime();
  if (!Number.isFinite(centeredAtMs)) return null;
  const displaySpanSeconds = clamp(input.displaySpanSeconds ?? 4, 1, 10);
  const halfSpanMs = displaySpanSeconds * 500;
  const corridor = buildReachableImagingCorridor({
    tleLine1: input.tleLine1,
    tleLine2: input.tleLine2,
    start: new Date(centeredAtMs - halfSpanMs),
    end: new Date(centeredAtMs + halfSpanMs),
    incidenceAngleMinDeg: input.incidenceAngleMinDeg,
    incidenceAngleMaxDeg: input.incidenceAngleMaxDeg,
    lookSides: input.lookSides,
    stepSeconds: Math.max(1, Math.ceil(displaySpanSeconds / 2)),
  });
  return corridor ? {
    ...corridor,
    centeredAt: new Date(centeredAtMs).toISOString(),
    displaySpanSeconds,
  } : null;
}

export function groundReachForIncidence(altitudeKm: number, incidenceAngleDeg: number) {
  const orbitalRadius = EARTH_RADIUS_KM + altitudeKm;
  const incidence = incidenceAngleDeg * Math.PI / 180;
  const slantRange = -EARTH_RADIUS_KM * Math.cos(incidence) + Math.sqrt(Math.max(0, orbitalRadius ** 2 - EARTH_RADIUS_KM ** 2 * Math.sin(incidence) ** 2));
  const centralAngle = Math.atan2(slantRange * Math.sin(incidence), EARTH_RADIUS_KM + slantRange * Math.cos(incidence));
  return EARTH_RADIUS_KM * centralAngle;
}

function destinationPoint(latitude: number, longitude: number, bearingDeg: number, distanceKm: number): [number, number] {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearing = bearingDeg * Math.PI / 180;
  const latitudeRad = latitude * Math.PI / 180;
  const longitudeRad = longitude * Math.PI / 180;
  const targetLatitude = Math.asin(Math.sin(latitudeRad) * Math.cos(angularDistance) + Math.cos(latitudeRad) * Math.sin(angularDistance) * Math.cos(bearing));
  const targetLongitude = longitudeRad + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRad), Math.cos(angularDistance) - Math.sin(latitudeRad) * Math.sin(targetLatitude));
  return [round(normalizeLongitude(targetLongitude * 180 / Math.PI), 7), round(targetLatitude * 180 / Math.PI, 7)];
}

function initialBearing(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;
  const deltaLongitude = normalizeLongitude(longitude2 - longitude1) * Math.PI / 180;
  const y = Math.sin(deltaLongitude) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLongitude);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function normalizeLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
