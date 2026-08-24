import {
  normalizeCapSeverity,
  normalizeEarthquakeSeverity,
  type DisasterEvent,
  type HazardType,
  type PhenomenonStage,
} from "./disasters.ts";

export type PublicEventCandidate = {
  sourceEventId: string;
  title: string;
  hazard: HazardType;
  geometry: { type: string; coordinates: unknown };
  occurredAt: string;
  updatedAt: string;
  activityAt?: string;
  issuedAt?: string;
  validFrom?: string;
  validTo?: string;
  phenomenonStage?: PhenomenonStage;
  sourceUrl: string;
  sourceSeverity: string;
  severity: DisasterEvent["severity"];
  magnitude?: number;
  magnitudeUnit?: string;
  country?: string;
  description: string;
  requiresReview?: boolean;
};

const nwsPublicUrl = "https://www.weather.gov/documentation/services-web-api";
const ecccPublicUrl = "https://api.weather.gc.ca/collections/weather-alerts";
const emscPublicUrl = "https://www.seismicportal.eu/fdsn-wsevent.html";
const copernicusPublicUrl = "https://rapidmapping.emergency.copernicus.eu/";

export function parseNwsAlerts(payload: unknown, now = Date.now()): PublicEventCandidate[] {
  const features = featureArray(payload);
  return features.flatMap((feature): PublicEventCandidate[] => {
    const properties = record(feature.properties);
    const status = text(properties.status);
    const messageType = text(properties.messageType);
    const expiresAt = validIso(properties.ends ?? properties.expires);
    if (!/^actual$/i.test(status) || /cancel|error|test|exercise/i.test(messageType) || (expiresAt && +new Date(expiresAt) <= now)) return [];
    const eventName = safeText(properties.event, 120, "NWS weather alert");
    const description = safeText(properties.description, 1_200, "NOAA/NWS official active weather alert.");
    const hazard = officialAlertHazard(eventName, description);
    const geometry = geometryValue(feature.geometry);
    if (!hazard || !geometry) return [];
    const sourceEventId = stableId(properties.id ?? feature.id);
    const issuedAt = validIso(properties.sent ?? properties.effective);
    const validFrom = validIso(properties.onset ?? properties.effective) ?? issuedAt;
    if (!sourceEventId || !issuedAt || !validFrom) return [];
    const severityText = [properties.severity, properties.urgency, properties.certainty].map(text).filter(Boolean).join(" · ") || "NWS alert";
    return [{
      sourceEventId,
      title: safeText(properties.headline, 240, eventName),
      hazard,
      geometry,
      occurredAt: issuedAt,
      updatedAt: issuedAt,
      activityAt: issuedAt,
      issuedAt,
      validFrom,
      validTo: expiresAt ?? undefined,
      phenomenonStage: "warning",
      sourceUrl: safeHttps(properties["@id"] ?? feature.id, nwsPublicUrl),
      sourceSeverity: severityText,
      severity: normalizeCapSeverity(text(properties.severity), text(properties.urgency), text(properties.certainty)),
      country: safeText(properties.areaDesc, 240, "United States"),
      description: `${description} This is an official warning area, not a remotely sensed impact boundary; review the AOI before dispatch.`,
      requiresReview: true,
    }];
  }).slice(0, 250);
}

export function parseEcccAlerts(payload: unknown, now = Date.now()): PublicEventCandidate[] {
  return featureArray(payload).flatMap((feature): PublicEventCandidate[] => {
    const properties = record(feature.properties);
    const status = text(properties.status_en);
    const expiresAt = validIso(properties.expiration_datetime ?? properties.event_end_datetime);
    if (/ended|cancel|termin/i.test(status) || (expiresAt && +new Date(expiresAt) <= now)) return [];
    const alertName = safeText(properties.alert_name_en ?? properties.alert_short_name_en, 120, "ECCC weather alert");
    const description = safeText(properties.alert_text_en, 1_200, "Environment and Climate Change Canada official weather alert.");
    const hazard = officialAlertHazard(alertName, description);
    const geometry = geometryValue(feature.geometry);
    const sourceEventId = stableId(feature.id ?? properties.feature_id);
    const issuedAt = validIso(properties.publication_datetime);
    const validFrom = validIso(properties.validity_datetime) ?? issuedAt;
    if (!hazard || !geometry || !sourceEventId || !issuedAt || !validFrom) return [];
    const colour = safeText(properties.risk_colour_en, 30, "official alert");
    const featureName = safeText(properties.feature_name_en, 120, "Canada");
    const province = safeText(properties.province, 30, "Canada");
    return [{
      sourceEventId,
      title: `${alertName} · ${featureName}`,
      hazard,
      geometry,
      occurredAt: issuedAt,
      updatedAt: issuedAt,
      activityAt: issuedAt,
      issuedAt,
      validFrom,
      validTo: expiresAt ?? undefined,
      phenomenonStage: "warning",
      sourceUrl: ecccPublicUrl,
      sourceSeverity: `${safeText(properties.alert_type, 30, "alert")} · ${colour}`,
      severity: colourSeverity(colour),
      country: `Canada · ${province} · ${featureName}`,
      description: `${description} This polygon is the official alert area, not an observed impact boundary; review the AOI before dispatch.`,
      requiresReview: true,
    }];
  }).slice(0, 250);
}

export function parseEmscEvents(payload: unknown): PublicEventCandidate[] {
  return featureArray(payload).flatMap((feature): PublicEventCandidate[] => {
    const properties = record(feature.properties);
    const geometry = geometryValue(feature.geometry);
    const sourceEventId = stableId(feature.id ?? properties.unid ?? properties.source_id);
    const magnitude = boundedNumber(properties.mag, 0, 12);
    const occurredAt = validIso(properties.time);
    const updatedAt = validIso(properties.lastupdate ?? properties.time);
    if (!geometry || geometry.type !== "Point" || !sourceEventId || magnitude === null || magnitude < 4.5 || !occurredAt || !updatedAt) return [];
    const region = safeText(properties.flynn_region, 180, "Earthquake");
    const depth = boundedNumber(properties.depth, -20, 800);
    return [{
      sourceEventId,
      title: `M${magnitude.toFixed(1)} earthquake · ${region}`,
      hazard: "earthquake" as const,
      geometry,
      occurredAt,
      updatedAt,
      issuedAt: updatedAt,
      phenomenonStage: "observed",
      sourceUrl: emscPublicUrl,
      sourceSeverity: `M${magnitude.toFixed(1)}`,
      severity: normalizeEarthquakeSeverity(magnitude),
      magnitude,
      magnitudeUnit: safeText(properties.magtype, 12, "M"),
      country: region,
      description: `EMSC near-real-time earthquake catalogue${depth === null ? "" : `; depth ${depth.toFixed(1)} km`}. The earthquake itself is not directly imaged; plan for deformation, rupture and secondary hazards.`,
    }];
  }).slice(0, 120);
}

export function parseCopernicusActivations(payload: unknown, now = Date.now()): PublicEventCandidate[] {
  const results = resultArray(payload);
  return results.flatMap((activation): PublicEventCandidate[] => {
    const code = stableId(activation.code);
    const hazard = copernicusHazard(text(activation.category), text(activation.subCategory));
    const eventTime = validUtcIso(activation.eventTime ?? activation.activationTime);
    const updatedAt = validUtcIso(activation.lastUpdate ?? activation.activationTime);
    if (!code || !hazard || !eventTime || !updatedAt) return [];
    if (Boolean(activation.closed) && now - +new Date(updatedAt) > 30 * 86_400_000) return [];
    const polygons = recordArray(activation.aois).flatMap((aoi) => polygonParts(parseWktGeometry(aoi.extent)));
    if (!polygons.length) polygons.push(...polygonParts(parseWktGeometry(activation.extent)));
    const geometry = polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : polygons.length > 1 ? { type: "MultiPolygon", coordinates: polygons } : parseWktGeometry(activation.centroid);
    if (!geometry) return [];
    const countries = Array.isArray(activation.countries)
      ? activation.countries.flatMap((country) => typeof country === "string" ? [country] : isRecord(country) ? [text(country.name)] : []).filter(Boolean)
      : [];
    const title = safeText(activation.name, 240, `${text(activation.category)} emergency mapping activation`);
    const reason = safeText(activation.reason, 1_200, "Copernicus EMS Rapid Mapping activation with an official area of interest.");
    return [{
      sourceEventId: code,
      title,
      hazard,
      geometry,
      occurredAt: eventTime,
      updatedAt,
      activityAt: updatedAt,
      issuedAt: updatedAt,
      phenomenonStage: "context",
      sourceUrl: safeHttps(activation.reportLink, `${copernicusPublicUrl}${code}`),
      sourceSeverity: activation.closed ? "Rapid Mapping closed" : "Rapid Mapping active",
      severity: activation.closed ? "blue" as const : "yellow" as const,
      country: countries.join(" · ") || safeText(activation.continent, 80, "Global"),
      description: `${reason} The geometry is the official mapping AOI, not the final affected-area delineation.`,
      requiresReview: polygons.length === 0,
    }];
  }).slice(0, 24);
}

