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

export function compareEventVersionFreshness(left: DisasterEvent, right: DisasterEvent) {
  return eventTimestamp(left.updatedAt) - eventTimestamp(right.updatedAt)
    || eventTimestamp(left.issuedAt) - eventTimestamp(right.issuedAt)
    || eventTimestamp(left.activityAt) - eventTimestamp(right.activityAt)
    || (left.updateCount ?? 0) - (right.updateCount ?? 0)
    || left.id.localeCompare(right.id);
}

export function latestEventVersionsByMasterId(events: DisasterEvent[]) {
  const latest = new Map<string, DisasterEvent>();
  for (const event of events) {
    const current = latest.get(event.masterEventId);
    if (!current || compareEventVersionFreshness(event, current) > 0) latest.set(event.masterEventId, event);
  }
  return [...latest.values()];
}

export function geometryEquals(left: EventGeometry | undefined, right: EventGeometry | undefined) {
  return stableJson(left) === stableJson(right);
}

export function eventRevisionFingerprint(event: DisasterEvent) {
  return fingerprint({
    id: event.id,
    masterEventId: event.masterEventId,
    entityKey: event.entityKey,
    hazard: event.hazard,
    severity: event.severity,
    sourceSeverity: event.sourceSeverity,
    occurredAt: event.occurredAt,
    activityAt: event.activityAt,
    issuedAt: event.issuedAt,
    updatedAt: event.updatedAt,
    validFrom: event.validFrom,
    validTo: event.validTo,
    latitude: event.latitude,
    longitude: event.longitude,
    geometry: event.geometry,
    cycloneForecast: event.cycloneForecast,
    lifecycleStatus: event.lifecycleStatus,
    sourcePresence: event.sourcePresence,
    observationPhase: event.observationPhase,
    observationStatus: event.observationStatus,
    observationExpiresAt: event.observationExpiresAt,
    dispatchEligibility: event.dispatchEligibility,
    evidence: event.evidence.map((item) => ({
      source: item.source,
      sourceEventId: item.sourceEventId,
      observedAt: item.observedAt,
      role: item.role,
    })),
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
  return sha256(stableJson(value));
}

function eventTimestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

// A small synchronous SHA-256 implementation keeps provenance fingerprints
// identical in browsers, Node and Workers without relying on an async WebCrypto
// call at every React render. It is used for integrity/version detection, not
// authentication or secret storage.
function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
}
