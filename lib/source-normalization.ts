import type { DisasterEvent } from "./disasters";

export function firmsConfidenceScore(value: unknown) {
  const code = String(value ?? "").trim().toLowerCase();
  if (code === "h") return 90;
  if (code === "n") return 60;
  if (code === "l") return 30;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
}

export function firmsHeatSeverity(frpMw: number): DisasterEvent["severity"] {
  // FIRMS confidence describes detection reliability, not disaster impact.
  // A single heat anomaly therefore never becomes a red/orange disaster alert
  // merely because the sensor is confident; FRP only raises review urgency.
  if (frpMw >= 30) return "yellow";
  return "blue";
}

export function cycloneSeverityFromKnots(windKt: number): DisasterEvent["severity"] {
  if (windKt >= 96) return "red";
  if (windKt >= 64) return "orange";
  if (windKt >= 34) return "yellow";
  return "blue";
}

export function latestTrackPoint(coordinates: unknown, geometryDates: unknown[] = []): [number, number] | null {
  if (!Array.isArray(coordinates)) return null;
  const points = coordinates.map(coordinatePair).filter((point): point is [number, number] => Boolean(point));
  if (!points.length) return null;
  if (geometryDates.length !== points.length) return points[points.length - 1];
  const latest = geometryDates.reduce((best, value, index) => {
    const time = Date.parse(String(value));
    return Number.isFinite(time) && time > best.time ? { index, time } : best;
  }, { index: points.length - 1, time: -Infinity });
  return points[latest.index];
}

export function circularGeometryCenter(coordinates: unknown): [number, number] | null {
  const points: Array<[number, number]> = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    const point = coordinatePair(value);
    if (point) {
      points.push(point);
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  if (!points.length) return null;
  const sin = points.reduce((sum, point) => sum + Math.sin(point[0] * Math.PI / 180), 0);
  const cos = points.reduce((sum, point) => sum + Math.cos(point[0] * Math.PI / 180), 0);
  const longitude = Math.atan2(sin / points.length, cos / points.length) * 180 / Math.PI;
  const latitude = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [longitude, latitude];
}

function coordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return [longitude, latitude];
}
