import { listRoadDisruptions, transitionRoadDisruption, upsertRoadDisruptionReports } from "../../../db/operational";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { normalizeRoadDisruptionGeoJson } from "../../../lib/response-disruptions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = authorizeApiRequest(request, "operator");
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const activeAtValue = url.searchParams.get("activeAt")?.trim() ?? "";
    const includeInactive = url.searchParams.get("includeInactive") === "1" && apiRole(request) === "admin";
    const activeAt = activeAtValue ? validIso(activeAtValue, "activeAt") : includeInactive ? undefined : new Date().toISOString();
    return Response.json({
      disruptions: await listRoadDisruptions({ activeAt, includeInactive }),
      storage: "operational-database",
      policy: "reported records never become hard blocks until an administrator verifies them",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("road disruption registry unavailable", error);
    return Response.json({ error: "道路中断台账暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = authorizeApiRequest(request, "operator") ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "road-disruption-report", 20);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 512 * 1024);
    const now = new Date();
    const input = body.geojson ?? body;
    const normalized = normalizeRoadDisruptionGeoJson(input, now.toISOString());
    const reports = normalized.map((item) => ({
      ...item,
      disruptionId: `road-${crypto.randomUUID()}`,
      verification: "reported" as const,
      validFrom: item.validFrom ?? now.toISOString(),
      validTo: item.validTo ?? new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      validityBasis: item.validTo ? "reported" as const : "default_24h" as const,
      source: item.source || "操作员 GeoJSON 上报",
    }));
    const actor = apiActor(request);
    const disruptions = await upsertRoadDisruptionReports(reports, actor, apiRole(request) === "admin");
    return Response.json({ disruptions, storage: "operational-database", warning: "所有新上报均为待核验状态；未提供有效结束时间时自动按 24 小时失效" }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /GeoJSON|道路中断|坐标|有效期|affectedModes|不属于/.test(error.message)) return Response.json({ error: error.message }, { status: /不属于/.test(error.message) ? 403 : 400 });
    console.error("road disruption report unavailable", error);
    return Response.json({ error: "道路中断上报失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const unauthorized = authorizeApiRequest(request, "admin") ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "road-disruption-review", 40);
  if (limited) return limited;
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const disruptionId = typeof body.disruptionId === "string" ? body.disruptionId.trim() : "";
    const revision = Number(body.revision);
    const action = String(body.action ?? "");
    if (!/^road-[0-9a-f-]{36}$/i.test(disruptionId)) throw new ApiInputError("道路中断 ID 无效", 400);
    if (!Number.isInteger(revision) || revision < 1) throw new ApiInputError("revision 必须是正整数", 400);
    if (!["verify", "resolve", "reject"].includes(action)) throw new ApiInputError("不支持的核验动作", 400);
    const disruption = await transitionRoadDisruption(disruptionId, revision, action as "verify" | "resolve" | "reject", apiActor(request), apiRole(request) === "admin");
    return Response.json({ disruption, storage: "operational-database" });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /不存在/.test(error.message)) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof Error && /版本冲突|已被其他请求更新|只有有效记录/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && /只有管理员/.test(error.message)) return Response.json({ error: error.message }, { status: 403 });
    console.error("road disruption review unavailable", error);
    return Response.json({ error: "道路中断核验失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function validIso(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ApiInputError(`${label} 时间无效`, 400);
  return new Date(parsed).toISOString();
}
