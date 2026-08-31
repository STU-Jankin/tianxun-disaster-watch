import type { DisasterEvent, HazardType, PhenomenonStage } from "./disasters.ts";

export type ImpactRiskLevel = "undetermined" | "low" | "moderate" | "high" | "very_high";

export type ImpactRiskAssessment = {
  status: "screening" | "assessed";
  level: ImpactRiskLevel;
  score: number | null;
  scoreRange: { min: number; max: number } | null;
  hazardIndex: number;
  exposureIndex: number | null;
  vulnerabilityIndex: number | null;
  confidence: "low" | "medium" | "high";
  basis: string[];
  missingInputs: string[];
  limitations: string;
  modelVersion: "tianxun-impact-screening-v2";
  hazardModel: {
    hazard: HazardType | "generic";
    modelId: string;
    intensityProxy: string;
    intensityValue: number | null;
    intensityUnit: string;
    intensityStatus: "observed" | "forecast" | "official_level_proxy";
    quantitative: boolean;
  };
  uncertainty: { hazardIndexMin: number; hazardIndexMax: number; basis: string };
};

type AssessmentInput = Pick<DisasterEvent, "severity" | "confidenceScore" | "geometryType" | "locationQuality"> & Partial<Pick<DisasterEvent, "hazard" | "hazardSubtype" | "magnitude" | "magnitudeUnit" | "cycloneForecast">> & {
  phenomenonStage?: PhenomenonStage;
  exposure?: { index: number; basis: string };
  vulnerability?: { index: number; basis: string };
};

const hazardIndexBySeverity: Record<DisasterEvent["severity"], number> = { blue: 25, yellow: 50, orange: 75, red: 95 };

const modelDefinitions: Record<HazardType, { id: string; intensity: string; unit: string; requiredInput: string }> = {
  earthquake: { id: "earthquake-magnitude-screening-v1", intensity: "地震矩震级", unit: "Mw", requiredInput: "地震矩震级及目标区烈度/地震动场" },
  tsunami: { id: "tsunami-inundation-screening-v1", intensity: "近岸波高或淹没深度", unit: "m", requiredInput: "近岸波高、淹没深度和到达时间" },
  wildfire: { id: "wildfire-intensity-screening-v1", intensity: "火辐射功率或火线强度", unit: "MW", requiredInput: "火辐射功率、火线强度或燃烧面积" },
  flood: { id: "flood-depth-screening-v1", intensity: "淹没深度/流速", unit: "m", requiredInput: "淹没深度、流速和持续时间" },
  cyclone: { id: "cyclone-wind-screening-v1", intensity: "最大持续风速", unit: "kt", requiredInput: "目标时刻最大持续风速、风圈和降雨场" },
  volcano: { id: "volcano-vei-screening-v1", intensity: "火山爆发指数", unit: "VEI", requiredInput: "VEI、火山灰高度或熔岩流强度" },
  landslide: { id: "landslide-extent-screening-v1", intensity: "滑坡/泥石流规模", unit: "km²", requiredInput: "滑坡面积、体积、运动速度及堵江情况" },
  drought: { id: "drought-index-screening-v1", intensity: "干旱指数", unit: "SPI/SPEI", requiredInput: "SPI/SPEI、土壤湿度异常和持续时间" },
  dust: { id: "dust-aod-screening-v1", intensity: "气溶胶光学厚度", unit: "AOD", requiredInput: "AOD、能见度和近地面颗粒物浓度" },
  ice: { id: "snow-ice-screening-v1", intensity: "雪冰厚度/位移", unit: "m", requiredInput: "积雪/冰层厚度、位移速度或雪崩规模" },
};

