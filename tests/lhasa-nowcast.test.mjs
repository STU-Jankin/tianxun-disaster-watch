import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

async function lhasa() {
  return import(new URL("../lib/lhasa-nowcast.ts", import.meta.url));
}

test("decodes the official 8-bit grayscale layout and creates review-only high-risk clusters", async () => {
  const { decodeLhasaRiskPng, lhasaCandidatesFromRaster, lhasaRiskClusters } = await lhasa();
  const width = 360;
  const height = 180;
  const pixels = new Uint8Array(width * height);
  for (let y = 80; y < 85; y += 1) for (let x = 200; x < 205; x += 1) pixels[y * width + x] = 245;
  pixels[20 * width + 20] = 201;
  const raster = await decodeLhasaRiskPng(grayPng(width, height, pixels), 5);
  assert.equal(raster.width, 72);
  assert.equal(raster.height, 36);
  const clusters = lhasaRiskClusters(raster);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].maximumRiskPercent, 96);
  assert.equal(clusters[0].geometry.type, "Polygon");
  const productTime = "2026-08-26T00:00:00.000Z";
  const candidates = lhasaCandidatesFromRaster(raster, productTime, "https://example.test/lhasa.png", Date.parse("2026-08-26T06:00:00Z"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].phenomenonStage, "forecast");
  assert.equal(candidates[0].requiresReview, true);
  assert.equal(candidates[0].validTo, "2026-08-27T00:00:00.000Z");
  assert.match(candidates[0].description, /不是已发生滑坡或泥石流的边界/);
  assert.equal(lhasaCandidatesFromRaster(raster, productTime, "https://example.test/lhasa.png", Date.parse("2026-08-27T06:01:00Z")).length, 0, "stale nowcasts must not re-enter the alert list");
});

function grayPng(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + row * width, width).copy(raw, row * (width + 1) + 1);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
