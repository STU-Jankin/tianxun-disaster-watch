import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists benchmark cases and reads spatial-temporal replay candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-evaluation-db-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const database = await import(new URL(`../db/operational.ts?evaluation=${Date.now()}`, import.meta.url));
    const benchmark = {
      caseId: "benchmark-db-case-001",
      title: "数据库评测样本",
      hazard: "landslide",
      objective: "event_detection",
      occurredAt: "2026-09-01T00:00:00.000Z",
      latitude: 29.5,
      longitude: 90.5,
      locationToleranceKm: 50,
      eventTimeToleranceHours: 12,
      acceptedLeadMinutes: 0,
      detectionDeadlineMinutes: 180,
      expectedSeverity: "orange",
      requiredSource: "测试源",
      provenanceUrl: "https://example.test/landslide/1",
      notes: "已人工核验",
      verificationStatus: "verified",
      createdBy: "tester",
      createdAt: "2026-09-01T04:00:00.000Z",
      updatedAt: "2026-09-01T04:00:00.000Z",
    };
    await database.upsertEvaluationCase(benchmark);
    assert.equal((await database.listEvaluationCases())[0].caseId, benchmark.caseId);
    await database.upsertForecastRasterProduct({
      productId: "lhasa-20260901-0000",
      sourceId: "nasa-lhasa",
      productTime: "2026-09-01T00:00:00.000Z",
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-09-02T00:00:00.000Z",
      sourceUrl: "https://example.test/lhasa.png",
      payloadSha256: "a".repeat(64),
      storageKey: "lhasa/2026/09/test.png",
      storageBackend: "filesystem",
      contentType: "image/png",
      byteLength: 100,
      sourceWidth: 360,
      sourceHeight: 180,
      groupPixels: 5,
      gridWidth: 72,
      gridHeight: 36,
      summary: { cellCount: 2592, minimumRiskPercent: 0, maximumRiskPercent: 90, meanRiskPercent: 1, histogram: [2591, ...Array(89).fill(0), 1, ...Array(10).fill(0)], thresholdCellCounts: { "50": 1 } },
      archivedAt: "2026-09-01T00:05:00.000Z",
    });
    assert.equal((await database.forecastRasterArchiveStatus()).productCount, 1);
    assert.equal((await database.listForecastRasterProducts("2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z"))[0].productId, "lhasa-20260901-0000");
    await database.persistIngestionArtifacts({
      refreshId: "refresh-evaluation-1",
      sources: [],
      fetches: [],
      snapshot: {
        snapshotId: "snapshot-evaluation-1",
        refreshId: "refresh-evaluation-1",
        capturedAt: "2026-09-01T01:00:00.000Z",
        payloadSha256: "e".repeat(64),
        eventCount: 1,
        sourceCount: 0,
        payload: { events: [{ id: "event-1", masterEventId: "ME-landslide-1", title: "测试滑坡", hazard: "landslide", occurredAt: "2026-09-01T00:10:00.000Z", latitude: 29.51, longitude: 90.49, severity: "orange", source: "测试源", evidence: [{ source: "测试源" }] }] },
      },
    });
    const candidates = await database.listEvaluationCandidates(benchmark);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].event.masterEventId, "ME-landslide-1");
    const forecastBenchmark = {
      ...benchmark,
      caseId: "benchmark-db-forecast-001",
      title: "数据库滑坡预测样本",
      objective: "landslide_forecast",
      hazardSubtype: "debris_flow",
      occurredAt: "2026-09-02T00:00:00.000Z",
      acceptedLeadMinutes: 1_440,
      detectionDeadlineMinutes: 60,
      minimumForecastRiskPercent: 80,
      requiredSource: "NASA LHASA",
    };
    await database.upsertEvaluationCase(forecastBenchmark);
    await database.upsertLhasaV1GranuleProbe({
      caseId: forecastBenchmark.caseId,
      productDate: "2020-12-31",
      status: "available",
      collectionConceptId: "C2036912694-GES_DISC",
      granuleConceptId: "G2041291075-GES_DISC",
      producerGranuleId: "Global_Landslide_Nowcast_v1.1_20201231.tif",
      downloadUrl: "https://data.gesdisc.earthdata.nasa.gov/data/Landslide/Global_Landslide_Nowcast.1.1/2020/Global_Landslide_Nowcast_v1.1_20201231.tif",
      granuleSizeMb: 6.8,
      timeStart: "2020-12-31T00:00:00.000Z",
      timeEnd: "2020-12-31T23:59:59.000Z",
      message: "CMR已确认；尚未下载。",
      checkedAt: "2026-09-01T12:00:00.000Z",
    });
    assert.equal((await database.listLhasaV1GranuleProbes())[0].producerGranuleId, "Global_Landslide_Nowcast_v1.1_20201231.tif");
    await database.updateLhasaV1GranuleRead(forecastBenchmark.caseId, {
      readStatus: "ready",
      storageKey: "lhasa-v1/2020/12/sample.tif",
      storageBackend: "filesystem",
      payloadSha256: "a".repeat(64),
      byteLength: 7_000_000,
      readResult: {
        pointValue: 1, neighborhoodMaximum: 2, neighborhoodRadiusCells: [3, 3], validCellCount: 49, moderateCellCount: 2, highCellCount: 1,
        window: [10, 10, 17, 17], rasterWidth: 43_200, rasterHeight: 14_400, boundingBox: [-180, -60, 180, 60], resolutionDegrees: [1 / 120, 1 / 120], noDataValue: 255, interpretation: "same_day_nowcast",
      },
      readMessage: "同日nowcast读取完成。",
      readAt: "2026-09-01T13:00:00.000Z",
    });
    const historicalRead = (await database.listLhasaV1GranuleProbes())[0];
    assert.equal(historicalRead.readStatus, "ready");
    assert.equal(historicalRead.readResult.neighborhoodMaximum, 2);
    assert.equal(historicalRead.payloadSha256, "a".repeat(64));
    await database.persistIngestionArtifacts({
      refreshId: "refresh-evaluation-forecast",
      sources: [],
      fetches: [],
      snapshot: {
        snapshotId: "snapshot-evaluation-forecast",
        refreshId: "refresh-evaluation-forecast",
        capturedAt: "2026-09-01T02:00:00.000Z",
        payloadSha256: "f".repeat(64),
        eventCount: 1,
        sourceCount: 0,
        payload: { events: [{ id: "lhasa-1", masterEventId: "ME-lhasa-1", title: "LHASA 92%", hazard: "landslide", occurredAt: "2026-09-01T00:00:00.000Z", latitude: 29.5, longitude: 90.5, severity: "orange", source: "NASA LHASA", phenomenonStage: "forecast", validFrom: "2026-09-01T00:00:00.000Z", validTo: "2026-09-02T01:00:00.000Z", magnitude: 92, magnitudeUnit: "%", geometry: { type: "Polygon", coordinates: [[[90, 29], [91, 29], [91, 30], [90, 30], [90, 29]]] }, evidence: [{ source: "NASA LHASA" }] }] },
      },
    });
    const forecastCandidates = await database.listEvaluationCandidates(forecastBenchmark);
    assert.equal(forecastCandidates.length, 1);
    assert.equal(forecastCandidates[0].event.masterEventId, "ME-lhasa-1");
    assert.deepEqual(await database.evaluationSnapshotTimes("2026-09-01T00:00:00.000Z", "2026-09-01T02:00:00.000Z"), ["2026-09-01T01:00:00.000Z", "2026-09-01T02:00:00.000Z"]);
    assert.equal(await database.deleteEvaluationCase(benchmark.caseId), true);
    assert.equal(await database.deleteEvaluationCase(forecastBenchmark.caseId), true);
    assert.equal((await database.listEvaluationCases()).length, 0);
    assert.equal((await database.listLhasaV1GranuleProbes()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => { if (error?.code !== "EBUSY") throw error; });
  }
});
