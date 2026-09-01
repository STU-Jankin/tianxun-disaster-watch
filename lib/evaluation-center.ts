import type { DisasterEvent, HazardSubtype, HazardType } from "./disasters.ts";

export const evaluationModelVersion = "tianxun-evaluation-v2";
export const evaluationCoverageGapMinutes = 90;

export type EvaluationSeverity = DisasterEvent["severity"];
export type EvaluationObjective = "event_detection" | "landslide_forecast";

export type EvaluationBenchmarkCase = {
  caseId: string;
  title: string;
  hazard: HazardType;
  objective: EvaluationObjective;
  hazardSubtype?: HazardSubtype;
  occurredAt: string;
  latitude: number;
  longitude: number;
  locationToleranceKm: number;
  eventTimeToleranceHours: number;
  acceptedLeadMinutes: number;
  detectionDeadlineMinutes: number;
  expectedSeverity?: EvaluationSeverity;
  requiredSource?: string;
  minimumForecastRiskPercent?: number;
  provenanceUrl: string;
  notes: string;
  verificationStatus: "verified" | "draft";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationCandidate = {
  snapshotId: string;
  capturedAt: string;
  event: DisasterEvent;
};

export type EvaluationSourceReliability = {
  sourceId: string;
  name: string;
  attempts: number;
  successfulAttempts: number;
  successRatePercent: number;
  averageDurationMs: number;
};

export type EvaluationCaseResult = {
  caseId: string;
  title: string;
  hazard: HazardType;
  objective: EvaluationObjective;
  status: "detected" | "missed" | "pending" | "insufficient_history" | "draft";
  evaluationStartAt: string;
  expectedBy: string;
  detectedAt?: string;
  matchedMasterEventId?: string;
  matchedTitle?: string;
  latencyMinutes?: number;
  forecastLeadMinutes?: number;
  locationErrorKm?: number;
  spatialMatch?: "geometry_contains" | "point_tolerance";
  forecastRiskPercent?: number;
  detectedSeverity?: EvaluationSeverity;
  expectedSeverity?: EvaluationSeverity;
  severityMet?: boolean;
  requiredSource?: string;
  reason: string;
};

export type DetectionEvaluationReport = {
  runId: string;
  modelVersion: typeof evaluationModelVersion;
  computedAt: string;
  coverage: {
    firstSnapshotAt: string | null;
    lastSnapshotAt: string | null;
    snapshotCount: number;
    maximumGapMinutes: number | null;
    gapToleranceMinutes: number;
  };
  metrics: {
    verifiedCases: number;
    eligibleCases: number;
    detectedCases: number;
    missedCases: number;
    pendingCases: number;
    insufficientHistoryCases: number;
    recallPercent: number | null;
    deadlineHitRatePercent: number | null;
    detectionEligibleCases: number;
    detectionHits: number;
    forecastEligibleCases: number;
    forecastHits: number;
    forecastHitRatePercent: number | null;
    medianForecastLeadMinutes: number | null;
    medianLatencyMinutes: number | null;
    p95LatencyMinutes: number | null;
    medianLocationErrorKm: number | null;
    severityAgreementPercent: number | null;
    precisionAvailable: false;
  };
  results: EvaluationCaseResult[];
  sourceReliability: EvaluationSourceReliability[];
  limitations: string[];
};

export function evaluationWindow(benchmark: EvaluationBenchmarkCase) {
  const occurredAtMs = Date.parse(benchmark.occurredAt);
  if (benchmark.objective === "landslide_forecast") {
    return {
      startAt: new Date(occurredAtMs - benchmark.acceptedLeadMinutes * 60_000).toISOString(),
      expectedBy: new Date(occurredAtMs - benchmark.detectionDeadlineMinutes * 60_000).toISOString(),
      eventStartAt: new Date(occurredAtMs - benchmark.acceptedLeadMinutes * 60_000).toISOString(),
      eventEndAt: new Date(occurredAtMs).toISOString(),
    };
  }
  return {
    startAt: new Date(occurredAtMs - benchmark.acceptedLeadMinutes * 60_000).toISOString(),
    expectedBy: new Date(occurredAtMs + benchmark.detectionDeadlineMinutes * 60_000).toISOString(),
    eventStartAt: new Date(occurredAtMs - benchmark.eventTimeToleranceHours * 3_600_000).toISOString(),
    eventEndAt: new Date(occurredAtMs + benchmark.eventTimeToleranceHours * 3_600_000).toISOString(),
  };
}

export function evaluateDetectionBenchmarks(input: {
  runId: string;
  computedAt: string;
  cases: EvaluationBenchmarkCase[];
  candidatesByCase: Record<string, EvaluationCandidate[]>;
  snapshotTimes: string[];
  sourceSuccessTimesByCase?: Record<string, string[]>;
  sourceReliability?: EvaluationSourceReliability[];
}): DetectionEvaluationReport {
  const computedAtMs = Date.parse(input.computedAt);
  const snapshotTimes = [...new Set(input.snapshotTimes)]
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const firstSnapshotAt = snapshotTimes[0] ?? null;
  const lastSnapshotAt = snapshotTimes.at(-1) ?? null;
  const gaps = snapshotTimes.slice(1).map((value, index) => (Date.parse(value) - Date.parse(snapshotTimes[index])) / 60_000);
  const maximumGapMinutes = gaps.length ? Math.max(...gaps) : null;
  const results = input.cases.map((benchmark) => evaluateCase(
    benchmark,
    input.candidatesByCase[benchmark.caseId] ?? [],
    snapshotTimes,
    computedAtMs,
    input.sourceSuccessTimesByCase?.[benchmark.caseId] ?? [],
  ));
  const eligible = results.filter((result) => result.status === "detected" || result.status === "missed");
  const detected = eligible.filter((result) => result.status === "detected");
  const detectionEligible = eligible.filter((result) => result.objective === "event_detection");
  const detectionHits = detectionEligible.filter((result) => result.status === "detected");
  const forecastEligible = eligible.filter((result) => result.objective === "landslide_forecast");
  const forecastHits = forecastEligible.filter((result) => result.status === "detected");
  const deadlineHits = detectionHits.filter((result) => (result.latencyMinutes ?? Number.POSITIVE_INFINITY) <= caseById(input.cases, result.caseId).detectionDeadlineMinutes);
  const severityResults = detectionHits.filter((result) => result.expectedSeverity && result.severityMet !== undefined);
  const latencies = detectionHits.flatMap((result) => result.latencyMinutes === undefined ? [] : [result.latencyMinutes]);
  const forecastLeads = forecastHits.flatMap((result) => result.forecastLeadMinutes === undefined ? [] : [result.forecastLeadMinutes]);
  const locationErrors = detectionHits.flatMap((result) => result.locationErrorKm === undefined ? [] : [result.locationErrorKm]);

  return {
    runId: input.runId,
    modelVersion: evaluationModelVersion,
    computedAt: input.computedAt,
    coverage: {
      firstSnapshotAt,
      lastSnapshotAt,
      snapshotCount: snapshotTimes.length,
      maximumGapMinutes: roundNullable(maximumGapMinutes, 1),
      gapToleranceMinutes: evaluationCoverageGapMinutes,
    },
    metrics: {
      verifiedCases: input.cases.filter((item) => item.verificationStatus === "verified").length,
      eligibleCases: eligible.length,
      detectedCases: detected.length,
      missedCases: eligible.length - detected.length,
      pendingCases: results.filter((result) => result.status === "pending").length,
      insufficientHistoryCases: results.filter((result) => result.status === "insufficient_history").length,
      recallPercent: detectionEligible.length ? round(detectionHits.length / detectionEligible.length * 100, 1) : null,
      deadlineHitRatePercent: detectionEligible.length ? round(deadlineHits.length / detectionEligible.length * 100, 1) : null,
      detectionEligibleCases: detectionEligible.length,
      detectionHits: detectionHits.length,
      forecastEligibleCases: forecastEligible.length,
      forecastHits: forecastHits.length,
      forecastHitRatePercent: forecastEligible.length ? round(forecastHits.length / forecastEligible.length * 100, 1) : null,
      medianForecastLeadMinutes: percentile(forecastLeads, 0.5),
      medianLatencyMinutes: percentile(latencies, 0.5),
      p95LatencyMinutes: percentile(latencies, 0.95),
      medianLocationErrorKm: percentile(locationErrors, 0.5),
      severityAgreementPercent: severityResults.length
        ? round(severityResults.filter((result) => result.severityMet).length / severityResults.length * 100, 1)
        : null,
      precisionAvailable: false,
    },
    results,
    sourceReliability: [...(input.sourceReliability ?? [])].sort((left, right) => left.successRatePercent - right.successRatePercent || right.attempts - left.attempts),
    limitations: [
      "召回率只统计已核验基准事件；基准库未覆盖全部真实事件时，不能据此计算误报率或精确率。",
      "位置匹配使用基准样本配置的空间和时间容差；容差属于验收口径，不代表灾害实际影响范围。",
      "历史快照出现超过 90 分钟的缺口时，相应漏报样本标记为历史不足，不计入召回率分母。",
      "来源成功率表达抓取链路可用性，不等同于该来源对灾害事件的召回率或官方发布时效。",
      "滑坡/泥石流预测命中要求预测产品在真实事件发生前已被系统保存、有效期覆盖发生时刻，且预测面覆盖核验点或点目标落入配置容差。",
      "当前 LHASA 入库仅保留风险值不低于 80% 的区域，因此只能验收现行高风险筛查口径，不能反推 80% 以下阈值的表现。",
      "没有按同一时空规则建立的未发生对照样本时，不计算滑坡预测误报率、特异度、Brier 分数或最优阈值。",
    ],
  };
}

function evaluateCase(
  benchmark: EvaluationBenchmarkCase,
  candidates: EvaluationCandidate[],
  snapshotTimes: string[],
  computedAtMs: number,
  sourceSuccessTimes: string[],
): EvaluationCaseResult {
  const window = evaluationWindow(benchmark);
  const base = {
    caseId: benchmark.caseId,
    title: benchmark.title,
    hazard: benchmark.hazard,
    objective: benchmark.objective,
    evaluationStartAt: window.startAt,
    expectedBy: window.expectedBy,
    expectedSeverity: benchmark.expectedSeverity,
    requiredSource: benchmark.requiredSource,
  };
  if (benchmark.verificationStatus !== "verified") {
    return { ...base, status: "draft", reason: "样本尚未标记为已核验，不参与正式指标。" };
  }
  if (computedAtMs < Date.parse(benchmark.objective === "landslide_forecast" ? benchmark.occurredAt : window.expectedBy)) {
    return { ...base, status: "pending", reason: "检测时限尚未结束，暂不计入召回率。" };
  }
  const matching = candidates
    .filter((candidate) => candidateMatches(benchmark, candidate))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt)
      || candidateScore(benchmark, left.event) - candidateScore(benchmark, right.event));
  const match = matching[0];
  if (match) {
    const latencyMinutes = (Date.parse(match.capturedAt) - Date.parse(benchmark.occurredAt)) / 60_000;
    const locationErrorKm = haversineKm(benchmark.latitude, benchmark.longitude, match.event.latitude, match.event.longitude);
    const spatialMatch = geometryContainsPoint(match.event.geometry, benchmark.longitude, benchmark.latitude) ? "geometry_contains" as const : "point_tolerance" as const;
    const severityMet = benchmark.expectedSeverity
      ? severityRank(match.event.severity) >= severityRank(benchmark.expectedSeverity)
      : undefined;
    return {
      ...base,
      status: "detected",
      detectedAt: match.capturedAt,
      matchedMasterEventId: match.event.masterEventId,
      matchedTitle: match.event.title,
      latencyMinutes: benchmark.objective === "event_detection" ? round(latencyMinutes, 1) : undefined,
      forecastLeadMinutes: benchmark.objective === "landslide_forecast" ? round(-latencyMinutes, 1) : undefined,
      locationErrorKm: round(locationErrorKm, 1),
      spatialMatch,
      forecastRiskPercent: benchmark.objective === "landslide_forecast" ? forecastRiskPercent(match.event) ?? undefined : undefined,
      detectedSeverity: match.event.severity,
      severityMet,
      reason: benchmark.objective === "landslide_forecast"
        ? `预测产品在事件发生前 ${formatLead(-latencyMinutes)} 被系统保存，有效期覆盖发生时刻，且${spatialMatch === "geometry_contains" ? "预测面覆盖核验点" : "代表点落入空间容差"}。`
        : severityMet === false
        ? "在检测时限内发现事件，但首次匹配等级低于基准等级。"
        : "在配置的空间、时间和来源口径内找到最早匹配快照。",
    };
  }
  const coverage = caseCoverage(snapshotTimes, window.startAt, window.expectedBy);
  if (!coverage.complete) {
    return { ...base, status: "insufficient_history", reason: coverage.reason };
  }
  if (benchmark.requiredSource && !sourceSuccessTimes.some((value) => Date.parse(value) >= Date.parse(window.startAt) && Date.parse(value) <= Date.parse(window.expectedBy))) {
    return { ...base, status: "insufficient_history", reason: `评测窗口内没有“${benchmark.requiredSource}”的成功抓取记录，不能把来源不可用判成漏报。` };
  }
  if (benchmark.objective === "landslide_forecast") {
    const spatialCandidates = candidates.filter((candidate) => forecastCandidateSpatiallyMatches(benchmark, candidate));
    const highestRisk = Math.max(...spatialCandidates.map((candidate) => forecastRiskPercent(candidate.event) ?? Number.NEGATIVE_INFINITY));
    const thresholdReason = Number.isFinite(highestRisk) && benchmark.minimumForecastRiskPercent
      ? `最高匹配风险值为 ${highestRisk}%，未达到样本要求的 ${benchmark.minimumForecastRiskPercent}%。`
      : "未找到有效期覆盖事件时刻且空间命中的预测产品。";
    return { ...base, status: "missed", reason: `预测窗口和指定来源记录完整；${thresholdReason}` };
  }
  return { ...base, status: "missed", reason: "历史快照覆盖完整，但在检测时限内未找到符合空间、时间和来源口径的事件。" };
}

