import type { EvaluationBenchmarkCase } from "./evaluation-center";

export const nasaGlcDatasetUrl = "https://data.nasa.gov/dataset/global-landslide-catalog-export";
export const nasaGlcCsvUrl = "https://data.nasa.gov/docs/legacy/Global_Landslide_Catalog_Export/Global_Landslide_Catalog_Export_rows.csv";
export const nasaGlcPilotPrefix = "benchmark-nasa-glc-";
export const nasaGlcPilotLimit = 20;
export const nasaGlcMaximumCsvBytes = 12 * 1024 * 1024;

export type OfficialLandslidePilotCase = Omit<EvaluationBenchmarkCase, "createdBy" | "createdAt" | "updatedAt">;

export type OfficialLandslidePilotBuild = {
  cases: OfficialLandslidePilotCase[];
  stats: {
    sourceRows: number;
    eligibleRows: number;
    selectedRows: number;
    countries: number;
    categories: Record<string, number>;
  };
};

type Candidate = {
  eventId: string;
  title: string;
  occurredAt: string;
  latitude: number;
  longitude: number;
  category: "landslide" | "mudslide" | "debris_flow";
  trigger: string;
  country: string;
  countryCode: string;
  accuracyLabel: "exact" | "1km" | "5km";
  accuracyKm: number;
  sourceName: string;
  sourceLink: string;
};

const eligibleTriggers = new Set(["rain", "downpour", "continuous_rain", "tropical_cyclone", "monsoon"]);
// Apply the rarest NASA taxonomy first. Under the strict source/trigger/accuracy
// rules the current official export contains only two eligible debris_flow rows;
// reserving them first prevents the country cap from silently removing the class.
const categoryTargets: Array<{ category: Candidate["category"]; count: number }> = [
  { category: "debris_flow", count: 2 },
  { category: "mudslide", count: 5 },
  { category: "landslide", count: 13 },
];
const accuracyKm = new Map<Candidate["accuracyLabel"], number>([["exact", 0], ["1km", 1], ["5km", 5]]);

export function buildNasaGlcPilot(csv: string, limit = nasaGlcPilotLimit): OfficialLandslidePilotBuild {
  if (!Number.isInteger(limit) || limit < 1 || limit > nasaGlcPilotLimit) throw new Error("NASA GLC pilot limit must be between 1 and 20");
  const rows = parseBoundedCsv(csv);
  if (rows.length < 2) throw new Error("NASA GLC CSV contains no data rows");
  const headers = rows[0].map((value) => value.trim());
  const required = ["event_id", "event_date", "event_title", "location_accuracy", "landslide_category", "landslide_trigger", "source_name", "source_link", "country_name", "country_code", "longitude", "latitude"];
  for (const field of required) if (!headers.includes(field)) throw new Error(`NASA GLC CSV is missing ${field}`);
  const candidates = rows.slice(1).map((row) => recordFromRow(headers, row)).filter((value): value is Candidate => value !== null);
  const selected: Candidate[] = [];
  const selectedIds = new Set<string>();
  const countryCounts = new Map<string, number>();
  for (const target of categoryTargets) {
    if (selected.length >= limit) break;
    const quota = Math.min(target.count, limit - selected.length);
    selectCandidates(candidates.filter((item) => item.category === target.category), quota, selected, selectedIds, countryCounts, 2);
  }
  if (selected.length < limit) selectCandidates(candidates, limit - selected.length, selected, selectedIds, countryCounts, 3);
  if (selected.length < limit) throw new Error(`NASA GLC strict filter produced only ${selected.length} of ${limit} required records`);
  const cases = selected.map(toBenchmarkCase);
  return {
    cases,
    stats: {
      sourceRows: rows.length - 1,
      eligibleRows: candidates.length,
      selectedRows: cases.length,
      countries: new Set(selected.map((item) => item.countryCode || item.country)).size,
      categories: Object.fromEntries(categoryTargets.map(({ category }) => [category, selected.filter((item) => item.category === category).length])),
    },
  };
}

function recordFromRow(headers: string[], row: string[]): Candidate | null {
  const record = Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? "").trim()]));
  const eventId = record.event_id;
  const category = record.landslide_category?.toLowerCase() as Candidate["category"];
  const trigger = record.landslide_trigger?.toLowerCase();
  const accuracyLabel = record.location_accuracy?.toLowerCase() as Candidate["accuracyLabel"];
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(eventId) || !categoryTargets.some((item) => item.category === category) || !eligibleTriggers.has(trigger) || !accuracyKm.has(accuracyLabel)) return null;
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const occurredAt = parseGlcDate(record.event_date);
  if (!occurredAt) return null;
  const year = new Date(occurredAt).getUTCFullYear();
  if (year < 2000 || year > 2020) return null;
  const sourceLink = safeHttps(record.source_link);
  const title = cleanText(record.event_title, 120);
  const sourceName = cleanText(record.source_name, 80);
  const country = cleanText(record.country_name, 80);
  const countryCode = record.country_code?.trim().toUpperCase().slice(0, 3) || "XX";
  if (!sourceLink || !title || !sourceName || !country) return null;
  return { eventId, title, occurredAt, latitude, longitude, category, trigger, country, countryCode, accuracyLabel, accuracyKm: accuracyKm.get(accuracyLabel)!, sourceName, sourceLink };
}

