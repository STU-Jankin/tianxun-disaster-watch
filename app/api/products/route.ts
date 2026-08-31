import { listObservationProducts, upsertObservationProduct } from "../../../db/operational";
import { ApiInputError, apiActor, apiRole, authorizeApiRequest, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { normalizeObservationProductInput } from "../../../lib/stac-products";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request, "viewer");
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const role = await apiRole(request);
    const actor = await apiActor(request);
    const products = await listObservationProducts({
      taskId: boundedQuery(url.searchParams.get("taskId")),
      masterEventId: boundedQuery(url.searchParams.get("masterEventId")),
      limit: Number(url.searchParams.get("limit") ?? 100),
    }, role === "admin" || role === "executor" ? undefined : actor);
    return Response.json({ products, stacVersion: "1.0.0", storage: "operational-database" }, { headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    console.error("observation product read unavailable", error);
    return Response.json({ error: "成像产品目录暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "executor")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "observation-product-write", 120);
  if (limited) return limited;
  try {
    const input = normalizeObservationProductInput(await readJsonObject(request, 256 * 1024));
    const role = await apiRole(request);
    const product = await upsertObservationProduct(input, await apiActor(request), role === "admin" || role === "executor");
    return Response.json({ product, stacVersion: "1.0.0", storage: "operational-database" }, { status: 201, headers: privateHeaders() });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /不存在/.test(error.message)) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof Error && /版本冲突|已被其他|只有已成像/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && /不属于/.test(error.message)) return Response.json({ error: error.message }, { status: 403 });
    if (error instanceof Error && /必须|无效|不能为空|超过|只允许|不得|不能晚于/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    console.error("observation product write unavailable", error);
    return Response.json({ error: "成像产品登记失败", requestId: crypto.randomUUID() }, { status: 503 });
  }
}

function boundedQuery(value: string | null) {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 220 || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new ApiInputError("查询参数无效", 400);
  return normalized || undefined;
}

function privateHeaders() { return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }; }
