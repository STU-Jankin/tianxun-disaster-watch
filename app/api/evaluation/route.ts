import {
  deleteEvaluationCase,
  evaluationSnapshotTimes,
  evaluationSourceReliability,
  listEvaluationCandidates,
  listEvaluationCases,
  listEvaluationRuns,
  persistEvaluationRun,
  upsertEvaluationCase,
} from "../../../db/operational";
import { apiActor, ApiInputError, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { evaluateDetectionBenchmarks, evaluationCoverageGapMinutes, evaluationWindow, type EvaluationBenchmarkCase } from "../../../lib/evaluation-center";
import type { HazardType } from "../../../lib/disasters";

export const dynamic = "force-dynamic";

const hazards = new Set<HazardType>(["earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"]);
const severities = new Set(["blue", "yellow", "orange", "red"]);

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  const [cases, runs] = await Promise.all([listEvaluationCases(), listEvaluationRuns(10)]);
  return Response.json({ cases, runs, latest: runs[0] ?? null }, { headers: privateHeaders() });
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
    if (action === "delete_case") {
      const caseId = text(body.caseId, "样本编号", 120);
      if (!/^benchmark-[a-zA-Z0-9_-]{8,100}$/.test(caseId)) throw new ApiInputError("样本编号无效", 400);
      const deleted = await deleteEvaluationCase(caseId);
      return deleted
        ? Response.json({ deleted: true, caseId }, { headers: privateHeaders() })
        : Response.json({ error: "评测样本不存在" }, { status: 404, headers: privateHeaders() });
    }
    if (action === "run") {
      const cases = await listEvaluationCases();
      if (!cases.length) throw new ApiInputError("请先录入至少一个权威核验样本", 400);
      const computedAt = new Date().toISOString();
      const windows = cases.map(evaluationWindow);
      const coveragePaddingMs = evaluationCoverageGapMinutes * 60_000;
      const from = new Date(Math.min(...windows.map((item) => Date.parse(item.startAt))) - coveragePaddingMs).toISOString();
      const to = new Date(Math.min(Date.parse(computedAt), Math.max(...windows.map((item) => Date.parse(item.expectedBy))) + coveragePaddingMs)).toISOString();
      const candidatesByCase: Record<string, Awaited<ReturnType<typeof listEvaluationCandidates>>> = {};
      for (const benchmark of cases) {
        candidatesByCase[benchmark.caseId] = benchmark.verificationStatus === "verified" ? await listEvaluationCandidates(benchmark) : [];
      }
      const [snapshotTimes, sourceReliability] = await Promise.all([
        evaluationSnapshotTimes(from, to),
        evaluationSourceReliability(from, to),
      ]);
      const report = evaluateDetectionBenchmarks({
        runId: `evaluation-${crypto.randomUUID()}`,
        computedAt,
        cases,
        candidatesByCase,
        snapshotTimes,
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
  const occurredAt = isoDate(input.occurredAt, "发生时间");
  if (Date.parse(occurredAt) > Date.now() + 60_000) throw new ApiInputError("权威核验样本不能使用未来发生时间", 400);
  const expectedSeverity = optionalText(input.expectedSeverity, 20);
  if (expectedSeverity && !severities.has(expectedSeverity)) throw new ApiInputError("期望等级无效", 400);
  const provenanceUrl = sourceUrl(input.provenanceUrl);
  const verificationStatus = input.verificationStatus === "draft" ? "draft" : "verified";
  return {
    caseId,
    title,
    hazard,
    occurredAt,
    latitude: finiteNumber(input.latitude, "纬度", -90, 90),
    longitude: finiteNumber(input.longitude, "经度", -180, 180),
    locationToleranceKm: finiteNumber(input.locationToleranceKm, "位置容差", 0.1, 1_000),
    eventTimeToleranceHours: finiteNumber(input.eventTimeToleranceHours, "事件时间容差", 0.1, 168),
    acceptedLeadMinutes: integer(input.acceptedLeadMinutes, "允许提前发现时间", 0, 10_080),
    detectionDeadlineMinutes: integer(input.detectionDeadlineMinutes, "检测时限", 1, 10_080),
    expectedSeverity: expectedSeverity as EvaluationBenchmarkCase["expectedSeverity"],
    requiredSource: optionalText(input.requiredSource, 120),
    provenanceUrl,
    notes: optionalText(input.notes, 500) ?? "",
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
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new Error("unsafe");
    return parsed.toString();
  } catch {
    throw new ApiInputError("权威来源链接必须是有效的 HTTP(S) 地址，且不能包含账号密码", 400);
  }
}

function privateHeaders() {
  return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
}
