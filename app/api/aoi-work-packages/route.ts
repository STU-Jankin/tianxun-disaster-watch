import { createAoiWorkPackagesFromTask, listAoiWorkPackages, transitionStoredAoiWorkPackage } from "../../../db/operational";
import { aoiWorkPackageStatuses, type AoiWorkPackageAction } from "../../../lib/aoi-work-packages";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const role = await apiRole(request);
    const packages = await listAoiWorkPackages({
      taskId: boundedQuery(url.searchParams.get("taskId")),
      masterEventId: boundedQuery(url.searchParams.get("masterEventId")),
      includeCancelled: url.searchParams.get("includeCancelled") === "1" && role === "admin",
      limit: Number(url.searchParams.get("limit") ?? 200),
    }, undefined);
    return Response.json({ packages, policy: { separationOfDuties: true, statuses: aoiWorkPackageStatuses }, storage: "operational-database" }, { headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("AOI work package read unavailable", error);
    return Response.json({ error: "AOI 复核分块暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "aoi-work-package-create", 20);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 32 * 1024);
    if (body.action !== "generate") throw new ApiInputError("POST 只支持 generate 动作", 400);
    const taskId = requiredText(body.taskId, 220, "任务 ID");
    const widthKm = finiteNumber(body.widthKm, 1, 1_000, "分块宽度");
    const heightKm = finiteNumber(body.heightKm, 1, 1_000, "分块高度");
    const maximumPackages = body.maximumPackages === undefined ? 100 : finiteNumber(body.maximumPackages, 1, 200, "最大分块数", true);
    const actor = await apiActor(request);
    const packages = await createAoiWorkPackagesFromTask({ taskId, widthKm, heightKm, maximumPackages }, actor, await apiRole(request) === "admin");
    return Response.json({ packages, created: packages.length, storage: "operational-database" }, { status: 201, headers: privateHeaders() });
  } catch (error) { return actionError(error, "AOI 分块生成失败"); }
}

export async function PATCH(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "operator")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "aoi-work-package-transition", 80);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const packageId = requiredText(body.packageId, 220, "分块 ID");
    const expectedRevision = finiteNumber(body.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "版本", true);
    const action = String(body.action ?? "") as AoiWorkPackageAction;
    if (!["claim", "release", "submit", "start_review", "approve", "request_changes", "cancel"].includes(action)) throw new ApiInputError("AOI 分块动作无效", 400);
    const note = body.note === undefined ? "" : requiredText(body.note, 1_000, "备注", false);
    const actor = await apiActor(request);
    const workPackage = await transitionStoredAoiWorkPackage(packageId, expectedRevision, action, actor, note, true);
    return Response.json({ package: workPackage, storage: "operational-database" }, { headers: privateHeaders() });
  } catch (error) { return actionError(error, "AOI 分块状态更新失败"); }
}

function actionError(error: unknown, fallback: string) {
  if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && /不存在/.test(error.message)) return Response.json({ error: error.message }, { status: 404 });
  if (error instanceof Error && /版本冲突|不允许|已被其他|不能自审/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof Error && /不属于|只有当前领取人/.test(error.message)) return Response.json({ error: error.message }, { status: 403 });
  if (error instanceof Error && /必须|无效|缺少|超过|至少|损坏/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
  console.error(fallback, error);
  return Response.json({ error: fallback, requestId: crypto.randomUUID() }, { status: 503 });
}

function boundedQuery(value: string | null) { const normalized = value?.trim() ?? ""; if (normalized.length > 220) throw new ApiInputError("查询参数无效", 400); return normalized || undefined; }
function requiredText(value: unknown, maximum: number, label: string, required = true) { if (typeof value !== "string") throw new ApiInputError(`${label}必须是文本`, 400); const text = value.trim(); if (required && !text) throw new ApiInputError(`${label}不能为空`, 400); if (text.length > maximum) throw new ApiInputError(`${label}过长`, 400); return text; }
function finiteNumber(value: unknown, min: number, max: number, label: string, integer = false) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new ApiInputError(`${label}必须在 ${min}–${max} 之间`, 400); return number; }
function privateHeaders() { return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }; }
