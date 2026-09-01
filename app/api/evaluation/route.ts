import {
  deleteEvaluationCase,
  evaluationSnapshotTimes,
  evaluationSourceReliability,
  evaluationSourceSuccessTimes,
  forecastRasterArchiveStatus,
  listEvaluationCandidates,
  listEvaluationCases,
  listEvaluationRuns,
  listForecastRasterProducts,
  persistEvaluationRun,
  upsertEvaluationCase,
} from "../../../db/operational";
import { apiActor, ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { evaluateDetectionBenchmarks, evaluationCoverageGapMinutes, evaluationWindow, type EvaluationBenchmarkCase, type EvaluationObjective } from "../../../lib/evaluation-center";
import type { HazardSubtype, HazardType } from "../../../lib/disasters";
import { decodeLhasaRiskPng, lhasaRiskAtLocation } from "../../../lib/lhasa-nowcast";
import { readForecastRasterObject } from "../../../lib/forecast-raster-storage";

export const dynamic = "force-dynamic";

const hazards = new Set<HazardType>(["earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"]);
const severities = new Set(["blue", "yellow", "orange", "red"]);
const objectives = new Set<EvaluationObjective>(["event_detection", "landslide_forecast"]);
const landslideSubtypes = new Set<HazardSubtype>(["landslide", "debris_flow", "rockfall", "slope_failure", "mass_movement"]);

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  const [cases, runs, forecastArchive] = await Promise.all([listEvaluationCases(), listEvaluationRuns(10), forecastRasterArchiveStatus()]);
  return Response.json({ cases, runs, latest: runs[0] ?? null, forecastArchive }, { headers: privateHeaders() });
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "admin")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "evaluation-write", 12, 60_000);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 48 * 1024);
    const action = text(body.action, "操作", 40);
    if (action === "upsert_case") {
      const actor = await apiActor(request);
      const benchmark = benchmarkFromInput(body.case, actor);
      const existingCases = await listEvaluationCases();
      if (existingCases.length >= 100 && !existingCases.some((item) => item.caseId === benchmark.caseId)) throw new ApiInputError("评测基准库已达到 100 个样本上限，请先清理或导出旧样本", 409);
      await upsertEvaluationCase(benchmark);
      return Response.json({ case: benchmark }, { headers: privateHeaders() });
    }
    if (action === "import_landslide_cases") {
      if (!new Set(["tianxun.landslide-benchmark/v1", "tianxun.landslide-benchmark/v2"]).has(String(body.schema)) || !Array.isArray(body.cases) || !body.cases.length || body.cases.length > 25) {
        throw new ApiInputError("滑坡样本文件格式无效，单次最多导入 25 条", 400);
      }
      const actor = await apiActor(request);
      const benchmarks = body.cases.map((item) => benchmarkFromInput({ ...(item as Record<string, unknown>), objective: "landslide_forecast", hazard: "landslide" }, actor));
      const existingCases = await listEvaluationCases();
      const existingIds = new Set(existingCases.map((item) => item.caseId));
      const newIds = new Set(benchmarks.map((item) => item.caseId));
      if (newIds.size !== benchmarks.length) throw new ApiInputError("样本文件包含重复编号，请先去重", 400);
      const addedCount = [...newIds].filter((caseId) => !existingIds.has(caseId)).length;
      if (existingCases.length + addedCount > 100) throw new ApiInputError("导入后将超过 100 个样本上限，请先清理旧样本", 409);
      for (const benchmark of benchmarks) await upsertEvaluationCase(benchmark);
      return Response.json({ imported: benchmarks.length, cases: benchmarks }, { headers: privateHeaders() });
    }
    if (action === "delete_case") {
      const caseId = text(body.caseId, "样本编号", 120);
      if (!/^benchmark-[a-zA-Z0-9_-]{8,100}$/.test(caseId)) throw new ApiInputError("样本编号无效", 400);
      const deleted = await deleteEvaluationCase(caseId);
      return deleted
        ? Response.json({ deleted: true, caseId }, { headers: privateHeaders() })
        : Response.json({ error: "评测样本不存在" }, { status: 404, headers: privateHeaders() });
    }
    if (action === "run") {
      const historyDays = body.historyDays === null || body.historyDays === undefined ? null : integer(body.historyDays, "回放天数", 30, 365);
      if (historyDays !== null && ![30, 90, 365].includes(historyDays)) throw new ApiInputError("回放范围仅支持30、90或365天", 400);
      const allCases = await listEvaluationCases();
      const replayFrom = historyDays === null ? Number.NEGATIVE_INFINITY : Date.now() - historyDays * 86_400_000;
      const cases = allCases.filter((item) => Date.parse(item.occurredAt) >= replayFrom);
      if (!cases.length) throw new ApiInputError("请先录入至少一个权威核验样本", 400);
      const computedAt = new Date().toISOString();
      const windows = cases.map(evaluationWindow);
      const coveragePaddingMs = evaluationCoverageGapMinutes * 60_000;
      const from = new Date(Math.min(...windows.map((item) => Date.parse(item.startAt))) - coveragePaddingMs).toISOString();
      const to = new Date(Math.min(Date.parse(computedAt), Math.max(...windows.map((item) => Date.parse(item.expectedBy))) + coveragePaddingMs)).toISOString();
      const candidatesByCase: Record<string, Awaited<ReturnType<typeof listEvaluationCandidates>>> = {};
      const sourceSuccessTimesByCase: Record<string, string[]> = {};
      for (const benchmark of cases) {
        candidatesByCase[benchmark.caseId] = benchmark.verificationStatus === "verified" ? await listEvaluationCandidates(benchmark) : [];
        sourceSuccessTimesByCase[benchmark.caseId] = benchmark.verificationStatus === "verified" && benchmark.requiredSource
          ? await evaluationSourceSuccessTimes(benchmark.requiredSource, evaluationWindow(benchmark).startAt, evaluationWindow(benchmark).expectedBy)
          : [];
      }
      const [snapshotTimes, sourceReliability] = await Promise.all([
        evaluationSnapshotTimes(from, to),
        evaluationSourceReliability(from, to),
      ]);
      const forecastCases = cases.filter((benchmark) => benchmark.objective === "landslide_forecast" && benchmark.verificationStatus === "verified");
      const forecastProducts = forecastCases.length ? await listForecastRasterProducts(from, to, 1_500) : [];
      const forecastObservationsByCase: Record<string, Array<{ productId: string; capturedAt: string; validFrom: string; validTo: string; riskPercent: number }>> = {};
      let forecastArchiveUnreadableCount = 0;
      if (forecastProducts.length) {
        for (const benchmark of forecastCases) forecastObservationsByCase[benchmark.caseId] = [];
        for (const product of forecastProducts) {
          const relevantCases = forecastCases.filter((benchmark) => {
            const window = evaluationWindow(benchmark);
            return Date.parse(product.archivedAt) >= Date.parse(window.startAt)
              && Date.parse(product.archivedAt) <= Date.parse(window.expectedBy)
              && Date.parse(product.validFrom) <= Date.parse(benchmark.occurredAt)
              && Date.parse(product.validTo) >= Date.parse(benchmark.occurredAt);
          });
          if (!relevantCases.length) continue;
          try {
            const bytes = await readForecastRasterObject(product.storageKey, product.storageBackend);
            if (!bytes) { forecastArchiveUnreadableCount += 1; continue; }
            const raster = await decodeLhasaRiskPng(bytes, product.groupPixels);
            if (raster.sourceWidth !== product.sourceWidth || raster.sourceHeight !== product.sourceHeight) { forecastArchiveUnreadableCount += 1; continue; }
            for (const benchmark of relevantCases) {
              const riskPercent = lhasaRiskAtLocation(raster, benchmark.latitude, benchmark.longitude);
              if (riskPercent === null) continue;
              forecastObservationsByCase[benchmark.caseId].push({
                productId: product.productId,
                capturedAt: product.archivedAt,
                validFrom: product.validFrom,
                validTo: product.validTo,
                riskPercent,
              });
            }
          } catch (error) {
            forecastArchiveUnreadableCount += 1;
            console.error(`forecast archive ${product.productId} could not be replayed`, error);
          }
        }
      }
      const report = evaluateDetectionBenchmarks({
        runId: `evaluation-${crypto.randomUUID()}`,
        computedAt,
        cases,
        candidatesByCase,
        snapshotTimes,
        sourceSuccessTimesByCase,
        forecastObservationsByCase: forecastProducts.length ? forecastObservationsByCase : undefined,
        forecastArchiveProductCount: forecastProducts.length,
        forecastArchiveUnreadableCount,
        historyDays,
        sourceReliability,
      });
      await persistEvaluationRun(report, await apiActor(request));
      return Response.json({ report }, { headers: privateHeaders() });
    }
    throw new ApiInputError("不支持的评测操作", 400);
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders() });
    console.error("evaluation center operation failed", error);
    return Response.json({ error: "评测中心暂不可用，请稍后重试" }, { status: 503, headers: privateHeaders() });
  }
}

