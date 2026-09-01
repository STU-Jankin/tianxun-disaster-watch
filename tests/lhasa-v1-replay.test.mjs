import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadLhasaV1GeoTiff,
  lhasaV1MaximumGeoTiffBytes,
  readLhasaV1CaseWindowsFromImage,
} from "../lib/lhasa-v1-replay.ts";

function tiffBytes(size = 4_096) {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x49, 0x2a, 0]);
  return bytes;
}

function officialImage(readRasters) {
  return {
    getWidth: () => 43_200,
    getHeight: () => 14_400,
    getSamplesPerPixel: () => 1,
    getBitsPerSample: () => 8,
    getSampleFormat: () => 1,
    getBlockWidth: () => 43_200,
    getBlockHeight: () => 1,
    getBoundingBox: () => [-180, -60, 180, 60],
    getOrigin: () => [-180, 60, 0],
    getResolution: () => [1 / 120, -1 / 120],
    getGeoKeys: () => ({ GeographicTypeGeoKey: 4326 }),
    getGDALNoData: () => 255,
    readRasters,
  };
}

test("downloads a bounded authenticated GeoTIFF without following credential redirects", async () => {
  let captured;
  const downloaded = await downloadLhasaV1GeoTiff(
    "https://data.gesdisc.earthdata.nasa.gov/data/Landslide/Global_Landslide_Nowcast.1.1/2016/sample.tif",
    "valid-test-token-1234567890",
    async (url, init) => {
      captured = { url, init };
      return new Response(tiffBytes(), { headers: { "content-type": "image/tiff", "content-length": "4096" } });
    },
  );
  assert.equal(downloaded.byteLength, 4_096);
  assert.match(downloaded.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.Authorization, "Bearer valid-test-token-1234567890");
  await assert.rejects(() => downloadLhasaV1GeoTiff(captured.url, "valid-test-token-1234567890", async () => new Response(null, { status: 302, headers: { location: "https://urs.earthdata.nasa.gov/" } })), /not forwarded/);
});

test("rejects untrusted, malformed and oversized historical downloads", async () => {
  await assert.rejects(() => downloadLhasaV1GeoTiff("https://evil.example/history.tif", "valid-test-token-1234567890"), /not trusted/);
  await assert.rejects(() => downloadLhasaV1GeoTiff("https://data.gesdisc.earthdata.nasa.gov/history.tif", "short"), /missing or malformed/);
  await assert.rejects(() => downloadLhasaV1GeoTiff("https://data.gesdisc.earthdata.nasa.gov/history.tif", "valid-test-token-1234567890", async () => new Response(null, { headers: { "content-length": String(lhasaV1MaximumGeoTiffBytes + 1) } })), /safety bounds/);
});

test("reads the exact point and a bounded location-tolerance neighborhood", async () => {
  const image = officialImage(async ({ window }) => {
    const width = window[2] - window[0];
    const height = window[3] - window[1];
    const values = new Uint8Array(width * height);
    values[Math.floor(values.length / 2)] = 1;
    values[values.length - 1] = 2;
    return values;
  });
  const reads = await readLhasaV1CaseWindowsFromImage(image, [
    { caseId: "inside", latitude: 0, longitude: 0, locationToleranceKm: 2 },
    { caseId: "outside", latitude: 70, longitude: 0, locationToleranceKm: 2 },
  ]);
  const result = reads.get("inside");
  assert.equal(result.pointValue, 1);
  assert.equal(result.neighborhoodMaximum, 2);
  assert.deepEqual(result.neighborhoodRadiusCells, [3, 3]);
  assert.equal(result.moderateCellCount, 1);
  assert.equal(result.highCellCount, 1);
  assert.equal(reads.has("outside"), false);
});

test("treats 255 as no-data and rejects undocumented classes or unsafe geometry", async () => {
  const noData = officialImage(async ({ window }) => new Uint8Array((window[2] - window[0]) * (window[3] - window[1])).fill(255));
  const result = (await readLhasaV1CaseWindowsFromImage(noData, [{ caseId: "void", latitude: 0, longitude: 0, locationToleranceKm: 1 }])).get("void");
  assert.equal(result.validCellCount, 0);
  assert.equal(result.pointValue, null);
  const invalidClass = officialImage(async ({ window }) => new Uint8Array((window[2] - window[0]) * (window[3] - window[1])).fill(3));
  await assert.rejects(() => readLhasaV1CaseWindowsFromImage(invalidClass, [{ caseId: "bad", latitude: 0, longitude: 0, locationToleranceKm: 1 }]), /unsupported class/);
  const unsafeBlock = { ...officialImage(async () => new Uint8Array()), getBlockHeight: () => 100 };
  await assert.rejects(() => readLhasaV1CaseWindowsFromImage(unsafeBlock, [{ caseId: "bad", latitude: 0, longitude: 0, locationToleranceKm: 1 }]), /too large/);
});
