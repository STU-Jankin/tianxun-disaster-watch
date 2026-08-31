import type { DisasterEvent, PhenomenonStage } from "./disasters.ts";

export type ImpactRiskLevel = "undetermined" | "low" | "moderate" | "high" | "very_high";

export type ImpactRiskAssessment = {
  status: "screening" | "assessed";
  level: ImpactRiskLevel;
  score: number | null;
  hazardIndex: number;
  exposureIndex: number | null;
  vulnerabilityIndex: number | null;
  confidence: "low" | "medium" | "high";
  basis: string[];
  missingInputs: string[];
  limitations: string;
  modelVersion: "tianxun-impact-screening-v1";
};

type AssessmentInput = Pick<DisasterEvent, "severity" | "confidenceScore" | "geometryType" | "locationQuality"> & {
  phenomenonStage?: PhenomenonStage;
  exposure?: { index: number; basis: string };
  vulnerability?: { index: number; basis: string };
};

const hazardIndexBySeverity: Record<DisasterEvent["severity"], number> = {
  blue: 25,
  yellow: 50,
  orange: 75,
  red: 95,
};

export function assessImpactRisk(input: AssessmentInput): ImpactRiskAssessment {
  const hazardIndex = hazardIndexBySeverity[input.severity];
  const exposureIndex = boundedIndex(input.exposure?.index);
  const vulnerabilityIndex = boundedIndex(input.vulnerability?.index);
  const confidence = input.confidenceScore >= 85 ? "high" : input.confidenceScore >= 70 ? "medium" : "low";
  const basis = [
    `危险性初筛采用归一化官方等级：${input.severity}`,
    `事件几何：${input.geometryType}；定位质量：${input.locationQuality}`,
  ];
  if (input.exposure) basis.push(`暴露度：${input.exposure.basis}`);
  if (input.vulnerability) basis.push(`脆弱性：${input.vulnerability.basis}`);

  const missingInputs = [
    ...(exposureIndex === null ? ["人口、建筑和关键基础设施暴露度"] : []),
    ...(vulnerabilityIndex === null ? ["承灾体脆弱性模型"] : []),
  ];
  if (exposureIndex === null || vulnerabilityIndex === null) {
    return {
      status: "screening",
      level: "undetermined",
      score: null,
      hazardIndex,
      exposureIndex,
      vulnerabilityIndex,
      confidence,
      basis,
      missingInputs,
      limitations: "当前仅表达灾害危险性信号，不代表人员伤亡、经济损失或综合风险；缺少暴露度和脆弱性时禁止生成伪精确风险分数。",
      modelVersion: "tianxun-impact-screening-v1",
    };
  }

  // A transparent screening model, not a hazard-specific loss model. The
  // geometric mean prevents one strong component from fully masking a weak
  // component, while source confidence only reduces (never inflates) risk.
  const confidenceFactor = input.confidenceScore >= 85 ? 1 : input.confidenceScore >= 70 ? 0.9 : 0.75;
  const score = Math.round(100
    * (hazardIndex / 100) ** 0.45
    * (exposureIndex / 100) ** 0.35
    * (vulnerabilityIndex / 100) ** 0.2
    * confidenceFactor);
  return {
    status: "assessed",
    level: score >= 80 ? "very_high" : score >= 60 ? "high" : score >= 35 ? "moderate" : "low",
    score,
    hazardIndex,
    exposureIndex,
    vulnerabilityIndex,
    confidence,
    basis,
    missingInputs,
    limitations: "该结果是用于排序和人工研判的初筛指标；正式损失评估仍须采用分灾种强度、暴露和脆弱性模型。",
    modelVersion: "tianxun-impact-screening-v1",
  };
}

function boundedIndex(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : null;
}
