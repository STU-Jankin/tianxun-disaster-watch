export type SupportedGeometry = {
  type: "Point" | "LineString" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type GeometryValidation = {
  ok: boolean;
  reason?: string;
  vertices: number;
  areaKm2: number;
  crossesAntimeridian: boolean;
};

type Coordinate = [number, number];
type PolygonCoordinates = Coordinate[][];

const EARTH_RADIUS_KM = 6371.0088;
const EPSILON = 1e-10;

export function validateGeoGeometry(
  value: unknown,
  options: {
    maximumVertices?: number;
    maximumRingVertices?: number;
    maximumAreaKm2?: number;
    rejectUnsplitAntimeridian?: boolean;
  } = {},
): GeometryValidation {
  const maximumVertices = options.maximumVertices ?? 10_000;
  const maximumRingVertices = options.maximumRingVertices ?? 2_000;
  const maximumAreaKm2 = options.maximumAreaKm2 ?? 25_000_000;
  let vertices = 0;
  let crossesAntimeridian = false;

  const fail = (reason: string): GeometryValidation => ({ ok: false, reason, vertices, areaKm2: 0, crossesAntimeridian });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("几何对象结构无效");
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (!["Point", "LineString", "Polygon", "MultiPolygon"].includes(String(geometry.type))) return fail("不支持的几何类型");

  const coordinate = (candidate: unknown): Coordinate | null => {
    if (!Array.isArray(candidate) || candidate.length < 2) return null;
    const longitude = Number(candidate[0]);
    const latitude = Number(candidate[1]);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
    vertices += 1;
    return vertices <= maximumVertices ? [longitude, latitude] : null;
  };

  if (geometry.type === "Point") {
    return coordinate(geometry.coordinates)
      ? { ok: true, vertices, areaKm2: 0, crossesAntimeridian: false }
      : fail("点坐标无效");
  }
  if (geometry.type === "LineString") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.length > maximumRingVertices) return fail("线坐标数量无效");
    const line = geometry.coordinates.map(coordinate);
    if (line.some((item) => !item)) return fail("线坐标无效或超过顶点上限");
    crossesAntimeridian = hasAntimeridianJump(line as Coordinate[]);
    if (crossesAntimeridian && options.rejectUnsplitAntimeridian) return fail("几何跨越日期变更线但未切分");
    return { ok: true, vertices, areaKm2: 0, crossesAntimeridian };
  }

  const parsePolygon = (candidate: unknown): { ok: true; rings: PolygonCoordinates; areaKm2: number } | { ok: false; reason: string } => {
    if (!Array.isArray(candidate) || !candidate.length || candidate.length > 100) return { ok: false, reason: "多边形环结构无效" };
    const rings: PolygonCoordinates = [];
    for (const rawRing of candidate) {
      if (!Array.isArray(rawRing) || rawRing.length < 4 || rawRing.length > maximumRingVertices) return { ok: false, reason: "多边形环顶点数无效" };
      const parsed = rawRing.map(coordinate);
      if (parsed.some((item) => !item)) return { ok: false, reason: "多边形坐标无效或超过顶点上限" };
      const ring = parsed as Coordinate[];
      if (!sameCoordinate(ring[0], ring[ring.length - 1])) return { ok: false, reason: "多边形环未闭合" };
      const distinct = new Set(ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
      if (distinct.size < 3) return { ok: false, reason: "多边形环退化为线或点" };
      const unwrapped = unwrapRing(ring);
      crossesAntimeridian ||= hasAntimeridianJump(ring);
      if (Math.abs(planarSignedArea(unwrapped)) < EPSILON) return { ok: false, reason: "多边形环面积为零" };
      if (ringSelfIntersects(unwrapped)) return { ok: false, reason: "多边形环存在自相交" };
      rings.push(ring);
    }
    if (crossesAntimeridian && options.rejectUnsplitAntimeridian) return { ok: false, reason: "多边形跨越日期变更线但未切分" };
    const unwrappedOuter = unwrapRing(rings[0]);
    for (let index = 1; index < rings.length; index += 1) {
      const hole = unwrapRingRelative(rings[index], unwrappedOuter[0][0]);
      if (!pointInRing(hole[0], unwrappedOuter) || ringsIntersect(unwrappedOuter, hole)) return { ok: false, reason: "多边形洞不在外环内或与外环相交" };
      for (let previous = 1; previous < index; previous += 1) {
        const other = unwrapRingRelative(rings[previous], unwrappedOuter[0][0]);
        if (ringsIntersect(other, hole) || pointInRing(hole[0], other) || pointInRing(other[0], hole)) return { ok: false, reason: "多边形洞之间重叠或相交" };
      }
    }
    const areaKm2 = Math.max(0, Math.abs(sphericalRingAreaKm2(rings[0])) - rings.slice(1).reduce((sum, ring) => sum + Math.abs(sphericalRingAreaKm2(ring)), 0));
    if (!Number.isFinite(areaKm2) || areaKm2 <= 1e-8) return { ok: false, reason: "多边形有效面积为零" };
    return { ok: true, rings, areaKm2 };
  };

  const rawPolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(rawPolygons) || !rawPolygons.length || rawPolygons.length > 100) return fail("复合多边形结构无效");
  const polygons: Array<{ rings: PolygonCoordinates; areaKm2: number }> = [];
  for (const rawPolygon of rawPolygons) {
    const parsed = parsePolygon(rawPolygon);
    if (!parsed.ok) return fail(parsed.reason);
    polygons.push(parsed);
  }
  if (geometry.type === "MultiPolygon") {
    for (let left = 0; left < polygons.length; left += 1) {
      const leftOuter = unwrapRing(polygons[left].rings[0]);
      for (let right = left + 1; right < polygons.length; right += 1) {
        const rightOuter = unwrapRingRelative(polygons[right].rings[0], leftOuter[0][0]);
        if (ringsIntersect(leftOuter, rightOuter) || pointInRing(leftOuter[0], rightOuter) || pointInRing(rightOuter[0], leftOuter)) return fail("复合多边形的分块重叠或相交");
      }
    }
  }
  const areaKm2 = polygons.reduce((sum, polygon) => sum + polygon.areaKm2, 0);
  if (areaKm2 > maximumAreaKm2) return fail(`AOI 面积 ${Math.round(areaKm2).toLocaleString()} km² 超过上限`);
  return { ok: true, vertices, areaKm2, crossesAntimeridian };
}

