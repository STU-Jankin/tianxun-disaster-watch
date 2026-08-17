import type {
  CycloneForecast,
  CycloneForecastPoint,
  CycloneImpactField,
  CycloneImpactFrame,
  CycloneQuadrantRadiiKm,
  CycloneWindField,
  EventGeometry,
} from "./disasters";

const MAX_KMZ_BYTES = 6_000_000;
const MAX_KML_BYTES = 12_000_000;

type Coordinate = [number, number];
type JsonRecord = Record<string, unknown>;
export type OfficialImpactSlice = {
  leadHours: number;
  uncertaintyRadiusKm?: number;
  uncertaintyGeometry?: EventGeometry;
  windFields: CycloneWindField[];
};

export async function extractKmlFromKmz(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_KMZ_BYTES) throw new Error("KMZ 文件超过安全上限");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("KMZ 中未找到 ZIP 目录");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entries && offset + 46 <= bytes.byteLength; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("KMZ ZIP 目录损坏");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith(".kml")) continue;
    if (compressedSize > MAX_KMZ_BYTES || uncompressedSize > MAX_KML_BYTES) throw new Error("KMZ 内 KML 超过安全上限");
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("KMZ 本地文件头损坏");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.byteLength) throw new Error("KMZ 文件内容不完整");
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let decoded: Uint8Array;
    if (method === 0) decoded = Uint8Array.from(compressed);
    else if (method === 8) {
      const stream = new Blob([Uint8Array.from(compressed).buffer]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
      decoded = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`KMZ 使用了不支持的压缩方法 ${method}`);
    if (decoded.byteLength > MAX_KML_BYTES) throw new Error("解压后的 KML 超过安全上限");
    return new TextDecoder().decode(decoded);
  }
  throw new Error("KMZ 中没有 KML 文件");
}

export function parseNhcTrackKml(
  kml: string,
  issuedAt: string,
  current: { latitude: number; longitude: number; windSpeedKnots?: number; pressureHpa?: number; category?: string },
): { track: CycloneForecastPoint[]; trackGeometry: EventGeometry } | null {
  const points: CycloneForecastPoint[] = [];
  for (const placemark of placemarks(kml)) {
    if (!/<Point\b/i.test(placemark)) continue;
    const coordinate = firstCoordinate(placemark);
    if (!coordinate) continue;
    const leadMatch = placemark.match(/(\d{1,3})\s*hr\s+Forecast/i);
    const isInitial = /Advisory Information/i.test(placemark);
    if (!leadMatch && !isInitial) continue;
    const leadHours = leadMatch ? Number(leadMatch[1]) : 0;
    const wind = numericMatch(placemark, /Maximum Wind:\s*(\d+(?:\.\d+)?)\s*knots/i);
    const pressure = numericMatch(placemark, /Minimum Pressure:\s*(\d+(?:\.\d+)?)\s*(?:mb|hPa)/i);
    points.push({
      forecastAt: new Date(Date.parse(issuedAt) + leadHours * 3_600_000).toISOString(),
      latitude: coordinate[1],
      longitude: coordinate[0],
      leadHours,
      windSpeedKnots: wind ?? undefined,
      pressureHpa: pressure ?? undefined,
      category: extendedDataValue(placemark, "stormType") ?? current.category,
    });
  }
  if (!points.some((point) => point.leadHours === 0)) {
    points.push({ forecastAt: issuedAt, leadHours: 0, ...current });
  }
  const track = [...new Map(points.sort((a, b) => a.leadHours - b.leadHours).map((point) => [point.leadHours, point])).values()];
  if (track.length < 2) return null;
  return { track, trackGeometry: { type: "LineString", coordinates: track.map((point) => [point.longitude, point.latitude]) } };
}

export function parseNhcConeKml(kml: string): EventGeometry | undefined {
  return polygonGeometry(placemarks(kml).flatMap((placemark) => polygonRings(placemark)));
}

