import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiangsuIndexSchema, defaultGridSizeDegrees, jiangsuIndexSchemaVersion, parseOsmPoly, writeMetadata } from "./index-core.mjs";

const sourceUrl = "https://download.geofabrik.de/asia/china/jiangsu.html";

export function buildJiangsuIndex({ gpkgPath, polyPath, outputPath, sourceTimestamp, gridSizeDegrees = defaultGridSizeDegrees }) {
  const source = resolve(gpkgPath);
  const boundary = resolve(polyPath);
  const output = resolve(outputPath);
  if (!statSync(source).isFile() || !statSync(boundary).isFile()) throw new Error("江苏 GeoPackage 或覆盖边界文件不存在");
  const timestamp = new Date(sourceTimestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("江苏 OSM 数据时点无效");
  const gridSize = Math.max(0.001, Math.min(0.05, Number(gridSizeDegrees) || defaultGridSizeDegrees));
  const coverage = parseOsmPoly(readFileSync(boundary, "utf8"));
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  const database = new DatabaseSync(temporary);
  try {
    createJiangsuIndexSchema(database);
    database.exec(`ATTACH DATABASE ${sqlLiteral(source)} AS source`);
    const layers = database.prepare(`
      SELECT g.table_name, g.column_name, upper(g.geometry_type_name) AS geometry_type
      FROM source.gpkg_geometry_columns g
      JOIN source.gpkg_contents c ON c.table_name = g.table_name
      WHERE c.data_type = 'features'
    `).all().map((row) => ({ table: String(row.table_name), geometry: String(row.column_name), geometryType: String(row.geometry_type) }));
    const buildingLayers = layers.filter((layer) => /buildings?/i.test(layer.table));
    const roadLayers = layers.filter((layer) => /roads?/i.test(layer.table));
    const poiLayers = layers.filter((layer) => /pois?/i.test(layer.table));
    if (!buildingLayers.length || !roadLayers.length || !poiLayers.length) {
      throw new Error(`江苏 GeoPackage 缺少必要图层：building=${buildingLayers.length}, road=${roadLayers.length}, poi=${poiLayers.length}`);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const layer of buildingLayers) aggregateLayer(database, layer, gridSize, "building_count");
      for (const layer of roadLayers) aggregateLayer(database, layer, gridSize, "road_way_count");
      for (const layer of poiLayers) importFacilities(database, layer, gridSize);
      writeMetadata(database, {
        schema_version: jiangsuIndexSchemaVersion,
        source_timestamp: timestamp.toISOString(),
        generated_at: new Date().toISOString(),
        source_url: sourceUrl,
        grid_size_degrees: gridSize,
        coverage_geojson: JSON.stringify(coverage),
        building_layers: buildingLayers.map((layer) => layer.table).join(","),
        road_layers: roadLayers.map((layer) => layer.table).join(","),
        poi_layers: poiLayers.map((layer) => layer.table).join(","),
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.exec("ANALYZE");
  } finally {
    database.close();
  }
  renameSync(temporary, output);
  return output;
}

function aggregateLayer(database, layer, gridSize, countColumn) {
  const rtree = rtreeTable(database, layer);
  const column = countColumn === "building_count" ? "building_count" : "road_way_count";
  if (!rtree) {
    aggregateLayerFromGeometryHeaders(database, layer, gridSize, column);
    return;
  }
  database.exec(`
    INSERT INTO grid_cells(cell_x, cell_y, ${column})
    SELECT
      CAST(((((r.minx + r.maxx) / 2.0) + 180.0) / ${gridSize}) AS INTEGER) AS cell_x,
      CAST(((((r.miny + r.maxy) / 2.0) + 90.0) / ${gridSize}) AS INTEGER) AS cell_y,
      COUNT(*) AS feature_count
    FROM source.${quoteIdentifier(rtree)} r
    WHERE r.minx BETWEEN -180 AND 180 AND r.maxx BETWEEN -180 AND 180
      AND r.miny BETWEEN -90 AND 90 AND r.maxy BETWEEN -90 AND 90
    GROUP BY cell_x, cell_y
    ON CONFLICT(cell_x, cell_y) DO UPDATE SET ${column} = ${column} + excluded.${column};
  `);
}

function aggregateLayerFromGeometryHeaders(database, layer, gridSize, column) {
  const counts = new Map();
  const rows = database.prepare(`SELECT ${quoteIdentifier(layer.geometry)} AS geometry FROM source.${quoteIdentifier(layer.table)}`).iterate();
  for (const row of rows) {
    const center = readGeoPackageEnvelopeCenter(row.geometry);
    if (!center) continue;
    const cellX = Math.trunc((center.longitude + 180) / gridSize);
    const cellY = Math.trunc((center.latitude + 90) / gridSize);
    const key = `${cellX},${cellY}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const statement = database.prepare(`
    INSERT INTO grid_cells(cell_x, cell_y, ${column}) VALUES (?, ?, ?)
    ON CONFLICT(cell_x, cell_y) DO UPDATE SET ${column} = ${column} + excluded.${column}
  `);
  for (const [key, count] of counts) {
    const [cellX, cellY] = key.split(",").map(Number);
    statement.run(cellX, cellY, count);
  }
}

function importFacilities(database, layer, gridSize) {
  const columns = new Set(database.prepare(`PRAGMA source.table_info(${sqlLiteral(layer.table)})`).all().map((row) => String(row.name)));
  if (!["osm_id", "fclass"].every((column) => columns.has(column))) return;
  const rtree = rtreeTable(database, layer);
  if (!rtree) {
    importFacilitiesFromGeometryHeaders(database, layer, gridSize, columns);
    return;
  }
  const typeExpression = `CASE WHEN CAST(t.osm_id AS INTEGER) < 0 THEN 'relation' WHEN ${sqlLiteral(layer.geometryType)} = 'POINT' THEN 'node' ELSE 'way' END`;
  const nameExpression = columns.has("name") ? "COALESCE(NULLIF(trim(t.name), ''), replace(t.fclass, '_', ' '))" : "replace(t.fclass, '_', ' ')";
  const kindExpression = facilityKindExpression("t.fclass");
  database.exec(`
    INSERT OR IGNORE INTO facilities(id, osm_type, osm_id, kind, name, fclass, longitude, latitude, cell_x, cell_y)
    SELECT
      (${typeExpression}) || ':' || abs(CAST(t.osm_id AS INTEGER)),
      ${typeExpression},
      abs(CAST(t.osm_id AS INTEGER)),
      ${kindExpression},
      substr(${nameExpression}, 1, 160),
      substr(t.fclass, 1, 80),
      (r.minx + r.maxx) / 2.0,
      (r.miny + r.maxy) / 2.0,
      CAST(((((r.minx + r.maxx) / 2.0) + 180.0) / ${gridSize}) AS INTEGER),
      CAST(((((r.miny + r.maxy) / 2.0) + 90.0) / ${gridSize}) AS INTEGER)
    FROM source.${quoteIdentifier(layer.table)} t
    JOIN source.${quoteIdentifier(rtree)} r ON r.id = t.rowid
    WHERE CAST(t.osm_id AS INTEGER) != 0
      AND (${kindExpression}) IS NOT NULL
      AND r.minx BETWEEN -180 AND 180 AND r.maxx BETWEEN -180 AND 180
      AND r.miny BETWEEN -90 AND 90 AND r.maxy BETWEEN -90 AND 90;
  `);
}

function importFacilitiesFromGeometryHeaders(database, layer, gridSize, columns) {
  const nameColumn = columns.has("name") ? `${quoteIdentifier("name")} AS name` : "NULL AS name";
  const rows = database.prepare(`
    SELECT ${quoteIdentifier("osm_id")} AS osm_id, ${quoteIdentifier("fclass")} AS fclass,
      ${nameColumn}, ${quoteIdentifier(layer.geometry)} AS geometry
    FROM source.${quoteIdentifier(layer.table)}
  `).iterate();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO facilities(id, osm_type, osm_id, kind, name, fclass, longitude, latitude, cell_x, cell_y)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const kind = facilityKind(row.fclass);
    const center = readGeoPackageEnvelopeCenter(row.geometry);
    const signedOsmId = Number(row.osm_id);
    if (!kind || !center || !Number.isSafeInteger(signedOsmId) || signedOsmId === 0) continue;
    const osmId = Math.abs(signedOsmId);
    const osmType = signedOsmId < 0 ? "relation" : layer.geometryType === "POINT" ? "node" : "way";
    const fclass = String(row.fclass ?? "").slice(0, 80);
    const name = String(row.name ?? "").trim().slice(0, 160) || fclass.replaceAll("_", " ");
    const cellX = Math.trunc((center.longitude + 180) / gridSize);
    const cellY = Math.trunc((center.latitude + 90) / gridSize);
    insert.run(`${osmType}:${osmId}`, osmType, osmId, kind, name, fclass, center.longitude, center.latitude, cellX, cellY);
  }
}

function facilityKind(value) {
  const fclass = String(value ?? "");
  if (["hospital", "clinic", "doctors", "dentist", "pharmacy"].includes(fclass)) return "health";
  if (["fire_station", "police"].includes(fclass)) return "emergency";
  if (["shelter", "community_centre"].includes(fclass)) return "shelter";
  if (["school", "kindergarten", "college", "university"].includes(fclass)) return "education";
  if (["power_plant", "power_station", "substation"].includes(fclass)) return "power";
  if (["water_tower", "wastewater_plant", "water_works", "pumping_station"].includes(fclass)) return "water";
  return null;
}

export function readGeoPackageEnvelopeCenter(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 8 || value[0] !== 0x47 || value[1] !== 0x50) return null;
  const flags = value[3];
  const littleEndian = (flags & 1) === 1;
  const envelopeIndicator = (flags >> 1) & 7;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (envelopeIndicator === 0) return readGeoPackagePoint(view, 8);
  if (envelopeIndicator > 4 || value.byteLength < 40) return null;
  const minimumX = view.getFloat64(8, littleEndian);
  const maximumX = view.getFloat64(16, littleEndian);
  const minimumY = view.getFloat64(24, littleEndian);
  const maximumY = view.getFloat64(32, littleEndian);
  const longitude = (minimumX + maximumX) / 2;
  const latitude = (minimumY + maximumY) / 2;
  if (![minimumX, maximumX, minimumY, maximumY, longitude, latitude].every(Number.isFinite)) return null;
  if (minimumX < -180 || maximumX > 180 || minimumY < -90 || maximumY > 90) return null;
  return { longitude, latitude };
}

function readGeoPackagePoint(view, offset) {
  if (view.byteLength < offset + 21) return null;
  const littleEndian = view.getUint8(offset) === 1;
  const geometryType = view.getUint32(offset + 1, littleEndian);
  const isPoint = geometryType === 1 || geometryType % 1000 === 1 || (geometryType & 0xffff) === 1;
  if (!isPoint) return null;
  const longitude = view.getFloat64(offset + 5, littleEndian);
  const latitude = view.getFloat64(offset + 13, littleEndian);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
  return { longitude, latitude };
}

function facilityKindExpression(column) {
  return `CASE
    WHEN ${column} IN ('hospital','clinic','doctors','dentist','pharmacy') THEN 'health'
    WHEN ${column} IN ('fire_station','police') THEN 'emergency'
    WHEN ${column} IN ('shelter','community_centre') THEN 'shelter'
    WHEN ${column} IN ('school','kindergarten','college','university') THEN 'education'
    WHEN ${column} IN ('power_plant','power_station','substation') THEN 'power'
    WHEN ${column} IN ('water_tower','wastewater_plant','water_works','pumping_station') THEN 'water'
    ELSE NULL END`;
}

function rtreeTable(database, layer) {
  const name = `rtree_${layer.table}_${layer.geometry}`;
  const row = database.prepare("SELECT name FROM source.sqlite_master WHERE type='table' AND name=?").get(name);
  return row ? name : null;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("参数格式应为 --name value");
    values[key.slice(2)] = value;
  }
  for (const required of ["gpkg", "poly", "out", "source-timestamp"]) if (!values[required]) throw new Error(`缺少 --${required}`);
  return values;
}

// Deployments invoke this script through /opt/tianxun/current, which is a symlink
// to a versioned release. Compare canonical paths so the CLI still executes.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const argumentsMap = parseArguments(process.argv.slice(2));
    const output = buildJiangsuIndex({
      gpkgPath: argumentsMap.gpkg,
      polyPath: argumentsMap.poly,
      outputPath: argumentsMap.out,
      sourceTimestamp: argumentsMap["source-timestamp"],
      gridSizeDegrees: argumentsMap["grid-size"],
    });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "江苏 OSM 索引构建失败"}\n`);
    process.exitCode = 1;
  }
}