function candidateMatches(benchmark: EvaluationBenchmarkCase, candidate: EvaluationCandidate) {
  const event = candidate.event;
  if (benchmark.objective === "landslide_forecast") {
    if (!forecastCandidateSpatiallyMatches(benchmark, candidate)) return false;
    const risk = forecastRiskPercent(event);
    return benchmark.minimumForecastRiskPercent === undefined || (risk !== null && risk >= benchmark.minimumForecastRiskPercent);
  }
  if (event.hazard !== benchmark.hazard) return false;
  const timeErrorHours = Math.abs(Date.parse(event.occurredAt) - Date.parse(benchmark.occurredAt)) / 3_600_000;
  if (!Number.isFinite(timeErrorHours) || timeErrorHours > benchmark.eventTimeToleranceHours) return false;
  const distanceKm = haversineKm(benchmark.latitude, benchmark.longitude, event.latitude, event.longitude);
  if (distanceKm > benchmark.locationToleranceKm) return false;
  const requiredSource = benchmark.requiredSource?.trim().toLocaleLowerCase();
  if (!requiredSource) return true;
  return event.source.toLocaleLowerCase().includes(requiredSource)
    || event.evidence.some((item) => item.source.toLocaleLowerCase().includes(requiredSource));
}

function forecastCandidateSpatiallyMatches(benchmark: EvaluationBenchmarkCase, candidate: EvaluationCandidate) {
  const event = candidate.event;
  if (benchmark.hazard !== "landslide" || event.hazard !== "landslide" || !["forecast", "warning"].includes(event.phenomenonStage)) return false;
  const capturedAtMs = Date.parse(candidate.capturedAt);
  const occurredAtMs = Date.parse(benchmark.occurredAt);
  const leadMinutes = (occurredAtMs - capturedAtMs) / 60_000;
  if (!Number.isFinite(leadMinutes) || leadMinutes < benchmark.detectionDeadlineMinutes || leadMinutes > benchmark.acceptedLeadMinutes) return false;
  if (!event.validTo || Date.parse(event.validTo) < occurredAtMs) return false;
  if (event.validFrom && Date.parse(event.validFrom) > occurredAtMs) return false;
  if (!sourceMatches(benchmark, event)) return false;
  if (geometryContainsPoint(event.geometry, benchmark.longitude, benchmark.latitude)) return true;
  return haversineKm(benchmark.latitude, benchmark.longitude, event.latitude, event.longitude) <= benchmark.locationToleranceKm;
}