function benchmarkFromInput(value: unknown, actor: string): EvaluationBenchmarkCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError("评测样本格式无效", 400);
  const input = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const caseId = input.caseId === undefined || input.caseId === null || input.caseId === ""
    ? `benchmark-${crypto.randomUUID()}`
    : text(input.caseId, "样本编号", 120);
  if (!/^benchmark-[a-zA-Z0-9_-]{8,100}$/.test(caseId)) throw new ApiInputError("样本编号无效", 400);
  const title = text(input.title, "样本名称", 160);
  const hazard = text(input.hazard, "灾种", 30) as HazardType;
  if (!hazards.has(hazard)) throw new ApiInputError("灾种无效", 400);
  const objective = (optionalText(input.objective, 40) ?? "event_detection") as EvaluationObjective;
  if (!objectives.has(objective)) throw new ApiInputError("评测目标无效", 400);
  if (objective === "landslide_forecast" && hazard !== "landslide") throw new ApiInputError("事前预测评测目前仅支持滑坡和泥石流", 400);
  const outcome = input.outcome === "no_event" ? "no_event" : "event";
  if (objective !== "landslide_forecast" && outcome === "no_event") throw new ApiInputError("无事件对照目前仅用于滑坡/泥石流事前预测校准", 400);
  const hazardSubtypeText = optionalText(input.hazardSubtype, 40);
  if (hazardSubtypeText && !landslideSubtypes.has(hazardSubtypeText as HazardSubtype)) throw new ApiInputError("滑坡灾害子类型无效", 400);
  const occurredAt = isoDate(input.occurredAt, "发生时间");
  if (Date.parse(occurredAt) > Date.now() + 60_000) throw new ApiInputError("权威核验样本不能使用未来发生时间", 400);
  const expectedSeverity = optionalText(input.expectedSeverity, 20);
  if (expectedSeverity && !severities.has(expectedSeverity)) throw new ApiInputError("期望等级无效", 400);
  const provenanceUrl = sourceUrl(input.provenanceUrl);
  if (input.verificationStatus !== undefined && !["draft", "verified"].includes(String(input.verificationStatus))) throw new ApiInputError("核验状态无效", 400);
  const verificationStatus = input.verificationStatus === "verified" ? "verified" : "draft";
  const acceptedLeadMinutes = integer(input.acceptedLeadMinutes, objective === "landslide_forecast" ? "最大预测提前量" : "允许提前发现时间", 0, 10_080);
  const detectionDeadlineMinutes = integer(input.detectionDeadlineMinutes, objective === "landslide_forecast" ? "最小有效提前量" : "检测时限", objective === "landslide_forecast" ? 0 : 1, 10_080);
  if (objective === "landslide_forecast" && acceptedLeadMinutes <= detectionDeadlineMinutes) throw new ApiInputError("最大预测提前量必须大于最小有效提前量", 400);
  const minimumForecastRiskPercent = objective === "landslide_forecast"
    ? finiteNumber(input.minimumForecastRiskPercent ?? 80, "最低预测风险值", 50, 100)
    : undefined;
  const notes = optionalText(input.notes, 500) ?? "";
  if (outcome === "no_event" && verificationStatus === "verified" && notes.length < 10) throw new ApiInputError("已核验无事件对照必须在备注中说明核验目录和时间范围", 400);
  return {
    caseId,
    title,
    hazard,
    objective,
    hazardSubtype: hazardSubtypeText as HazardSubtype | undefined,
    outcome,
    calibrationGroup: objective === "landslide_forecast" ? optionalText(input.calibrationGroup, 80) : undefined,
    occurredAt,
    latitude: finiteNumber(input.latitude, "纬度", -90, 90),
    longitude: finiteNumber(input.longitude, "经度", -180, 180),
    locationToleranceKm: finiteNumber(input.locationToleranceKm, "位置容差", 0.1, 1_000),
    eventTimeToleranceHours: finiteNumber(input.eventTimeToleranceHours, "事件时间容差", 0.1, 168),
    acceptedLeadMinutes,
    detectionDeadlineMinutes,
    expectedSeverity: expectedSeverity as EvaluationBenchmarkCase["expectedSeverity"],
    requiredSource: objective === "landslide_forecast" ? optionalText(input.requiredSource, 120) ?? "NASA LHASA" : optionalText(input.requiredSource, 120),
    minimumForecastRiskPercent,
    provenanceUrl,
    notes,
    verificationStatus,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new ApiInputError(`${label}无效`, 400);
  return value.trim();
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maximum) throw new ApiInputError("文本字段无效", 400);
  return value.trim() || undefined;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new ApiInputError(`${label}超出允许范围`, 400);
  return parsed;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  const parsed = finiteNumber(value, label, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new ApiInputError(`${label}必须为整数`, 400);
  return parsed;
}

function isoDate(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ApiInputError(`${label}格式无效`, 400);
  return new Date(value).toISOString();
}

function sourceUrl(value: unknown) {
  const raw = text(value, "权威来源链接", 1_500);
  try {
    const parsed = new URL(raw);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.hostname.endsWith(".invalid")) throw new Error("unsafe");
    return parsed.toString();
  } catch {
    throw new ApiInputError("权威来源链接必须替换为真实的 HTTP(S) 权威地址，且不能包含账号密码", 400);
  }
}

function privateHeaders() {
  return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
}
