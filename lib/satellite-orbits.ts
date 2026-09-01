import { satellitePayloadProfile, type SarPayloadProfile } from "./satellite-payloads.ts";
import { satelliteOrbitModelProfile, type SatelliteOrbitModelProfile } from "./satellite-orbit-models.ts";

export type SatelliteIdentityStatus = "configured" | "unverified";

export type TrackedSarSatellite = {
  noradId: number;
  interfaceName?: string;
  interfaceCode?: string;
  commonName: string;
  commonCode?: string;
  identityStatus: SatelliteIdentityStatus;
  payloadProfileId?: string;
  orbitModelProfileId?: string;
};

export type SatelliteTleRecord = {
  noradId: number;
  providerName: string;
  tleLine1: string;
  tleLine2: string;
  epoch: string;
  fetchedAt: string;
  source: "CelesTrak GP";
  sourceUrl: string;
};

export type SatelliteOrbitCacheRecord = {
  noradId: number;
  tle?: SatelliteTleRecord;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastError?: string;
};

export type SatelliteOrbitSnapshot = TrackedSarSatellite & {
  payloadProfile?: SarPayloadProfile;
  orbitModel?: SatelliteOrbitModelProfile;
  providerName?: string;
  tleLine1?: string;
  tleLine2?: string;
  epoch?: string;
  fetchedAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  elementAgeHours?: number;
  retrievalAgeHours?: number;
  orbitStatus: "current" | "stale" | "unavailable";
  source: "CelesTrak GP";
  sourceUrl: string;
};

export const CELESTRAK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const CELESTRAK_SOURCE_URL = "https://celestrak.org/NORAD/elements/gp.php";

export const trackedSarSatellites: readonly TrackedSarSatellite[] = [
  { noradId: 51832, interfaceName: "TY-CSAR-2", interfaceCode: "天仪C波段卫星-2", commonName: "TY-39", commonCode: "巢湖一号", identityStatus: "configured", payloadProfileId: "ty-csar-v2", orbitModelProfileId: "stk-sgp4-wgs72-v1" },
  { noradId: 56846, interfaceName: "TY-CSAR-3", interfaceCode: "天仪C波段卫星-3", commonName: "TY-40", commonCode: "涪城一号", identityStatus: "configured", payloadProfileId: "ty-csar-v2", orbitModelProfileId: "stk-sgp4-wgs72-v1" },
  { noradId: 61231, interfaceName: "TY-CSAR-4", interfaceCode: "天仪C波段卫星-4", commonName: "TY-41", commonCode: "神启号", identityStatus: "configured", payloadProfileId: "ty-csar-v2", orbitModelProfileId: "stk-sgp4-wgs72-v1" },
  { noradId: 64048, interfaceName: "TY-CSAR-5", interfaceCode: "天仪C波段卫星-5", commonName: "TY-42", commonCode: "神启02号", identityStatus: "configured", payloadProfileId: "ty-csar-v2", orbitModelProfileId: "stk-sgp4-wgs72-v1" },
  { noradId: 69100, commonName: "TY-50", commonCode: "电建一号", identityStatus: "configured", payloadProfileId: "ty-xsar-v1", orbitModelProfileId: "stk-sgp4-wgs72-v1" },
  { noradId: 58918, commonName: "OSE-GF01", commonCode: "东方慧眼（不确定）", identityStatus: "unverified" },
] as const;

export async function fetchTrackedSatelliteTles(fetchImpl: typeof fetch = fetch, now = new Date()) {
  const results: Array<{ satellite: TrackedSarSatellite; tle?: SatelliteTleRecord; error?: string }> = [];
  for (const satellite of trackedSarSatellites) {
    try {
      results.push({ satellite, tle: await fetchSatelliteTle(satellite.noradId, fetchImpl, now) });
    } catch (error) {
      results.push({ satellite, error: boundedError(error) });
    }
  }
  return results;
}