export function parseNhcWindRadiiKml(kml: string, track: CycloneForecastPoint[] = []): { geometry?: EventGeometry; thresholdKnots?: number; timeSlices: OfficialImpactSlice[] } {
  const byThreshold = new Map<number, Coordinate[][]>();
  const byLead = new Map<number, Map<number, Coordinate[][]>>();
  for (const placemark of placemarks(kml)) {
    const name = stripTags(placemark.match(/<name[^>]*>([\s\S]*?)<\/name>/i)?.[1] ?? "");
    const threshold = Number(name.match(/\b(\d{2,3})\b/)?.[1]);
    if (!Number.isFinite(threshold)) continue;
    const rings = polygonRings(placemark);
    byThreshold.set(threshold, [...(byThreshold.get(threshold) ?? []), ...rings]);
    const plainText = stripTags(placemark);
    const leadHours = Number(`${name} ${plainText}`.match(/\b(\d{1,3})\s*(?:hr|hrs|hour|hours)\b/i)?.[1] ?? 0);
    const thresholds = byLead.get(leadHours) ?? new Map<number, Coordinate[][]>();
    thresholds.set(threshold, [...(thresholds.get(threshold) ?? []), ...rings]);
    byLead.set(leadHours, thresholds);
  }
  const thresholds = [...byThreshold.keys()].sort((a, b) => a - b);
  const thresholdKnots = thresholds.includes(34) ? 34 : thresholds[0];
  const timeSlices = [...byLead.entries()].sort(([left], [right]) => left - right).flatMap(([leadHours, fields]): OfficialImpactSlice[] => {
    const center = nearestTrackPoint(track, leadHours);
    if (!center) return [];
    return [{
      leadHours,
      windFields: [...fields.entries()].sort(([left], [right]) => left - right).flatMap(([threshold, rings]): CycloneWindField[] => {
        const quadrantsKm = quadrantRadiiFromRings(rings, center.latitude, center.longitude);
        return maximumQuadrantRadius(quadrantsKm) > 0 ? [{ thresholdKnots: threshold, quadrantsKm, basis: "derived_official_polygon" }] : [];
      }),
    }];
  });
  return { geometry: thresholdKnots === undefined ? undefined : polygonGeometry(byThreshold.get(thresholdKnots) ?? []), thresholdKnots, timeSlices };
}

export function buildHourlyCycloneImpactField(
  track: CycloneForecastPoint[],
  officialSlices: OfficialImpactSlice[],
  uncertaintyEnvelope?: EventGeometry,
): CycloneImpactField | undefined {
  if (track.length < 2) return undefined;
  const orderedTrack = [...track].sort((left, right) => left.leadHours - right.leadHours);
  const firstHour = Math.max(0, Math.ceil(orderedTrack[0].leadHours));
  const lastHour = Math.min(360, Math.floor(orderedTrack[orderedTrack.length - 1].leadHours));
  if (lastHour < firstHour) return undefined;
  const slices = [...officialSlices].sort((left, right) => left.leadHours - right.leadHours);
  const frames: CycloneImpactFrame[] = [];
  for (let leadHours = firstHour; leadHours <= lastHour; leadHours += 1) {
    const center = interpolateTrackPoint(orderedTrack, leadHours);
    if (!center) continue;
    const exactSlice = slices.find((slice) => slice.leadHours === leadHours);
    const lowerSlice = [...slices].reverse().find((slice) => slice.leadHours <= leadHours);
    const upperSlice = slices.find((slice) => slice.leadHours >= leadHours);
    const uncertaintyRadiusKm = exactSlice?.uncertaintyRadiusKm ?? interpolateOptionalNumber(lowerSlice, upperSlice, leadHours, "uncertaintyRadiusKm");
    const windFields = exactSlice?.windFields.length
      ? exactSlice.windFields
      : interpolateWindFields(lowerSlice, upperSlice, leadHours);
    frames.push({
      forecastAt: new Date(Date.parse(orderedTrack[0].forecastAt) + (leadHours - orderedTrack[0].leadHours) * 3_600_000).toISOString(),
      leadHours,
      latitude: center.latitude,
      longitude: center.longitude,
      centerBasis: orderedTrack.some((point) => point.leadHours === leadHours) ? "official_node" : "interpolated_official_track",
      uncertaintyRadiusKm,
      uncertaintyGeometry: exactSlice?.uncertaintyGeometry,
      windFields,
    });
  }
  if (!frames.length) return undefined;
  const hasTimeUncertainty = slices.some((slice) => slice.uncertaintyRadiusKm !== undefined || slice.uncertaintyGeometry);
  return {
    temporalResolutionHours: 1,
    frames,
    interpolation: "linear_between_official_nodes",
    uncertaintyBasis: hasTimeUncertainty ? "time_sliced_official" : uncertaintyEnvelope ? "official_advisory_envelope" : "not_available",
    note: "逐时中心及连续风圈仅在相邻官方预报节点之间插值；官方节点、插值节点和不确定区来源在每个时间片中分别标记，不进行报次之外的外推。",
  };
}

