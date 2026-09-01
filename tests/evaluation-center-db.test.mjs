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
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => { if (error?.code !== "EBUSY") throw error; });
  }
});