export async function fetchSatelliteTle(noradId: number, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<SatelliteTleRecord> {
  if (!Number.isInteger(noradId) || noradId < 1 || noradId > 69_999) throw new Error("TLE仅支持1至69999的NORAD编号");
  const sourceUrl = `${CELESTRAK_SOURCE_URL}?CATNR=${noradId}&FORMAT=TLE`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(sourceUrl, {
      headers: { Accept: "text/plain", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
      // Cloudflare Workers implements manual/follow but rejects the Fetch
      // standard's "error" mode. Manual still lets us reject every 3xx below
      // because redirect responses are not response.ok.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CelesTrak返回HTTP ${response.status}`);
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > 8_192) throw new Error("CelesTrak响应超过安全上限");
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 8_192) throw new Error("CelesTrak响应超过安全上限");
    return parseTleResponse(body, noradId, now, sourceUrl);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseTleResponse(body: string, expectedNoradId: number, fetchedAt = new Date(), sourceUrl = `${CELESTRAK_SOURCE_URL}?CATNR=${expectedNoradId}&FORMAT=TLE`): SatelliteTleRecord {
  const lines = body.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const firstIndex = lines.findIndex((line) => line.startsWith("1 "));
  if (firstIndex < 0 || !lines[firstIndex + 1]?.startsWith("2 ")) throw new Error("CelesTrak未返回有效TLE两行数据");
  const tleLine1 = lines[firstIndex];
  const tleLine2 = lines[firstIndex + 1];
  const line1Id = tleCatalogNumber(tleLine1);
  const line2Id = tleCatalogNumber(tleLine2);
  if (line1Id !== expectedNoradId || line2Id !== expectedNoradId) throw new Error("TLE中的NORAD编号与请求不一致");
  if (!validTleChecksum(tleLine1) || !validTleChecksum(tleLine2)) throw new Error("TLE校验和无效");
  const epoch = parseTleEpoch(tleLine1);
  const providerName = firstIndex > 0 ? lines[firstIndex - 1].trim().slice(0, 120) : String(expectedNoradId);
  return {
    noradId: expectedNoradId,
    providerName,
    tleLine1,
    tleLine2,
    epoch,
    fetchedAt: fetchedAt.toISOString(),
    source: "CelesTrak GP",
    sourceUrl,
  };
}

export function buildSatelliteOrbitSnapshot(cache: SatelliteOrbitCacheRecord[], now = new Date()): SatelliteOrbitSnapshot[] {
  const byId = new Map(cache.map((item) => [item.noradId, item]));
  return trackedSarSatellites.map((satellite) => {
    const saved = byId.get(satellite.noradId);
    const epochMs = Date.parse(saved?.tle?.epoch ?? "");
    const successMs = Date.parse(saved?.lastSuccessAt ?? saved?.tle?.fetchedAt ?? "");
    const elementAgeHours = Number.isFinite(epochMs) ? Math.max(0, (now.getTime() - epochMs) / 3_600_000) : undefined;
    const retrievalAgeHours = Number.isFinite(successMs) ? Math.max(0, (now.getTime() - successMs) / 3_600_000) : undefined;
    const orbitStatus = !saved?.tle
      ? "unavailable" as const
      : (elementAgeHours ?? Number.POSITIVE_INFINITY) > 7 * 24 || (retrievalAgeHours ?? Number.POSITIVE_INFINITY) > 36
        ? "stale" as const
        : "current" as const;
    return {
      ...satellite,
      payloadProfile: satellitePayloadProfile(satellite.payloadProfileId),
      orbitModel: satelliteOrbitModelProfile(satellite.orbitModelProfileId),
      providerName: saved?.tle?.providerName,
      tleLine1: saved?.tle?.tleLine1,
      tleLine2: saved?.tle?.tleLine2,
      epoch: saved?.tle?.epoch,
      fetchedAt: saved?.tle?.fetchedAt,
      lastAttemptAt: saved?.lastAttemptAt,
      lastSuccessAt: saved?.lastSuccessAt,
      lastError: saved?.lastError,
      elementAgeHours: elementAgeHours === undefined ? undefined : Math.round(elementAgeHours * 10) / 10,
      retrievalAgeHours: retrievalAgeHours === undefined ? undefined : Math.round(retrievalAgeHours * 10) / 10,
      orbitStatus,
      source: "CelesTrak GP" as const,
      sourceUrl: `${CELESTRAK_SOURCE_URL}?CATNR=${satellite.noradId}&FORMAT=TLE`,
    };
  });
}

function tleCatalogNumber(line: string) {
  if (line.length < 7) return Number.NaN;
  return Number(line.slice(2, 7).trim());
}

function validTleChecksum(line: string) {
  if (line.length < 69 || !/^\d$/.test(line[68])) return false;
  let checksum = 0;
  for (const character of line.slice(0, 68)) {
    if (/\d/.test(character)) checksum += Number(character);
    else if (character === "-") checksum += 1;
  }
  return checksum % 10 === Number(line[68]);
}

function parseTleEpoch(line1: string) {
  const shortYear = Number(line1.slice(18, 20));
  const dayOfYear = Number(line1.slice(20, 32));
  if (!Number.isInteger(shortYear) || !Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear >= 367) throw new Error("TLE历元字段无效");
  const year = shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
  const daysInYear = new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29 ? 366 : 365;
  if (dayOfYear >= daysInYear + 1) throw new Error("TLE历元超出该年份范围");
  return new Date(Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000).toISOString();
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知轨道数据错误";
  if (/abort/i.test(message)) return "CelesTrak请求超时";
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}
