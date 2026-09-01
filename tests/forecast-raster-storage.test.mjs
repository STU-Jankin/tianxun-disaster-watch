import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stores and reads complete forecast rasters from the VPS filesystem fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-forecast-archive-"));
  process.env.TIANXUN_FORECAST_ARCHIVE_DIR = directory;
  try {
    const storage = await import(new URL(`../lib/forecast-raster-storage.ts?storage=${Date.now()}`, import.meta.url));
    const source = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const backend = await storage.storeForecastRasterObject({
      storageKey: "lhasa/2026/09/sample.png",
      bytes: source.buffer,
      contentType: "image/png",
      metadata: { productTime: "2026-09-01T00:00:00.000Z" },
    });
    assert.equal(backend, "filesystem");
    assert.deepEqual(new Uint8Array(await storage.readForecastRasterObject("lhasa/2026/09/sample.png", backend)), source);
    await assert.rejects(() => storage.readForecastRasterObject("../outside.png", backend), /对象键无效/);
  } finally {
    delete process.env.TIANXUN_FORECAST_ARCHIVE_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
