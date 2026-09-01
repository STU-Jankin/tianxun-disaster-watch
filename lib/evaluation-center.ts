import type { DisasterEvent, HazardSubtype, HazardType } from "./disasters.ts";

export const evaluationModelVersion = "tianxun-evaluation-v3";
export const evaluationCoverageGapMinutes = 90;

export type EvaluationSeverity = DisasterEvent["severity"];
export type EvaluationObjective = "event_detection" | "landslide_forecast";
export type EvaluationOutcome = "event" | "no_event";

export type EvaluationBenchmarkCase = {
  caseId: string;
  title: string;
  hazard: HazardType;
  objective: EvaluationObjective;
  hazardSubtype?: HazardSubtype;
  outcome: EvaluationOutcome;
  calibrationGroup?: string;
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

export type ForecastRiskObservation = {
  productId: string;
  capturedAt: string;
  validFrom: string;
  validTo: string;
  riskPercent: number;
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
  outcome: EvaluationOutcome;
  calibrationGroup?: string;
  status: "detected" | "missed" | "correct_rejection" | "false_alarm" | "pending" | "insufficient_history" | "draft";
  evaluationStartAt: string;
  expectedBy: string;
  detectedAt?: string;
  matchedMasterEventId?: string;
  matchedTitle?: string;
  latencyMinutes?: number;
  forecastLeadMinutes?: number;
  locationErrorKm?: number;
  spatialMatch?: "geometry_contains" | "point_tolerance" | "raster_cell";
  forecastRiskPercent?: number;
  detectedSeverity?: EvaluationSeverity;
  expectedSeverity?: EvaluationSeverity;
  severityMet?: boolean;
  requiredSource?: string;
  reason: string;
};

export type ForecastThresholdScore = {
  thresholdPercent: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precisionPercent: number | null;
  recallPercent: number | null;
  falseAlarmRatePercent: number | null;
  f1Percent: number | null;
};

export type ForecastReliabilityBin = {
  minimumPercent: number;
  maximumPercent: number;
  sampleCount: number;
  meanForecastPercent: number | null;
  observedEventRatePercent: number | null;
};

export type DetectionEvaluationReport = {
  runId: string;
  modelVersion: typeof evaluationModelVersion;
  computedAt: string;
  replay: { historyDays: number | null; from: string | null; to: string };
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
    forecastNegativeEligibleCases: number;
    forecastFalseAlarms: number;
    forecastPrecisionPercent: number | null;
    forecastFalseAlarmRatePercent: number | null;
    forecastBrierScore: number | null;
    medianForecastLeadMinutes: number | null;
    medianLatencyMinutes: number | null;
    p95LatencyMinutes: number | null;
    medianLocationErrorKm: number | null;
    severityAgreementPercent: number | null;
    precisionAvailable: boolean;
  };
  forecastCalibration: {
    archiveProductCount: number;
    unreadableProductCount: number;
    positiveCases: number;
    negativeCases: number;
    recommendedThresholdPercent: number | null;
    recommendationStatus: "ready" | "insufficient_controls" | "no_archived_probabilities";
    recommendationReason: string;
    thresholdScores: ForecastThresholdScore[];
    reliabilityBins: ForecastReliabilityBin[];
    groups: Array<{
      calibrationGroup: string;
      positiveCases: number;
      negativeCases: number;
      recommendedThresholdPercent: number | null;
      status: "ready" | "insufficient_controls";
    }>;
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
  forecastObservationsByCase?: Record<string, ForecastRiskObservation[]>;
  forecastArchiveProductCount?: number;
  forecastArchiveUnreadableCount?: number;
  historyDays?: number | null;
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
    input.forecastObservationsByCase?.[benchmark.caseId],
  ));
  const eligible = results.filter((result) => ["detected", "missed", "correct_rejection", "false_alarm"].includes(result.status));
  const detected = eligible.filter((result) => result.status === "detected");
  const detectionEligible = eligible.filter((result) => result.objective === "event_detection" && result.outcome === "event");
  const detectionHits = detectionEligible.filter((result) => result.status === "detected");
  const forecastEligible = eligible.filter((result) => result.objective === "landslide_forecast" && result.outcome === "event");
  const forecastHits = forecastEligible.filter((result) => result.status === "detected");
  const forecastNegativeEligible = eligible.filter((result) => result.objective === "landslide_forecast" && result.outcome === "no_event");
  const forecastFalseAlarms = forecastNegativeEligible.filter((result) => result.status === "false_alarm");
  const forecastPrecisionDenominator = forecastHits.length + forecastFalseAlarms.length;
  const forecastCalibrationResults = [...forecastEligible, ...forecastNegativeEligible].filter((result) => result.forecastRiskPercent !== undefined);
  const forecastBrierScore = forecastCalibrationResults.length
    ? round(forecastCalibrationResults.reduce((total, result) => total + ((result.forecastRiskPercent ?? 0) / 100 - (result.outcome === "event" ? 1 : 0)) ** 2, 0) / forecastCalibrationResults.length, 4)
    : null;
  const thresholdScores = forecastThresholdScores(forecastCalibrationResults);
  const reliabilityBins = forecastReliabilityBins(forecastCalibrationResults);
  const controlsReady = forecastEligible.length >= 5 && forecastNegativeEligible.length >= 5;
  const recommended = controlsReady
    ? [...thresholdScores].filter((score) => score.f1Percent !== null).sort(compareThresholdScores)[0]
    : undefined;
  const archiveProductCount = Math.max(0, Math.round(input.forecastArchiveProductCount ?? 0));
  const unreadableProductCount = Math.max(0, Math.round(input.forecastArchiveUnreadableCount ?? 0));
  const recommendationStatus = archiveProductCount === 0 ? "no_archived_probabilities" as const : controlsReady ? "ready" as const : "insufficient_controls" as const;
  const calibrationGroups = [...new Set(forecastCalibrationResults.map((result) => result.calibrationGroup?.trim() || "未分组"))].sort().map((calibrationGroup) => {
    const members = forecastCalibrationResults.filter((result) => (result.calibrationGroup?.trim() || "未分组") === calibrationGroup);
    const positiveCases = members.filter((result) => result.outcome === "event").length;
    const negativeCases = members.filter((result) => result.outcome === "no_event").length;
    const scores = forecastThresholdScores(members);
    const ready = positiveCases >= 5 && negativeCases >= 5;
    const groupRecommended = ready
      ? [...scores].filter((score) => score.f1Percent !== null).sort(compareThresholdScores)[0]
      : undefined;
    return { calibrationGroup, positiveCases, negativeCases, recommendedThresholdPercent: groupRecommended?.thresholdPercent ?? null, status: ready ? "ready" as const : "insufficient_controls" as const };
  });
  const deadlineHits = detectionHits.filter((result) => (result.latencyMinutes ?? Number.POSITIVE_INFINITY) <= caseById(input.cases, result.caseId).detectionDeadlineMinutes);
  const severityResults = detectionHits.filter((result) => result.expectedSeverity && result.severityMet !== undefined);
  const latencies = detectionHits.flatMap((result) => result.latencyMinutes === undefined ? [] : [result.latencyMinutes]);
  const forecastLeads = forecastHits.flatMap((result) => result.forecastLeadMinutes === undefined ? [] : [result.forecastLeadMinutes]);
  const locationErrors = detectionHits.flatMap((result) => result.locationErrorKm === undefined ? [] : [result.locationErrorKm]);

  return {
    runId: input.runId,
    modelVersion: evaluationModelVersion,
    computedAt: input.computedAt,
    replay: {
      historyDays: input.historyDays ?? null,
      from: input.historyDays ? new Date(Date.parse(input.computedAt) - input.historyDays * 86_400_000).toISOString() : null,
      to: input.computedAt,
    },
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
      forecastNegativeEligibleCases: forecastNegativeEligible.length,
      forecastFalseAlarms: forecastFalseAlarms.length,
      forecastPrecisionPercent: forecastPrecisionDenominator ? round(forecastHits.length / forecastPrecisionDenominator * 100, 1) : null,
      forecastFalseAlarmRatePercent: forecastNegativeEligible.length ? round(forecastFalseAlarms.length / forecastNegativeEligible.length * 100, 1) : null,
      forecastBrierScore,
      medianForecastLeadMinutes: percentile(forecastLeads, 0.5),
      medianLatencyMinutes: percentile(latencies, 0.5),
      p95LatencyMinutes: percentile(latencies, 0.95),
      medianLocationErrorKm: percentile(locationErrors, 0.5),
      severityAgreementPercent: severityResults.length
        ? round(severityResults.filter((result) => result.severityMet).length / severityResults.length * 100, 1)
        : null,
      precisionAvailable: forecastEligible.length > 0 && forecastNegativeEligible.length > 0,
    },
    forecastCalibration: {
      archiveProductCount,
      unreadableProductCount,
      positiveCases: forecastEligible.length,
      negativeCases: forecastNegativeEligible.length,
      recommendedThresholdPercent: controlsReady ? recommended?.thresholdPercent ?? null : null,
      recommendationStatus,
      recommendationReason: recommendationStatus === "no_archived_probabilities"
        ? "尚无完整概率栅格归档，不能扫描80%以下阈值。"
        : recommendationStatus === "insufficient_controls"
          ? `至少需要5个已核验事件样本和5个同口径无事件对照；当前为${forecastEligible.length}个事件、${forecastNegativeEligible.length}个对照。${unreadableProductCount ? `另有${unreadableProductCount}期归档读取失败，未参与统计。` : ""}`
          : `在当前样本中以F1优先、误报率次优选择 ${recommended?.thresholdPercent}%；该阈值仍需按区域和季节进行独立验证。`,
      thresholdScores,
      reliabilityBins,
      groups: calibrationGroups,
    },
    results,
    sourceReliability: [...(input.sourceReliability ?? [])].sort((left, right) => left.successRatePercent - right.successRatePercent || right.attempts - left.attempts),
    limitations: [
      "事件检测召回率只统计已核验基准事件；基准库未覆盖全部真实事件时，不能据此计算事件发现链路的误报率或精确率。",
      "位置匹配使用基准样本配置的空间和时间容差；容差属于验收口径，不代表灾害实际影响范围。",
      "历史快照出现超过 90 分钟的缺口时，相应漏报样本标记为历史不足，不计入召回率分母。",
      "来源成功率表达抓取链路可用性，不等同于该来源对灾害事件的召回率或官方发布时效。",
      "滑坡/泥石流预测命中要求预测产品在真实事件发生前已被系统保存、有效期覆盖发生时刻，且预测面覆盖核验点或点目标落入配置容差。",
      "实时地图仍只展示达到业务阈值的高风险区；阈值扫描使用独立保存的完整概率栅格，不应将低风险格发布为灾害事件。",
      "滑坡预测精确率、误报率、Brier 分数和推荐阈值只使用按同一时空规则核验的事件样本与无事件对照；样本不足时只展示探索性曲线，不给出推荐阈值。",
      "推荐阈值不得直接跨区域、跨季节复用；calibrationGroup 用于形成区域/季节分层，正式启用前应在独立留出样本上复验。",
    ],
  };
}