export function cycloneWindGeometry(frame: CycloneImpactFrame, field: CycloneWindField): EventGeometry {
  const ring = Array.from({ length: 73 }, (_, index): Coordinate => {
    const bearing = index * 5;
    return destinationCoordinate(frame.latitude, frame.longitude, interpolatedQuadrantRadius(field.quadrantsKm, bearing), bearing);
  });
  return { type: "Polygon", coordinates: [ring] };
}

export function cycloneUncertaintyGeometry(frame: CycloneImpactFrame): EventGeometry | undefined {
  if (frame.uncertaintyGeometry) return frame.uncertaintyGeometry;
  return frame.uncertaintyRadiusKm && frame.uncertaintyRadiusKm > 0
    ? { type: "Polygon", coordinates: [circleRing(frame.latitude, frame.longitude, frame.uncertaintyRadiusKm * 1000)] }
    : undefined;
}

export function buildJmaCycloneForecast(
  specifications: unknown,
  forecastPayload: unknown,
  sourceUrl: string,
): CycloneForecast | undefined {
  const specificationRecords = recordArray(specifications);
  const forecastRecords = recordArray(forecastPayload);
  const title = specificationRecords.find((record) => record.part === "title") ?? {};
  const issuedAt = isoAt(title.issue, "UTC") ?? isoAt(title.issue, "JST");
  if (!issuedAt) return undefined;

  const track = specificationRecords.flatMap((record): CycloneForecastPoint[] => {
    const position = coordinateFromLatLonArray(asRecord(record.position)?.deg);
    const leadHours = Number(record.advancedHours);
    const forecastAt = isoAt(record.validtime, "UTC") ?? isoAt(record.validtime, "JST");
    if (!position || !Number.isFinite(leadHours) || !forecastAt) return [];
    const maximumWind = asRecord(asRecord(record.maximumWind)?.sustained);
    const category = localizedValue(record.category);
    return [{
      forecastAt,
      latitude: position[1],
      longitude: position[0],
      leadHours,
      windSpeedKnots: finiteNumber(maximumWind?.kt) ?? undefined,
      pressureHpa: finiteNumber(record.pressure) ?? undefined,
      category: category || undefined,
    }];
  }).sort((a, b) => a.leadHours - b.leadHours);
  if (track.length < 2) return undefined;

  const uncertaintyRings = forecastRecords.flatMap((record): Coordinate[][] => {
    const center = coordinateFromLatLonArray(record.center);
    const radius = finiteNumber(asRecord(record.probabilityCircle)?.radius);
    return center && radius && radius > 0 ? [circleRing(center[1], center[0], radius)] : [];
  });
  const currentForecast = forecastRecords.find((record) => Number(record.advancedHours) === 0);
  const windArea = asRecord(currentForecast?.galeWarningArea);
  const windCenter = coordinateFromLatLonArray(windArea?.center);
  const windRadius = finiteNumber(windArea?.radius);
  const impactGeometry = windCenter && windRadius && windRadius > 0
    ? { type: "Polygon" as const, coordinates: [circleRing(windCenter[1], windCenter[0], windRadius)] }
    : undefined;
  const impactSlices = forecastRecords.flatMap((record): OfficialImpactSlice[] => {
    const leadHours = Number(record.advancedHours);
    if (!Number.isFinite(leadHours) || leadHours < 0 || leadHours > 360) return [];
    const probabilityRadiusMeters = finiteNumber(asRecord(record.probabilityCircle)?.radius);
    const warningArea = asRecord(record.galeWarningArea);
    const warningRadiusMeters = finiteNumber(warningArea?.radius);
    const windFields: CycloneWindField[] = warningRadiusMeters && warningRadiusMeters > 0 ? [{
      thresholdKnots: 29,
      quadrantsKm: equalQuadrants(warningRadiusMeters / 1000),
      basis: "official_circular_extent",
    }] : [];
    return [{
      leadHours,
      uncertaintyRadiusKm: probabilityRadiusMeters && probabilityRadiusMeters > 0 ? probabilityRadiusMeters / 1000 : undefined,
      windFields,
    }];
  });
  const typhoonNumber = String(title.typhoonNumber ?? "").trim();
  return {
    official: true,
    source: "日本气象厅 JMA",
    sourceUrl,
    advisory: typhoonNumber ? `台风编号 ${typhoonNumber}` : undefined,
    issuedAt,
    forecastValidUntil: track[track.length - 1].forecastAt,
    track,
    trackGeometry: { type: "LineString", coordinates: track.map((point) => [point.longitude, point.latitude]) },
    uncertaintyGeometry: polygonGeometry(uncertaintyRings),
    uncertaintyLabel: "JMA 官方预报圆（台风中心进入概率约 70%）",
    impactGeometry,
    impactField: buildHourlyCycloneImpactField(track, impactSlices, polygonGeometry(uncertaintyRings)),
    impactBasis: impactGeometry ? "current_wind_extent" : "uncertainty_only",
    impactThreshold: impactGeometry ? "当前强风警戒域（约 ≥15 m/s）" : undefined,
    note: "预报路径和预报圆会随报次更新；预报圆表示中心位置不确定性，不等同于受灾范围。强风警戒域仅表示当前强风影响边界。",
  };
}

