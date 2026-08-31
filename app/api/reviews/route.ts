import { getCanonicalEventForTask, getEventReview, listEventReviewHistory, saveEventReview } from "../../../db/operational";
import { eventAlertVersion, eventReviewStatuses, summarizeEventReview, type EventReviewStatus, type ReviewRiskInput } from "../../../lib/event-review";
import { eventRevisionFingerprint } from "../../../lib/event-integrity";
import { ApiInputError, apiActor, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  try {
    const masterEventId = validMasterEventId(new URL(request.url).searchParams.get("masterEventId"));
    const canonical = await getCanonicalEventForTask(masterEventId);
    if (!canonical) return Response.json({ error: "主事件不存在、已归档或尚未可靠入库" }, { status: 404 });
    const [review, history] = await Promise.all([getEventReview(masterEventId), listEventReviewHistory(masterEventId)]);
    return Response.json({
      review: review ? summarizeEventReview(canonical.event, review, eventRevisionFingerprint(canonical.event)) : null,
      history,
      policy: {
        sharedRecord: true,
        optimisticRevision: true,
        riskInputsRequireBasis: true,
        historicalReplayReadOnly: true,
      },
    }, { headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("event review read unavailable", error);
    return Response.json({ error: "事件研判记录暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "event-review-write", 40);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 24 * 1024);
    const masterEventId = validMasterEventId(body.masterEventId);
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new ApiInputError("expectedRevision 必须是非负整数", 400);
    const status = String(body.status ?? "") as EventReviewStatus;
    if (!eventReviewStatuses.includes(status)) throw new ApiInputError("研判状态无效", 400);
    const assignee = boundedText(body.assignee, 120, "负责人");
    const conclusion = boundedText(body.conclusion, 2_000, "研判结论");
    if (["verified", "rejected", "closed"].includes(status) && conclusion.length < 5) throw new ApiInputError("确认、驳回或结束时必须填写至少5个字的研判结论", 400);
    const exposure = riskInput(body.exposure, "暴露度");
    const vulnerability = riskInput(body.vulnerability, "脆弱性");
    const acknowledgeAlert = body.acknowledgeAlert === true;
    const suppliedEventRevision = boundedText(body.eventRevision, 128, "事件版本");
    if (!suppliedEventRevision) throw new ApiInputError("缺少事件版本，请刷新后重试", 400);
    const canonical = await getCanonicalEventForTask(masterEventId);
    if (!canonical) return Response.json({ error: "主事件不存在、已归档或尚未可靠入库；请刷新事件" }, { status: 409 });
    const currentEventRevision = eventRevisionFingerprint(canonical.event);
    if (suppliedEventRevision !== currentEventRevision) return Response.json({ error: "事件已有新版本，请刷新后重新研判" }, { status: 409 });
    if (acknowledgeAlert && !["orange", "red"].includes(canonical.event.severity)) throw new ApiInputError("只有当前红色或橙色告警需要值守确认", 400);
    const actor = await apiActor(request);
    const record = await saveEventReview({
      masterEventId,
      status,
      assignee,
      conclusion,
      exposure,
      vulnerability,
      acknowledgeAlert,
      alertVersion: eventAlertVersion(canonical.event),
      eventRevision: currentEventRevision,
      expectedRevision,
      actor,
    });
    const history = await listEventReviewHistory(masterEventId);
    return Response.json({
      review: summarizeEventReview(canonical.event, record, currentEventRevision),
      history,
      storage: "operational-database",
    }, { headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /版本冲突|其他操作员更新|不允许的研判状态转换/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    console.error("event review save unavailable", error);
    return Response.json({ error: "事件研判保存失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function validMasterEventId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 220 || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new ApiInputError("主事件编号无效", 400);
  return normalized;
}

function boundedText(value: unknown, maximum: number, label: string) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ApiInputError(`${label}必须是文本`, 400);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new ApiInputError(`${label}超过${maximum}字`, 400);
  return normalized;
}

function riskInput(value: unknown, label: string): ReviewRiskInput | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError(`${label}输入无效`, 400);
  const record = value as Record<string, unknown>;
  const index = Number(record.index);
  if (!Number.isInteger(index) || index < 0 || index > 100) throw new ApiInputError(`${label}指数必须是0至100的整数`, 400);
  const basis = boundedText(record.basis, 500, `${label}依据`);
  if (basis.length < 3) throw new ApiInputError(`${label}指数必须同时填写至少3个字的数据或研判依据`, 400);
  return { index, basis };
}

function privateHeaders() {
  return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
}
