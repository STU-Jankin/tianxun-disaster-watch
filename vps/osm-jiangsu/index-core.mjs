export const jiangsuIndexSchemaVersion = "tianxun-osm-jiangsu-v1";
export const defaultGridSizeDegrees = 0.01;

export function createJiangsuIndexSchema(database) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE grid_cells (
      cell_x INTEGER NOT NULL,
      cell_y INTEGER NOT NULL,
      building_count INTEGER NOT NULL DEFAULT 0 CHECK (building_count >= 0),
      road_way_count INTEGER NOT NULL DEFAULT 0 CHECK (road_way_count >= 0),
      PRIMARY KEY (cell_x, cell_y)
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE facilities (
      id TEXT PRIMARY KEY,
      osm_type TEXT NOT NULL CHECK (osm_type IN ('node', 'way', 'relation')),
      osm_id INTEGER NOT NULL CHECK (osm_id > 0),
      kind TEXT NOT NULL CHECK (kind IN ('health', 'emergency', 'shelter', 'education', 'power', 'water')),
      name TEXT NOT NULL,
      fclass TEXT NOT NULL,
      longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
      latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
      cell_x INTEGER NOT NULL,
      cell_y INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX facilities_cell_idx ON facilities(cell_x, cell_y);
    CREATE INDEX facilities_kind_idx ON facilities(kind);
  `);
}

export function parseOsmPoly(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("江苏 OSM 覆盖边界为空");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 5) throw new Error("江苏 OSM 覆盖边界格式无效");
  const polygons = [];
  let current = null;
  let ring = null;
  let hole = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "END") {
      if (ring) {
        closeRing(ring);
        if (ring.length >= 4) {
          if (hole && current) current.push(ring);
          else {
            current = [ring];
            polygons.push(current);
          }
        }
        ring = null;
      } else {
        break;
      }
      continue;
    }
    const coordinate = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(line);
    if (coordinate) {
      if (!ring) throw new Error("江苏 OSM 覆盖边界缺少环标识");
      const longitude = Number(coordinate[1]);
      const latitude = Number(coordinate[2]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error("江苏 OSM 覆盖边界坐标无效");
      ring.push([longitude, latitude]);
      continue;
    }
    hole = line.startsWith("!");
    ring = [];
  }
  if (!polygons.length) throw new Error("江苏 OSM 覆盖边界没有有效多边形");
  return { type: "MultiPolygon", coordinates: polygons };
}

export function validateScreeningGeometry(value, maximumVertices = 20_000) {
  if (!value || typeof value !== "object" || !["Polygon", "MultiPolygon"].includes(value.type)) throw new Error("AOI 仅支持 Polygon 或 MultiPolygon");
  const polygons = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (!Array.isArray(polygons) || !polygons.length || polygons.length > 64) throw new Error("AOI 多边形数量无效");
  let vertices = 0;
  const normalized = polygons.map((polygon) => {
    if (!Array.isArray(polygon) || !polygon.length) throw new Error("AOI 多边形没有外环");
    return polygon.map((rawRing) => {
      if (!Array.isArray(rawRing) || rawRing.length < 4) throw new Error("AOI 环至少需要 4 个坐标");
      const ring = rawRing.map((rawPoint) => {
        if (!Array.isArray(rawPoint) || rawPoint.length < 2) throw new Error("AOI 坐标无效");
        const longitude = Number(rawPoint[0]);
        const latitude = Number(rawPoint[1]);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error("AOI 坐标超出 WGS 84 范围");
        vertices += 1;
        if (vertices > maximumVertices) throw new Error(`AOI 顶点超过 ${maximumVertices.toLocaleString()} 个`);
        return [longitude, latitude];
      });
      closeRing(ring);
      return ring;
    });
  });
  return value.type === "Polygon" ? { type: "Polygon", coordinates: normalized[0] } : { type: "MultiPolygon", coordinates: normalized };
}

export function geometryBbox(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) {
    west = Math.min(west, point[0]);
    south = Math.min(south, point[1]);
    east = Math.max(east, point[0]);
    north = Math.max(north, point[1]);
  }
  if (![west, south, east, north].every(Number.isFinite)) throw new Error("AOI 无法计算包围盒");
  return [west, south, east, north];
}

export function pointInGeometry(point, geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

export function geometryContainedByCoverage(geometry, coverage) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) {
    for (let index = 1; index < ring.length; index += 1) {
      const start = ring[index - 1];
      const end = ring[index];
      for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
        const point = [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
        if (!pointInGeometry(point, coverage)) return false;
      }
    }
  }
  return true;
}

export function queryJiangsuExposureIndex(database, rawGeometry, options = {}) {
  const geometry = validateScreeningGeometry(rawGeometry);
  const metadata = readMetadata(database);
  if (metadata.schema_version !== jiangsuIndexSchemaVersion) throw new Error("江苏 OSM 索引版本不兼容");
  const coverage = validateScreeningGeometry(JSON.parse(metadata.coverage_geojson), 100_000);
  if (!geometryContainedByCoverage(geometry, coverage)) {
    return {
      supported: false,
      reason: "AOI 未完整落在江苏数据覆盖边界内，已交由全球 OSM 数据源处理",
      sourceTimestamp: metadata.source_timestamp,
    };
  }
  const gridSizeDegrees = boundedNumber(metadata.grid_size_degrees, defaultGridSizeDegrees, 0.001, 0.1);
  const [west, south, east, north] = geometryBbox(geometry);
  const minCellX = gridCell(west, gridSizeDegrees, 180);
  const maxCellX = gridCell(east, gridSizeDegrees, 180);
  const minCellY = gridCell(south, gridSizeDegrees, 90);
  const maxCellY = gridCell(north, gridSizeDegrees, 90);
  const cells = database.prepare(`
    SELECT cell_x, cell_y, building_count, road_way_count
    FROM grid_cells
    WHERE cell_x BETWEEN ? AND ? AND cell_y BETWEEN ? AND ?
  `).all(minCellX, maxCellX, minCellY, maxCellY);
  let mappedBuildingCount = 0;
  let mappedRoadWayCount = 0;
  for (const row of cells) {
    const center = [cellCenter(row.cell_x, gridSizeDegrees, 180), cellCenter(row.cell_y, gridSizeDegrees, 90)];
    if (!pointInGeometry(center, geometry)) continue;
    mappedBuildingCount += safeCount(row.building_count);
    mappedRoadWayCount += safeCount(row.road_way_count);
  }
  const facilityRows = database.prepare(`
    SELECT id, osm_type, osm_id, kind, name, longitude, latitude
    FROM facilities
    WHERE cell_x BETWEEN ? AND ? AND cell_y BETWEEN ? AND ?
    ORDER BY kind, id
  `).all(minCellX, maxCellX, minCellY, maxCellY);
  const matchedFacilities = facilityRows.filter((row) => pointInGeometry([Number(row.longitude), Number(row.latitude)], geometry));
  const facilityCounts = {};
  for (const facility of matchedFacilities) facilityCounts[facility.kind] = (facilityCounts[facility.kind] ?? 0) + 1;
  const facilityLimit = Math.round(boundedNumber(options.facilityLimit, 300, 1, 300));
  return {
    supported: true,
    provider: "OpenStreetMap · 江苏本地日更索引",
    sourceTimestamp: metadata.source_timestamp,
    generatedAt: metadata.generated_at,
    sourceUrl: metadata.source_url,
    gridSizeDegrees,
    aggregationMethod: "feature_bbox_centroid_grid",
    mappedBuildingCount,
    mappedRoadWayCount,
    mappedKeyFacilityCount: matchedFacilities.length,
    facilityCounts,
    facilities: matchedFacilities.slice(0, facilityLimit).map((facility) => ({
      id: String(facility.id),
      kind: String(facility.kind),
      name: String(facility.name),
      latitude: Number(facility.latitude),
      longitude: Number(facility.longitude),
      osmType: String(facility.osm_type),
      osmId: Number(facility.osm_id),
    })),
    facilitiesTruncated: matchedFacilities.length > facilityLimit,
  };
}

export function writeMetadata(database, values) {
  const statement = database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function readMetadata(database) {
  return Object.fromEntries(database.prepare("SELECT key, value FROM metadata").all().map((row) => [String(row.key), String(row.value)]));
}

function pointInPolygon(point, polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
    const left = ring[index];
    const right = ring[prior];
    if (pointOnSegment(point, left, right)) return true;
    const crosses = (left[1] > point[1]) !== (right[1] > point[1])
      && point[0] < ((right[0] - left[0]) * (point[1] - left[1])) / ((right[1] - left[1]) || Number.EPSILON) + left[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-10) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-10 && point[0] <= Math.max(start[0], end[0]) + 1e-10
    && point[1] >= Math.min(start[1], end[1]) - 1e-10 && point[1] <= Math.max(start[1], end[1]) + 1e-10;
}

function closeRing(ring) {
  if (!ring.length) return;
  const first = ring[0];
  const last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
}

function gridCell(value, size, offset) {
  return Math.floor((value + offset) / size);
}

function cellCenter(cell, size, offset) {
  return (Number(cell) + 0.5) * size - offset;
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