function selectCandidates(pool: Candidate[], count: number, selected: Candidate[], selectedIds: Set<string>, countryCounts: Map<string, number>, countryMaximum: number) {
  const sorted = [...pool].sort((left, right) => stableHash(`${left.countryCode}:${left.eventId}`) - stableHash(`${right.countryCode}:${right.eventId}`) || left.eventId.localeCompare(right.eventId));
  let added = 0;
  for (const candidate of sorted) {
    if (added >= count) break;
    if (selectedIds.has(candidate.eventId)) continue;
    if (selected.some((existing) => !independentFrom(existing, candidate))) continue;
    const countryKey = candidate.countryCode || candidate.country;
    if ((countryCounts.get(countryKey) ?? 0) >= countryMaximum) continue;
    selected.push(candidate);
    selectedIds.add(candidate.eventId);
    countryCounts.set(countryKey, (countryCounts.get(countryKey) ?? 0) + 1);
    added += 1;
  }
}

function independentFrom(left: Candidate, right: Candidate) {
  if (left.sourceLink === right.sourceLink) return false;
  const sameDate = left.occurredAt.slice(0, 10) === right.occurredAt.slice(0, 10);
  const sameCountry = (left.countryCode || left.country) === (right.countryCode || right.country);
  return !(sameDate && sameCountry && haversineKm(left.latitude, left.longitude, right.latitude, right.longitude) <= 25);
}

function haversineKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = radians(longitude2 - longitude1);
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toBenchmarkCase(candidate: Candidate): OfficialLandslidePilotCase {
  const eventId = candidate.eventId.padStart(8, "0");
  const originalLink = candidate.sourceLink.length > 210 ? `${candidate.sourceLink.slice(0, 207)}…` : candidate.sourceLink;
  const notes = [
    `NASA GLC记录 ${candidate.eventId}；目录来源 ${candidate.sourceName}；原始链接 ${originalLink}。`,
    `定位精度 ${candidate.accuracyLabel}；诱因 ${candidate.trigger}；发生时刻仅精确到日期，暂以12:00 UTC占位。`,
    "该记录只能作为正样本草稿；核对原始来源、当地时区和灾种后方可标记为已核验。",
  ].join("");
  return {
    caseId: `${nasaGlcPilotPrefix}${eventId}`,
    title: `${candidate.title} · NASA GLC ${candidate.eventId}`.slice(0, 160),
    hazard: "landslide",
    objective: "landslide_forecast",
    hazardSubtype: candidate.category === "landslide" ? "landslide" : "debris_flow",
    outcome: "event",
    calibrationGroup: "NASA-GLC-v1-全球降雨",
    occurredAt: candidate.occurredAt,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    // Add a 2 km allowance for the historical forecast grid without hiding the
    // catalog's own coordinate uncertainty inside an overly broad match radius.
    locationToleranceKm: Math.max(2, candidate.accuracyKm + 2),
    eventTimeToleranceHours: 24,
    acceptedLeadMinutes: 1_440,
    detectionDeadlineMinutes: 360,
    requiredSource: "NASA LHASA v1 历史产品",
    minimumForecastRiskPercent: 80,
    provenanceUrl: nasaGlcDatasetUrl,
    notes: notes.slice(0, 500),
    verificationStatus: "draft",
  };
}

function parseGlcDate(value: string) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function safeHttps(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(value: string, maximum: number) {
  const withoutControls = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return hash >>> 0;
}

function parseBoundedCsv(source: string) {
  if (!source || source.length > nasaGlcMaximumCsvBytes) throw new Error("NASA GLC CSV exceeds the 12 MB safety limit");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length)) rows.push(row);
      if (rows.length > 20_000) throw new Error("NASA GLC CSV exceeds the row safety limit");
      row = [];
      field = "";
    } else field += character;
    if (field.length > 8_192 || row.length > 64) throw new Error("NASA GLC CSV contains an oversized field or row");
  }
  if (quoted) throw new Error("NASA GLC CSV contains an unterminated quoted field");
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}
