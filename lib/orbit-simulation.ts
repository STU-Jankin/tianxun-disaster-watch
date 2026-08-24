import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec } from "satellite.js";

export type GroundPosition = {
  latitude: number;
  longitude: number;
  altitudeKm: number;
  direction: "ascending" | "descending";
  at: string;
};

export type GroundTrack = {
  past: Array<Array<[number, number]>>;
  future: Array<Array<[number, number]>>;
};

export function propagateTle(tleLine1: string, tleLine2: string, at = new Date()): GroundPosition | null {
  const satrec = twoline2satrec(tleLine1, tleLine2);
  if (satrec.error) return null;
  const current = propagate(satrec, at)?.position;
  if (!current || typeof current === "boolean") return null;
  const geodetic = eciToGeodetic(current, gstime(at));
  const latitude = degreesLat(geodetic.latitude);
  const longitude = normalizeLongitude(degreesLong(geodetic.longitude));
  const laterAt = new Date(at.getTime() + 10_000);
  const later = propagate(satrec, laterAt)?.position;
  let direction: GroundPosition["direction"] = "ascending";
  if (later && typeof later !== "boolean") {
    const laterLatitude = degreesLat(eciToGeodetic(later, gstime(laterAt)).latitude);
    direction = laterLatitude >= latitude ? "ascending" : "descending";
  }
  if (![latitude, longitude, geodetic.height].every(Number.isFinite)) return null;
  return { latitude, longitude, altitudeKm: geodetic.height, direction, at: at.toISOString() };
}

export function buildGroundTrack(tleLine1: string, tleLine2: string, center = new Date(), pastMinutes = 45, futureMinutes = 100, stepSeconds = 60): GroundTrack {
  const boundedStep = Math.max(15, Math.min(300, Math.round(stepSeconds)));
  const past = sampleTrack(tleLine1, tleLine2, center.getTime() - Math.max(0, pastMinutes) * 60_000, center.getTime(), boundedStep);
  const future = sampleTrack(tleLine1, tleLine2, center.getTime(), center.getTime() + Math.max(0, futureMinutes) * 60_000, boundedStep);
  return { past, future };
}

function sampleTrack(tleLine1: string, tleLine2: string, startMs: number, endMs: number, stepSeconds: number) {
  const segments: Array<Array<[number, number]>> = [];
  let segment: Array<[number, number]> = [];
  const maximumSamples = 800;
  for (let atMs = startMs, count = 0; atMs <= endMs && count < maximumSamples; atMs += stepSeconds * 1_000, count += 1) {
    const position = propagateTle(tleLine1, tleLine2, new Date(atMs));
    if (!position) continue;
    const point: [number, number] = [position.latitude, position.longitude];
    const previous = segment.at(-1);
    if (previous && Math.abs(previous[1] - point[1]) > 180) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}

function normalizeLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}