export function normalizeAntimeridianGeometry(value: SupportedGeometry): SupportedGeometry | null {
  if (value.type === "Point") return value;
  if (value.type === "LineString") return hasAntimeridianJump(value.coordinates as Coordinate[]) ? null : value;
  const polygons = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (!Array.isArray(polygons)) return null;
  const normalized: PolygonCoordinates[] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    const rings = polygon as PolygonCoordinates;
    if (!hasAntimeridianJump(rings[0])) {
      normalized.push(rings);
      continue;
    }
    // A hole crossing the date line needs a full polygon clipping engine. Fail
    // closed instead of silently changing the covered area.
    if (rings.length > 1) return null;
    const parts = splitAntimeridianRing(rings[0]);
    if (parts.length < 2) return null;
    normalized.push(...parts.map((ring) => [ring]));
  }
  if (!normalized.length) return null;
  return normalized.length === 1
    ? { type: "Polygon", coordinates: normalized[0] }
    : { type: "MultiPolygon", coordinates: normalized };
}

export function splitAntimeridianRing(ring: Coordinate[]): Coordinate[][] {
  if (!hasAntimeridianJump(ring)) return [ring];
  const unwrapped = unwrapRing(ring);
  const maximum = Math.max(...unwrapped.map(([longitude]) => longitude));
  const minimum = Math.min(...unwrapped.map(([longitude]) => longitude));
  if (maximum - minimum >= 360) return [];
  const boundary = maximum > 180 ? 180 : minimum < -180 ? -180 : null;
  if (boundary === null) return [ring];
  const insideSide = boundary === 180 ? "less" : "greater";
  const outsideSide = boundary === 180 ? "greater" : "less";
  const inside = clipVertical(unwrapped, boundary, insideSide).map(([lon, lat]) => [normalizeLongitude(lon), lat] as Coordinate);
  const outside = clipVertical(unwrapped, boundary, outsideSide).map(([lon, lat]) => [normalizeLongitude(lon + (boundary === 180 ? -360 : 360)), lat] as Coordinate);
  return [inside, outside].filter((part) => part.length >= 4 && Math.abs(planarSignedArea(unwrapRing(part))) > EPSILON);
}