export function circleRing(latitude: number, longitude: number, radiusMeters: number, steps = 72): Coordinate[] {
  const angular = radiusMeters / 6_371_008.8;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const ring: Coordinate[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const bearing = 2 * Math.PI * index / steps;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([normalizeLongitude(lon2 * 180 / Math.PI), lat2 * 180 / Math.PI]);
  }
  return ring;
}

function findEndOfCentralDirectory(view: DataView) {
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function placemarks(kml: string) {
  return [...kml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)].map((match) => match[0]);
}

function firstCoordinate(value: string): Coordinate | undefined {
  const coordinates = parseCoordinates(value.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i)?.[1] ?? "");
  return coordinates[0];
}

function polygonRings(value: string): Coordinate[][] {
  return [...value.matchAll(/<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi)].flatMap((polygon) => {
    const outer = polygon[1].match(/<outerBoundaryIs\b[^>]*>([\s\S]*?)<\/outerBoundaryIs>/i)?.[1] ?? polygon[1];
    const ring = parseCoordinates(outer.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i)?.[1] ?? "");
    if (ring.length < 3) return [];
    if (!sameCoordinate(ring[0], ring[ring.length - 1])) ring.push([...ring[0]] as Coordinate);
    return [ring];
  });
}

function parseCoordinates(value: string): Coordinate[] {
  return value.trim().split(/\s+/).flatMap((token): Coordinate[] => {
    const [longitude, latitude] = token.split(",").map(Number);
    return Number.isFinite(longitude) && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? [[longitude, latitude]] : [];
  });
}