function sourceMatches(benchmark: EvaluationBenchmarkCase, event: DisasterEvent) {
  const requiredSource = benchmark.requiredSource?.trim().toLocaleLowerCase();
  if (!requiredSource) return true;
  return event.source.toLocaleLowerCase().includes(requiredSource)
    || event.evidence.some((item) => item.source.toLocaleLowerCase().includes(requiredSource));
}

function candidateScore(benchmark: EvaluationBenchmarkCase, event: DisasterEvent) {
  const distance = haversineKm(benchmark.latitude, benchmark.longitude, event.latitude, event.longitude) / Math.max(benchmark.locationToleranceKm, 1);
  const time = Math.abs(Date.parse(event.occurredAt) - Date.parse(benchmark.occurredAt)) / 3_600_000 / Math.max(benchmark.eventTimeToleranceHours, 1);
  return distance + time;
}

function forecastRiskPercent(event: DisasterEvent) {
  if (event.magnitudeUnit === "%" && Number.isFinite(event.magnitude)) return Math.max(0, Math.min(100, event.magnitude!));
  const match = event.sourceSeverity.match(/(?:LHASA\s*)?(\d{1,3}(?:\.\d+)?)%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function geometryContainsPoint(geometry: DisasterEvent["geometry"] | undefined, longitude: number, latitude: number) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return polygonContainsPoint(geometry.coordinates as number[][][], longitude, latitude);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).some((polygon) => polygonContainsPoint(polygon, longitude, latitude));
  return false;
}

