import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildJiangsuIndex, readGeoPackageEnvelopeCenter } from "../vps/osm-jiangsu/build-index.mjs";
import { geometriesIntersect, parseOsmPoly, queryJiangsuExposureIndex } from "../vps/osm-jiangsu/index-core.mjs";

const jiangsuPoly = `jiangsu
1
  116.0 30.0
  123.0 30.0
  123.0 36.0
  116.0 36.0
  116.0 30.0
END
END
`;

test("parses Geofabrik poly coverage and rejects an AOI outside Jiangsu", () => {
  const coverage = parseOsmPoly(jiangsuPoly);
  assert.equal(coverage.type, "MultiPolygon");
  assert.equal(coverage.coordinates.length, 1);
});

test("parses the scientific notation used by the live Geofabrik Jiangsu boundary", () => {
  const coverage = parseOsmPoly(`none
1
  1.163895E+02 3.462742E+01
  1.164895E+02 3.462742E+01
  1.164895E+02 3.472742E+01
  1.163895E+02 3.462742E+01
END
END
`);
  assert.deepEqual(coverage.coordinates[0][0][0], [116.3895, 34.62742]);
});

test("reads a WGS 84 center from a GeoPackage geometry envelope", () => {
  const geometry = Buffer.alloc(40);
  geometry[0] = 0x47;
  geometry[1] = 0x50;
  geometry[3] = 0b00000011; // little endian, XY envelope
  geometry.writeDoubleLE(120.2, 8);
  geometry.writeDoubleLE(120.4, 16);
  geometry.writeDoubleLE(31.4, 24);
  geometry.writeDoubleLE(31.6, 32);
  assert.deepEqual(readGeoPackageEnvelopeCenter(geometry), { longitude: 120.30000000000001, latitude: 31.5 });
});

test("reads a GeoPackage point when its header omits an optional envelope", () => {
  const geometry = Buffer.alloc(29);
  geometry[0] = 0x47;
  geometry[1] = 0x50;
  geometry[3] = 0b00000001;
  geometry[8] = 1;
  geometry.writeUInt32LE(1, 9);
  geometry.writeDoubleLE(120.31, 13);
  geometry.writeDoubleLE(31.57, 21);
  assert.deepEqual(readGeoPackageEnvelopeCenter(geometry), { longitude: 120.31, latitude: 31.57 });
});

test("recognizes AOIs that cross the Jiangsu boundary as partial coverage", () => {
  const coverage = parseOsmPoly(jiangsuPoly);
  const crossing = rectangle(122.9, 31, 123.1, 31.2);
  const outside = rectangle(124, 31, 125, 32);
  assert.equal(geometriesIntersect(crossing, coverage), true);
  assert.equal(geometriesIntersect(outside, coverage), false);
});

test("builds and queries the Jiangsu screening index without Overpass chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-osm-jiangsu-"));
  const gpkg = join(directory, "jiangsu.gpkg");
  const poly = join(directory, "jiangsu.poly");
  const output = join(directory, "jiangsu.sqlite");
  await writeFile(poly, jiangsuPoly, "utf8");
  createSyntheticGeoPackage(gpkg);
  buildJiangsuIndex({ gpkgPath: gpkg, polyPath: poly, outputPath: output, sourceTimestamp: "2026-08-31T20:21:06Z" });

  const database = new DatabaseSync(output, { readOnly: true });
  try {
    const result = queryJiangsuExposureIndex(database, rectangle(120.20, 31.45, 120.40, 31.65));
    assert.equal(result.supported, true);
    assert.equal(result.coverageMode, "full");
    assert.equal(result.mappedBuildingCount, 2);
    assert.equal(result.mappedRoadWayCount, 1);
    assert.equal(result.mappedKeyFacilityCount, 2);
    assert.deepEqual(result.facilityCounts, { health: 1, emergency: 1 });
    assert.equal(result.facilities.length, 2);
    assert.equal(result.sourceTimestamp, "2026-08-31T20:21:06.000Z");

    const partial = queryJiangsuExposureIndex(database, rectangle(122.9, 31, 123.1, 31.2));
    assert.equal(partial.supported, true);
    assert.equal(partial.coverageMode, "jiangsu_intersection");

    const outside = queryJiangsuExposureIndex(database, rectangle(114, 30, 115, 31));
    assert.equal(outside.supported, false);
    assert.match(outside.reason, /全球 OSM/);
  } finally {
    database.close();
  }
});

function createSyntheticGeoPackage(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE gpkg_contents(table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT);
      CREATE TABLE gpkg_geometry_columns(table_name TEXT, column_name TEXT, geometry_type_name TEXT);
    `);
    for (const [table, geometryType] of [["osm_buildings_free", "MULTIPOLYGON"], ["osm_roads_free", "MULTILINESTRING"], ["osm_pois_free", "POINT"]]) {
      database.exec(`
        CREATE TABLE "${table}"(osm_id INTEGER, code INTEGER, fclass TEXT, name TEXT, geom BLOB);
        CREATE VIRTUAL TABLE "rtree_${table}_geom" USING rtree(id, minx, maxx, miny, maxy);
      `);
      database.prepare("INSERT INTO gpkg_contents(table_name, data_type, identifier) VALUES (?, 'features', ?)").run(table, table);
      database.prepare("INSERT INTO gpkg_geometry_columns(table_name, column_name, geometry_type_name) VALUES (?, 'geom', ?)").run(table, geometryType);
    }
    insertFeature(database, "osm_buildings_free", 1001, "building", "", 120.29, 31.55);
    insertFeature(database, "osm_buildings_free", 1002, "building", "", 120.31, 31.56);
    insertFeature(database, "osm_buildings_free", 1003, "building", "", 118.78, 32.04);
    insertFeature(database, "osm_roads_free", 2001, "residential", "测试道路", 120.30, 31.57);
    insertFeature(database, "osm_roads_free", 2002, "primary", "南京道路", 118.79, 32.05);
    insertFeature(database, "osm_pois_free", 3001, "hospital", "无锡测试医院", 120.30, 31.58);
    insertFeature(database, "osm_pois_free", 3002, "fire_station", "无锡测试消防站", 120.32, 31.59);
    insertFeature(database, "osm_pois_free", 3003, "restaurant", "普通餐厅", 120.33, 31.60);
  } finally {
    database.close();
  }
}

function insertFeature(database, table, osmId, fclass, name, longitude, latitude) {
  const result = database.prepare(`INSERT INTO "${table}"(osm_id, code, fclass, name, geom) VALUES (?, 0, ?, ?, X'00')`).run(osmId, fclass, name);
  database.prepare(`INSERT INTO "rtree_${table}_geom"(id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)`).run(result.lastInsertRowid, longitude - 0.0001, longitude + 0.0001, latitude - 0.0001, latitude + 0.0001);
}

function rectangle(west, south, east, north) {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}
