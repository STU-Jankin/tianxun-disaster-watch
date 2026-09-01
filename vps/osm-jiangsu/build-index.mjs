import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

function importFacilities(database, layer, gridSize) {
  const columns = new Set(database.prepare(`PRAGMA source.table_info(${sqlLiteral(layer.table)})`).all().map((row) => String(row.name)));
  if (!["osm_id", "fclass"].every((column) => columns.has(column))) return;
  const rtree = rtreeTable(database, layer);
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
  if (!row) throw new Error(`江苏 GeoPackage 图层 ${layer.table} 缺少 RTree 空间索引`);
  return name;
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
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