function polygonContainsPoint(polygon: number[][][], longitude: number, latitude: number) {
  if (!Array.isArray(polygon) || !polygon.length || !ringContainsPoint(polygon[0], longitude, latitude)) return false;
  return !polygon.slice(1).some((ring) => ringContainsPoint(ring, longitude, latitude));
}

function ringContainsPoint(ring: number[][], longitude: number, latitude: number) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const normalized = ring.map((coordinate) => {
    const raw = Number(coordinate?.[0]);
    const delta = ((raw - longitude + 540) % 360) - 180;
    return [longitude + delta, Number(coordinate?.[1])] as const;
  });
  let inside = false;
  for (let index = 0, previous = normalized.length - 1; index < normalized.length; previous = index, index += 1) {
    const current = normalized[index];
    const prior = normalized[previous];
    if (!current.every(Number.isFinite) || !prior.every(Number.isFinite)) return false;
    if (((current[1] > latitude) !== (prior[1] > latitude))
      && longitude < (prior[0] - current[0]) * (latitude - current[1]) / (prior[1] - current[1]) + current[0]) inside = !inside;
  }
  return inside;
}

function formatLead(value: number) {
  const rounded = Math.max(0, Math.round(value));
  return rounded >= 60 ? `${Math.round(rounded / 6) / 10} 小时` : `${rounded} 分钟`;
}