export function assessImpactRisk(input: AssessmentInput): ImpactRiskAssessment {
  const officialIndex = hazardIndexBySeverity[input.severity];
  const intensity = hazardIntensity(input);
  const hazardIndex = intensity.index ?? officialIndex;
  const exposureIndex = boundedIndex(input.exposure?.index);
  const vulnerabilityIndex = boundedIndex(input.vulnerability?.index);
  const confidence: ImpactRiskAssessment["confidence"] = input.confidenceScore >= 85 ? "high" : input.confidenceScore >= 70 ? "medium" : "low";
  const uncertaintyWidth = intensity.quantitative ? confidence === "high" ? 6 : confidence === "medium" ? 10 : 16 : confidence === "high" ? 12 : confidence === "medium" ? 18 : 25;
  const hazardIndexMin = clampIndex(hazardIndex - uncertaintyWidth);
  const hazardIndexMax = clampIndex(hazardIndex + uncertaintyWidth);
  const definition = input.hazard ? modelDefinitions[input.hazard] : null;
  const basis = [
    intensity.quantitative
      ? `${definition?.intensity ?? "灾害强度"}：${intensity.value} ${intensity.unit}；按分灾种初筛曲线归一化`
      : `缺少分灾种定量强度，暂采用来源官方等级 ${input.severity} 作为危险性代理`,
    `事件几何：${input.geometryType}；定位质量：${input.locationQuality}`,
  ];
  if (input.exposure) basis.push(`暴露度：${input.exposure.basis}`);
  if (input.vulnerability) basis.push(`脆弱性：${input.vulnerability.basis}`);

  const missingInputs = [
    ...(!intensity.quantitative && definition ? [definition.requiredInput] : []),
    ...(exposureIndex === null ? ["人口、建筑和关键基础设施暴露度"] : []),
    ...(vulnerabilityIndex === null ? ["承灾体脆弱性模型"] : []),
  ];
  const common = {
    hazardIndex,
    exposureIndex,
    vulnerabilityIndex,
    confidence,
    basis,
    missingInputs,
    modelVersion: "tianxun-impact-screening-v2" as const,
    hazardModel: {
      hazard: (input.hazard ?? "generic") as HazardType | "generic",
      modelId: definition?.id ?? "generic-official-level-screening-v1",
      intensityProxy: definition?.intensity ?? "来源官方等级",
      intensityValue: intensity.value,
      intensityUnit: intensity.unit,
      intensityStatus: intensity.status,
      quantitative: intensity.quantitative,
    },
    uncertainty: {
      hazardIndexMin,
      hazardIndexMax,
      basis: intensity.quantitative ? "依据数据置信度和初筛曲线给出危险性区间" : "缺少定量强度输入，官方等级代理的不确定区间已扩大",
    },
  };
  if (exposureIndex === null || vulnerabilityIndex === null) {
    return {
      status: "screening", level: "undetermined", score: null, scoreRange: null, ...common,
      limitations: "当前仅表达灾害危险性信号，不代表人员伤亡、经济损失或综合风险；缺少暴露度和脆弱性时禁止生成伪精确风险分数。",
    };
  }

  const confidenceFactor = input.confidenceScore >= 85 ? 1 : input.confidenceScore >= 70 ? 0.9 : 0.75;
  const compute = (hazard: number) => Math.round(100
    * (hazard / 100) ** 0.45
    * (exposureIndex / 100) ** 0.35
    * (vulnerabilityIndex / 100) ** 0.2
    * confidenceFactor);
  const score = compute(hazardIndex);
  return {
    status: "assessed",
    level: score >= 80 ? "very_high" : score >= 60 ? "high" : score >= 35 ? "moderate" : "low",
    score,
    scoreRange: { min: compute(hazardIndexMin), max: compute(hazardIndexMax) },
    ...common,
    limitations: intensity.quantitative
      ? "该结果使用分灾种强度初筛曲线，仅用于演示任务排序；未经本地标定，不能替代正式损失评估。"
      : "该结果仍使用官方等级代理危险性，仅是用于演示排序的初筛指标；补齐分灾种强度后必须重新计算。",
  };
}

function hazardIntensity(input: AssessmentInput): { index: number | null; value: number | null; unit: string; status: "observed" | "forecast" | "official_level_proxy"; quantitative: boolean } {
  if (input.hazard === "earthquake" && Number.isFinite(input.magnitude)) {
    const value = Number(input.magnitude);
    return { index: clampIndex(20 + (value - 4) * 19), value, unit: input.magnitudeUnit || "Mw", status: input.phenomenonStage === "forecast" ? "forecast" : "observed", quantitative: true };
  }
  if (input.hazard === "cyclone") {
    const winds = input.cycloneForecast?.track.map((point) => point.windSpeedKnots).filter((value): value is number => Number.isFinite(value)) ?? [];
    if (winds.length) {
      const value = Math.max(...winds);
      return { index: clampIndex(20 + (value - 25) * 0.72), value, unit: "kt", status: "forecast", quantitative: true };
    }
  }
  return { index: null, value: null, unit: input.hazard ? modelDefinitions[input.hazard].unit : "等级", status: "official_level_proxy", quantitative: false };
}

function boundedIndex(value: number | undefined) { return Number.isFinite(value) ? clampIndex(Number(value)) : null; }
function clampIndex(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }
