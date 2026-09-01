import type { DisasterEvent, HazardType } from "./disasters.ts";

export const evaluationModelVersion = "tianxun-detection-evaluation-v1";
export const evaluationCoverageGapMinutes = 90;

export type EvaluationSeverity = DisasterEvent["severity"];

export type EvaluationBenchmarkCase = {
  caseId: string;
  title: string;
  hazard: HazardType;
  occurredAt: string;
  latitude: number;
  longitude: number;
  locationToleranceKm: number;
  eventTimeToleranceHours: number;
  acceptedLeadMinutes: number;
  detectionDeadlineMinutes: number;
  expectedSeverity?: EvaluationSeverity;
  requiredSource?: string;
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
  status: "detected" | "missed" | "pending" | "insufficient_history" | "draft";
  evaluationStartAt: string;
  expectedBy: string;
  detectedAt?: string;
  matchedMasterEventId?: string;
  matchedTitle?: string;
  latencyMinutes?: number;
  locationErrorKm?: number;
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
  ));
  const eligible = results.filter((result) => result.status === "detected" || result.status === "missed");
  const detected = eligible.filter((result) => result.status === "detected");
  const deadlineHits = detected.filter((result) => (result.latencyMinutes ?? Number.POSITIVE_INFINITY) <= caseById(input.cases, result.caseId).detectionDeadlineMinutes);
  const severityResults = detected.filter((result) => result.expectedSeverity && result.severityMet !== undefined);
  const latencies = detected.flatMap((result) => result.latencyMinutes === undefined ? [] : [result.latencyMinutes]);
  const locationErrors = detected.flatMap((result) => result.locationErrorKm === undefined ? [] : [result.locationErrorKm]);

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
      recallPercent: eligible.length ? round(detected.length / eligible.length * 100, 1) : null,
      deadlineHitRatePercent: eligible.length ? round(deadlineHits.length / eligible.length * 100, 1) : null,
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
    ],
  };
}

function evaluateCase(
  benchmark: EvaluationBenchmarkCase,
  candidates: EvaluationCandidate[],
  snapshotTimes: string[],
  computedAtMs: number,
): EvaluationCaseResult {
  const window = evaluationWindow(benchmark);
  const base = {
    caseId: benchmark.caseId,
    title: benchmark.title,
    hazard: benchmark.hazard,
    evaluationStartAt: window.startAt,
    expectedBy: window.expectedBy,
    expectedSeverity: benchmark.expectedSeverity,
    requiredSource: benchmark.requiredSource,
  };
  if (benchmark.verificationStatus !== "verified") {
    return { ...base, status: "draft", reason: "样本尚未标记为已核验，不参与正式指标。" };
  }
  if (computedAtMs < Date.parse(window.expectedBy)) {
    return { ...base, status: "pending", reason: "检测时限尚未结束，暂不计入召回率。" };
  }
  const matching = candidates
    .filter((candidate) => candidateMatches(benchmark, candidate.event))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt)
      || candidateScore(benchmark, left.event) - candidateScore(benchmark, right.event));
  const match = matching[0];
  if (match) {
    const latencyMinutes = (Date.parse(match.capturedAt) - Date.parse(benchmark.occurredAt)) / 60_000;
    const locationErrorKm = haversineKm(benchmark.latitude, benchmark.longitude, match.event.latitude, match.event.longitude);
    const severityMet = benchmark.expectedSeverity
      ? severityRank(match.event.severity) >= severityRank(benchmark.expectedSeverity)
      : undefined;
    return {
      ...base,
      status: "detected",
      detectedAt: match.capturedAt,
      matchedMasterEventId: match.event.masterEventId,
      matchedTitle: match.event.title,
      latencyMinutes: round(latencyMinutes, 1),
      locationErrorKm: round(locationErrorKm, 1),
      detectedSeverity: match.event.severity,
      severityMet,
      reason: severityMet === false
        ? "在检测时限内发现事件，但首次匹配等级低于基准等级。"
        : "在配置的空间、时间和来源口径内找到最早匹配快照。",
    };
  }
  const coverage = caseCoverage(snapshotTimes, window.startAt, window.expectedBy);
  if (!coverage.complete) {
    return { ...base, status: "insufficient_history", reason: coverage.reason };
  }
  return { ...base, status: "missed", reason: "历史快照覆盖完整，但在检测时限内未找到符合空间、时间和来源口径的事件。" };
}

function candidateMatches(benchmark: EvaluationBenchmarkCase, event: DisasterEvent) {
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

function candidateScore(benchmark: EvaluationBenchmarkCase, event: DisasterEvent) {
  const distance = haversineKm(benchmark.latitude, benchmark.longitude, event.latitude, event.longitude) / Math.max(benchmark.locationToleranceKm, 1);
  const time = Math.abs(Date.parse(event.occurredAt) - Date.parse(benchmark.occurredAt)) / 3_600_000 / Math.max(benchmark.eventTimeToleranceHours, 1);
  return distance + time;
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