function caseCoverage(snapshotTimes: string[], startAt: string, expectedBy: string) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(expectedBy);
  const toleranceMs = evaluationCoverageGapMinutes * 60_000;
  const relevant = snapshotTimes
    .map(Date.parse)
    .filter((value) => value >= startMs - toleranceMs && value <= endMs + toleranceMs)
    .sort((left, right) => left - right);
  if (!relevant.length) return { complete: false, reason: "检测窗口内没有历史快照，不能把缺少记录判定为漏报。" };
  if (relevant[0] > startMs + toleranceMs) return { complete: false, reason: "检测窗口开始阶段缺少历史快照，不能判定是否漏报。" };
  if (relevant.at(-1)! < endMs - toleranceMs) return { complete: false, reason: "检测窗口结束阶段缺少历史快照，不能判定是否漏报。" };
  for (let index = 1; index < relevant.length; index += 1) {
    if (relevant[index] - relevant[index - 1] > toleranceMs) return { complete: false, reason: "检测窗口存在超过 90 分钟的快照缺口，暂不计入漏报。" };
  }
  return { complete: true, reason: "历史覆盖完整。" };
}

export function haversineKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians((((longitudeB - longitudeA) + 540) % 360) - 180);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function caseById(cases: EvaluationBenchmarkCase[], caseId: string) {
  const benchmark = cases.find((item) => item.caseId === caseId);
  if (!benchmark) throw new Error(`evaluation case missing: ${caseId}`);
  return benchmark;
}

function severityRank(value: EvaluationSeverity) {
  return { blue: 1, yellow: 2, orange: 3, red: 4 }[value];
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index], 1);
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundNullable(value: number | null, digits: number) {
  return value === null ? null : round(value, digits);
}
