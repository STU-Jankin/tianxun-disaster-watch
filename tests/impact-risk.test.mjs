import assert from "node:assert/strict";
import test from "node:test";
import { assessImpactRisk } from "../lib/impact-risk.ts";
import { sanitizeSnapshotUrl, sourceGovernance } from "../lib/source-governance.ts";

test("does not fabricate an impact-risk score when exposure or vulnerability is absent", () => {
  const result = assessImpactRisk({ severity: "red", confidenceScore: 91, geometryType: "Polygon", locationQuality: "precise" });
  assert.equal(result.status, "screening");
  assert.equal(result.level, "undetermined");
  assert.equal(result.score, null);
  assert.equal(result.hazardIndex, 95);
  assert.deepEqual(result.missingInputs, ["人口、建筑和关键基础设施暴露度", "承灾体脆弱性模型"]);
  assert.match(result.limitations, /不代表人员伤亡、经济损失或综合风险/);
});

test("keeps a transparent assessed-risk result separate from source severity", () => {
  const result = assessImpactRisk({
    severity: "orange",
    confidenceScore: 88,
    geometryType: "Polygon",
    locationQuality: "estimated",
    exposure: { index: 82, basis: "人口和关键设施暴露栅格" },
    vulnerability: { index: 60, basis: "分灾种脆弱性曲线" },
  });
  assert.equal(result.status, "assessed");
  assert.ok(Number.isFinite(result.score));
  assert.equal(result.hazardIndex, 75);
  assert.match(result.limitations, /初筛指标/);
});

test("uses a hazard-specific quantitative proxy and exposes uncertainty", () => {
  const result = assessImpactRisk({
    hazard: "earthquake", magnitude: 7.1, magnitudeUnit: "Mw", severity: "orange", confidenceScore: 90,
    geometryType: "Point", locationQuality: "precise", exposure: { index: 70, basis: "人口栅格" }, vulnerability: { index: 55, basis: "建筑脆弱性曲线" },
  });
  assert.equal(result.modelVersion, "tianxun-impact-screening-v2");
  assert.equal(result.hazardModel.modelId, "earthquake-magnitude-screening-v1");
  assert.equal(result.hazardModel.quantitative, true);
  assert.ok(result.scoreRange.min <= result.score && result.score <= result.scoreRange.max);
  assert.ok(result.uncertainty.hazardIndexMin < result.uncertainty.hazardIndexMax);
});

test("source governance has explicit latency and strips secrets from archived URLs", () => {
  const governance = sourceGovernance("NASA FIRMS", "第一优先级", "事件");
  assert.equal(governance.pollIntervalMinutes, 10);
  assert.match(governance.geometrySemantics, /不是过火区/);
  const sanitized = sanitizeSnapshotUrl("https://firms.modaps.eosdis.nasa.gov/api/area/csv/secret-key/VIIRS?token=abc&area=world");
  assert.doesNotMatch(sanitized, /secret-key|token=abc/);
  assert.match(sanitized, /\[redacted\]/);
});