function polygonGeometry(rings: Coordinate[][]): EventGeometry | undefined {
  const valid = rings.filter((ring) => ring.length >= 4 && sameCoordinate(ring[0], ring[ring.length - 1]));
  if (!valid.length) return undefined;
  return valid.length === 1 ? { type: "Polygon", coordinates: [valid[0]] } : { type: "MultiPolygon", coordinates: valid.map((ring) => [ring]) };
}

function sameCoordinate(left: Coordinate, right: Coordinate) {
  return left[0] === right[0] && left[1] === right[1];
}

function numericMatch(value: string, expression: RegExp) {
  const parsed = Number(value.match(expression)?.[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extendedDataValue(value: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stripTags(value.match(new RegExp(`<Data\\s+name=["']${escaped}["'][^>]*>[\\s\\S]*?<value[^>]*>([\\s\\S]*?)<\\/value>`, "i"))?.[1] ?? "") || undefined;
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function recordArray(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  return [];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function isoAt(value: unknown, key: string) {
  const candidate = asRecord(value)?.[key];
  if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) return undefined;
  return new Date(candidate).toISOString();
}

function coordinateFromLatLonArray(value: unknown): Coordinate | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const latitude = Number(value[0]);
  const longitude = Number(value[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  return [longitude, latitude];
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localizedValue(value: unknown) {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record?.en ?? record?.jp ?? "");
}

function normalizeLongitude(value: number) {
  return ((value + 540) % 360) - 180;
}

function nearestTrackPoint(track: CycloneForecastPoint[], leadHours: number) {
  if (!track.length) return undefined;
  return [...track].sort((left, right) => Math.abs(left.leadHours - leadHours) - Math.abs(right.leadHours - leadHours))[0];
}

function interpolateTrackPoint(track: CycloneForecastPoint[], leadHours: number) {
  const exact = track.find((point) => point.leadHours === leadHours);
  if (exact) return exact;
  const lower = [...track].reverse().find((point) => point.leadHours < leadHours);
  const upper = track.find((point) => point.leadHours > leadHours);
  if (!lower || !upper || upper.leadHours === lower.leadHours) return undefined;
  const ratio = (leadHours - lower.leadHours) / (upper.leadHours - lower.leadHours);
  const upperLongitude = unwrapLongitude(upper.longitude, lower.longitude);
  return {
    latitude: lower.latitude + (upper.latitude - lower.latitude) * ratio,
    longitude: normalizeLongitude(lower.longitude + (upperLongitude - lower.longitude) * ratio),
  };
}

function interpolateOptionalNumber(lower: OfficialImpactSlice | undefined, upper: OfficialImpactSlice | undefined, leadHours: number, key: "uncertaintyRadiusKm") {
  const lowerValue = lower?.[key];
  const upperValue = upper?.[key];
  if (lowerValue === undefined || upperValue === undefined || !lower || !upper || upper.leadHours === lower.leadHours) return undefined;
  const ratio = (leadHours - lower.leadHours) / (upper.leadHours - lower.leadHours);
  return lowerValue + (upperValue - lowerValue) * ratio;
}

function interpolateWindFields(lower: OfficialImpactSlice | undefined, upper: OfficialImpactSlice | undefined, leadHours: number): CycloneWindField[] {
  if (!lower || !upper || lower.leadHours === upper.leadHours) return [];
  const ratio = (leadHours - lower.leadHours) / (upper.leadHours - lower.leadHours);
  const upperByThreshold = new Map(upper.windFields.map((field) => [field.thresholdKnots, field]));
  return lower.windFields.flatMap((field): CycloneWindField[] => {
    const next = upperByThreshold.get(field.thresholdKnots);
    if (!next) return [];
    return [{
      thresholdKnots: field.thresholdKnots,
      quadrantsKm: mapQuadrants(field.quadrantsKm, next.quadrantsKm, (left, right) => left + (right - left) * ratio),
      basis: "interpolated_official_fields",
    }];
  });
}

function quadrantRadiiFromRings(rings: Coordinate[][], latitude: number, longitude: number): CycloneQuadrantRadiiKm {
  const radii = equalQuadrants(0);
  rings.flat().forEach(([candidateLongitude, candidateLatitude]) => {
    const distance = greatCircleDistanceKm(latitude, longitude, candidateLatitude, candidateLongitude);
    const bearing = initialBearing(latitude, longitude, candidateLatitude, candidateLongitude);
    if (bearing < 90) radii.northeast = Math.max(radii.northeast, distance);
    else if (bearing < 180) radii.southeast = Math.max(radii.southeast, distance);
    else if (bearing < 270) radii.southwest = Math.max(radii.southwest, distance);
    else radii.northwest = Math.max(radii.northwest, distance);
  });
  return mapQuadrants(radii, radii, (value) => Number(value.toFixed(2)));
}

function maximumQuadrantRadius(radii: CycloneQuadrantRadiiKm) {
  return Math.max(radii.northeast, radii.southeast, radii.southwest, radii.northwest);
}

function equalQuadrants(radiusKm: number): CycloneQuadrantRadiiKm {
  return { northeast: radiusKm, southeast: radiusKm, southwest: radiusKm, northwest: radiusKm };
}

function mapQuadrants(left: CycloneQuadrantRadiiKm, right: CycloneQuadrantRadiiKm, mapper: (left: number, right: number) => number): CycloneQuadrantRadiiKm {
  return {
    northeast: mapper(left.northeast, right.northeast),
    southeast: mapper(left.southeast, right.southeast),
    southwest: mapper(left.southwest, right.southwest),
    northwest: mapper(left.northwest, right.northwest),
  };
}

function interpolatedQuadrantRadius(radii: CycloneQuadrantRadiiKm, bearing: number) {
  const centers = [
    { bearing: -45, radius: radii.northwest },
    { bearing: 45, radius: radii.northeast },
    { bearing: 135, radius: radii.southeast },
    { bearing: 225, radius: radii.southwest },
    { bearing: 315, radius: radii.northwest },
    { bearing: 405, radius: radii.northeast },
  ];
  const normalized = bearing < -45 ? bearing + 360 : bearing;
  const upperIndex = centers.findIndex((item) => item.bearing >= normalized);
  const upper = centers[Math.max(1, upperIndex)];
  const lower = centers[Math.max(0, upperIndex - 1)];
  const ratio = (normalized - lower.bearing) / (upper.bearing - lower.bearing);
  return lower.radius + (upper.radius - lower.radius) * ratio;
}

function destinationCoordinate(latitude: number, longitude: number, distanceKm: number, bearingDeg: number): Coordinate {
  const angular = distanceKm / 6371.0088;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return [normalizeLongitude(lon2 * 180 / Math.PI), lat2 * 180 / Math.PI];
}

function greatCircleDistanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const radians = Math.PI / 180;
  const lat1 = latitude1 * radians;
  const lat2 = latitude2 * radians;
  const deltaLat = (latitude2 - latitude1) * radians;
  const deltaLon = (unwrapLongitude(longitude2, longitude1) - longitude1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const radians = Math.PI / 180;
  const lat1 = latitude1 * radians;
  const lat2 = latitude2 * radians;
  const deltaLon = (unwrapLongitude(longitude2, longitude1) - longitude1) * radians;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function unwrapLongitude(longitude: number, reference: number) {
  let result = longitude;
  while (result - reference > 180) result -= 360;
  while (result - reference < -180) result += 360;
  return result;
}