function evaluateCase(
  benchmark: EvaluationBenchmarkCase,
  candidates: EvaluationCandidate[],
  snapshotTimes: string[],
  computedAtMs: number,
  sourceSuccessTimes: string[],
  forecastObservations?: ForecastRiskObservation[],
): EvaluationCaseResult {
  const window = evaluationWindow(benchmark);
  const outcome: EvaluationOutcome = benchmark.outcome === "no_event" ? "no_event" : "event";
  const base = {
    caseId: benchmark.caseId,
    title: benchmark.title,
    hazard: benchmark.hazard,
    objective: benchmark.objective,
    outcome,
    calibrationGroup: benchmark.calibrationGroup,
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
  if (benchmark.objective === "landslide_forecast" && forecastObservations !== undefined) {
    return evaluateForecastObservationCase(benchmark, base, forecastObservations);
  }
  if (benchmark.objective === "landslide_forecast" && outcome === "no_event") {
    return { ...base, status: "insufficient_history", reason: "无事件对照必须使用完整概率栅格核验；当前评测窗口没有可读取的原始概率归档。" };
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

function evaluateForecastObservationCase(
  benchmark: EvaluationBenchmarkCase,
  base: Pick<EvaluationCaseResult, "caseId" | "title" | "hazard" | "objective" | "outcome" | "calibrationGroup" | "evaluationStartAt" | "expectedBy" | "expectedSeverity" | "requiredSource">,
  observations: ForecastRiskObservation[],
): EvaluationCaseResult {
  const occurredAtMs = Date.parse(benchmark.occurredAt);
  const valid = observations
    .filter((observation) => {
      const capturedAtMs = Date.parse(observation.capturedAt);
      const leadMinutes = (occurredAtMs - capturedAtMs) / 60_000;
      return Number.isFinite(observation.riskPercent)
        && observation.riskPercent >= 0 && observation.riskPercent <= 100
        && leadMinutes >= benchmark.detectionDeadlineMinutes && leadMinutes <= benchmark.acceptedLeadMinutes
        && Date.parse(observation.validFrom) <= occurredAtMs && Date.parse(observation.validTo) >= occurredAtMs;
    })
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  if (!valid.length) {
    return { ...base, status: "insufficient_history", reason: "评测窗口内没有有效期覆盖核验时刻的完整概率栅格，不能判为漏报或正确排除。" };
  }
  const highestRisk = Math.max(...valid.map((item) => item.riskPercent));
  const threshold = benchmark.minimumForecastRiskPercent ?? 80;
  const firstAboveThreshold = valid.find((item) => item.riskPercent >= threshold);
  const common = {
    ...base,
    forecastRiskPercent: highestRisk,
    spatialMatch: "raster_cell" as const,
  };
  if (base.outcome === "no_event") {
    if (firstAboveThreshold) {
      return {
        ...common,
        status: "false_alarm",
        detectedAt: firstAboveThreshold.capturedAt,
        matchedTitle: `完整概率栅格 ${firstAboveThreshold.productId}`,
        forecastLeadMinutes: round((occurredAtMs - Date.parse(firstAboveThreshold.capturedAt)) / 60_000, 1),
        reason: `已核验无事件对照在评测窗口内达到 ${highestRisk}%，高于 ${threshold}% 阈值，计为预测误报。`,
      };
    }
    return {
      ...common,
      status: "correct_rejection",
      reason: `完整概率栅格覆盖对照窗口，最高风险 ${highestRisk}%，未达到 ${threshold}% 阈值，计为正确排除。`,
    };
  }
  if (firstAboveThreshold) {
    const leadMinutes = (occurredAtMs - Date.parse(firstAboveThreshold.capturedAt)) / 60_000;
    return {
      ...common,
      status: "detected",
      detectedAt: firstAboveThreshold.capturedAt,
      matchedTitle: `完整概率栅格 ${firstAboveThreshold.productId}`,
      forecastLeadMinutes: round(leadMinutes, 1),
      reason: `系统在事件前 ${formatLead(leadMinutes)} 已归档完整概率栅格；核验位置风险最高 ${highestRisk}%，达到 ${threshold}% 阈值。`,
    };
  }
  return {
    ...common,
    status: "missed",
    reason: `完整概率栅格覆盖评测窗口，但核验位置最高风险仅 ${highestRisk}%，未达到 ${threshold}% 阈值。`,
  };
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

function forecastThresholdScores(results: EvaluationCaseResult[]): ForecastThresholdScore[] {
  return Array.from({ length: 11 }, (_, index) => 50 + index * 5).map((thresholdPercent) => {
    const truePositive = results.filter((result) => result.outcome === "event" && (result.forecastRiskPercent ?? 0) >= thresholdPercent).length;
    const falsePositive = results.filter((result) => result.outcome === "no_event" && (result.forecastRiskPercent ?? 0) >= thresholdPercent).length;
    const trueNegative = results.filter((result) => result.outcome === "no_event" && (result.forecastRiskPercent ?? 0) < thresholdPercent).length;
    const falseNegative = results.filter((result) => result.outcome === "event" && (result.forecastRiskPercent ?? 0) < thresholdPercent).length;
    const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
    const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
    const falseAlarmRate = falsePositive + trueNegative ? falsePositive / (falsePositive + trueNegative) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null;
    return {
      thresholdPercent,
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      precisionPercent: precision === null ? null : round(precision * 100, 1),
      recallPercent: recall === null ? null : round(recall * 100, 1),
      falseAlarmRatePercent: falseAlarmRate === null ? null : round(falseAlarmRate * 100, 1),
      f1Percent: f1 === null ? null : round(f1 * 100, 1),
    };
  });
}

function forecastReliabilityBins(results: EvaluationCaseResult[]): ForecastReliabilityBin[] {
  return Array.from({ length: 5 }, (_, index) => {
    const minimumPercent = index * 20;
    const maximumPercent = index === 4 ? 100 : minimumPercent + 20;
    const members = results.filter((result) => {
      const risk = result.forecastRiskPercent ?? -1;
      return risk >= minimumPercent && (index === 4 ? risk <= maximumPercent : risk < maximumPercent);
    });
    return {
      minimumPercent,
      maximumPercent,
      sampleCount: members.length,
      meanForecastPercent: members.length ? round(members.reduce((sum, result) => sum + (result.forecastRiskPercent ?? 0), 0) / members.length, 1) : null,
      observedEventRatePercent: members.length ? round(members.filter((result) => result.outcome === "event").length / members.length * 100, 1) : null,
    };
  });
}

function compareThresholdScores(left: ForecastThresholdScore, right: ForecastThresholdScore) {
  return (right.f1Percent ?? -1) - (left.f1Percent ?? -1)
    || (left.falseAlarmRatePercent ?? 101) - (right.falseAlarmRatePercent ?? 101)
    || right.thresholdPercent - left.thresholdPercent;
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
