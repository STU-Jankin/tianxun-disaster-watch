import type { DisasterEvent, EventGeometry } from "./disasters";

const invalidIdentityPattern = /(?:^|[-_:])(undefined|null|nan|unknown)(?:$|[-_:])/i;

export function isValidSourceEventId(value: unknown) {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return id.length > 0 && id.length <= 240 && !invalidIdentityPattern.test(id);
}

export function firstValidSourceEventId(...candidates: unknown[]) {
  for (const candidate of candidates) {
    const value = typeof candidate === "string" || typeof candidate === "number" ? String(candidate).trim() : "";
    if (isValidSourceEventId(value)) return value;
  }
  return null;
}

export function eventHasInvalidIdentity(event: Pick<DisasterEvent, "id" | "masterEventId" | "entityKey" | "evidence">) {
  if (!isValidSourceEventId(event.id) || !isValidSourceEventId(event.masterEventId) || !isValidSourceEventId(event.entityKey)) return true;
  return event.evidence.some((item) => !isValidSourceEventId(item.sourceEventId));
}

export function geometryEquals(left: EventGeometry | undefined, right: EventGeometry | undefined) {
  return stableJson(left) === stableJson(right);
}

export function eventRevisionFingerprint(event: Pick<DisasterEvent,
  "id" | "masterEventId" | "entityKey" | "hazard" | "updatedAt" | "latitude" | "longitude" | "geometry" | "dispatchEligibility"
>) {
  return fingerprint({
    id: event.id,
    masterEventId: event.masterEventId,
    entityKey: event.entityKey,
    hazard: event.hazard,
    updatedAt: event.updatedAt,
    latitude: event.latitude,
    longitude: event.longitude,
    geometry: event.geometry,
    dispatchEligibility: event.dispatchEligibility,
  });
}

export function aoiFingerprint(value: unknown) {
  return fingerprint(value);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown) {
  const text = stableJson(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