export function parseWktGeometry(value: unknown): { type: string; coordinates: unknown } | null {
  const source = text(value).replace(/^SRID=\d+;/i, "").trim();
  const match = source.match(/^(POINT|POLYGON|MULTIPOLYGON)\s*(.+)$/i);
  if (!match) return null;
  const type = match[1].toUpperCase();
  if (type === "POINT") {
    const numbers = match[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
    return numbers.length >= 2 && validCoordinate(numbers[0], numbers[1]) ? { type: "Point", coordinates: [numbers[0], numbers[1]] } : null;
  }
  const tokens = match[2].match(/\(|\)|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let index = 0;
  const parseGroup = (): unknown[] | null => {
    if (tokens[index++] !== "(") return null;
    const output: unknown[] = [];
    const nested = tokens[index] === "(";
    while (index < tokens.length && tokens[index] !== ")") {
      if (nested) {
        const group = parseGroup();
        if (!group) return null;
        output.push(group);
      } else {
        const longitude = Number(tokens[index++]);
        const latitude = Number(tokens[index++]);
        while (tokens[index] !== "," && tokens[index] !== ")" && index < tokens.length) index += 1;
        if (!validCoordinate(longitude, latitude)) return null;
        output.push([longitude, latitude]);
      }
      if (tokens[index] === ",") index += 1;
    }
    if (tokens[index++] !== ")") return null;
    return output;
  };
  const coordinates = parseGroup();
  if (!coordinates || index !== tokens.length) return null;
  return { type: type === "POLYGON" ? "Polygon" : "MultiPolygon", coordinates };
}

export function officialAlertHazard(title: string, description = ""): HazardType | null {
  const value = `${title} ${description}`.toLowerCase();
  if (/tsunami/.test(value)) return "tsunami";
  if (/earthquake/.test(value)) return "earthquake";
  if (/volcan|ashfall/.test(value)) return "volcano";
  if (/landslide|mudslide|debris flow/.test(value)) return "landslide";
  if (/hurricane|tropical (?:cyclone|storm|depression)|typhoon/.test(value)) return "cyclone";
  if (/flash flood|flood warning|coastal flood|storm surge|river flood/.test(value)) return "flood";
  if (/forest fire|wildfire|bushfire|fire warning/.test(value) && !/wildfire smoke|fire weather|red flag/.test(value)) return "wildfire";
  if (/dust storm|blowing dust|sandstorm/.test(value)) return "dust";
  if (/blizzard|ice storm|snow squall|heavy snow|avalanche/.test(value)) return "ice";
  if (/drought/.test(value)) return "drought";
  return null;
}

function copernicusHazard(category: string, subCategory: string): HazardType | null {
  const value = `${category} ${subCategory}`.toLowerCase();
  if (/wildfire|forest fire/.test(value)) return "wildfire";
  if (/flood/.test(value)) return "flood";
  if (/earthquake/.test(value)) return "earthquake";
  if (/tsunami/.test(value)) return "tsunami";
  if (/volcan/.test(value)) return "volcano";
  if (/landslide|mudslide/.test(value)) return "landslide";
  if (/drought/.test(value)) return "drought";
  if (/tropical cyclone|hurricane|typhoon/.test(value)) return "cyclone";
  if (/ice|snow|avalanche/.test(value)) return "ice";
  return null;
}

function featureArray(payload: unknown) {
  const features = isRecord(payload) && Array.isArray(payload.features) ? payload.features : [];
  return features.filter(isRecord);
}

function resultArray(payload: unknown) {
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  return results.filter(isRecord);
}

function recordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function geometryValue(value: unknown) {
  if (!isRecord(value) || typeof value.type !== "string" || value.coordinates === undefined) return null;
  if (!/^(Point|LineString|Polygon|MultiPolygon)$/.test(value.type)) return null;
  return { type: value.type, coordinates: value.coordinates };
}

function polygonParts(geometry: { type: string; coordinates: unknown } | null): unknown[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  return geometry.type === "MultiPolygon" ? geometry.coordinates : [];
}

function stableId(value: unknown) {
  const id = text(value).trim();
  return id && id.length <= 220 && !/(?:^|[-_:])(undefined|null|nan|unknown)(?:$|[-_:])/i.test(id) ? id : null;
}

function validIso(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validUtcIso(value: unknown) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return validIso(`${value}Z`);
  return validIso(value);
}

function colourSeverity(value: string): DisasterEvent["severity"] {
  if (/red|rouge/i.test(value)) return "red";
  if (/orange/i.test(value)) return "orange";
  if (/yellow|jaune/i.test(value)) return "yellow";
  return "blue";
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function safeHttps(value: unknown, fallback: string) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function safeText(value: unknown, maximum: number, fallback: string) {
  const valueText = [...text(value)].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  return valueText ? valueText.slice(0, maximum) : fallback;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function validCoordinate(longitude: number, latitude: number) {
  return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