function clipVertical(ring: Coordinate[], boundary: number, side: "less" | "greater") {
  const result: Coordinate[] = [];
  const inside = ([longitude]: Coordinate) => side === "less" ? longitude <= boundary + EPSILON : longitude >= boundary - EPSILON;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index];
    const end = ring[index + 1];
    const startInside = inside(start);
    const endInside = inside(end);
    if (startInside) result.push(start);
    if (startInside !== endInside && Math.abs(end[0] - start[0]) > EPSILON) {
      const ratio = (boundary - start[0]) / (end[0] - start[0]);
      result.push([boundary, start[1] + ratio * (end[1] - start[1])]);
    }
  }
  if (result.length && !sameCoordinate(result[0], result[result.length - 1])) result.push([...result[0]] as Coordinate);
  return result;
}

function ringSelfIntersects(ring: Coordinate[]) {
  const segments = ring.length - 1;
  for (let left = 0; left < segments; left += 1) {
    for (let right = left + 1; right < segments; right += 1) {
      if (Math.abs(left - right) <= 1 || (left === 0 && right === segments - 1)) continue;
      if (segmentsIntersect(ring[left], ring[left + 1], ring[right], ring[right + 1])) return true;
    }
  }
  return false;
}

function ringsIntersect(left: Coordinate[], right: Coordinate[]) {
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      if (segmentsIntersect(left[leftIndex], left[leftIndex + 1], right[rightIndex], right[rightIndex + 1])) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Coordinate, b: Coordinate, c: Coordinate, d: Coordinate) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 * o2 < -EPSILON && o3 * o4 < -EPSILON) return true;
  return (Math.abs(o1) <= EPSILON && onSegment(a, b, c))
    || (Math.abs(o2) <= EPSILON && onSegment(a, b, d))
    || (Math.abs(o3) <= EPSILON && onSegment(c, d, a))
    || (Math.abs(o4) <= EPSILON && onSegment(c, d, b));
}

function orientation(a: Coordinate, b: Coordinate, c: Coordinate) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Coordinate, b: Coordinate, point: Coordinate) {
  return point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON
    && point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function pointInRing(point: Coordinate, ring: Coordinate[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index];
    const prior = ring[previous];
    if (((current[1] > point[1]) !== (prior[1] > point[1]))
      && point[0] < (prior[0] - current[0]) * (point[1] - current[1]) / (prior[1] - current[1]) + current[0]) inside = !inside;
  }
  return inside;
}

function sphericalRingAreaKm2(ring: Coordinate[]) {
  const unwrapped = unwrapRing(ring);
  let sum = 0;
  for (let index = 0; index < unwrapped.length - 1; index += 1) {
    const [lon1, lat1] = unwrapped[index].map((value) => value * Math.PI / 180);
    const [lon2, lat2] = unwrapped[index + 1].map((value) => value * Math.PI / 180);
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2);
}

function planarSignedArea(ring: Coordinate[]) {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  return sum / 2;
}

function hasAntimeridianJump(line: Coordinate[]) {
  return line.some((coordinate, index) => index > 0 && Math.abs(coordinate[0] - line[index - 1][0]) > 180);
}

function unwrapRing(ring: Coordinate[]) {
  return unwrapRingRelative(ring, ring[0]?.[0] ?? 0);
}

function unwrapRingRelative(ring: Coordinate[], reference: number) {
  let prior = reference;
  return ring.map(([longitude, latitude], index) => {
    let unwrapped = longitude;
    const anchor = index === 0 ? reference : prior;
    while (unwrapped - anchor > 180) unwrapped -= 360;
    while (unwrapped - anchor < -180) unwrapped += 360;
    prior = unwrapped;
    return [unwrapped, latitude] as Coordinate;
  });
}

function normalizeLongitude(value: number) {
  const normalized = ((value + 540) % 360) - 180;
  return Number((Math.abs(normalized + 180) < EPSILON && value > 0 ? 180 : normalized).toFixed(7));
}

function sameCoordinate(left: Coordinate, right: Coordinate) {
  return Math.abs(left[0] - right[0]) <= EPSILON && Math.abs(left[1] - right[1]) <= EPSILON;
}
