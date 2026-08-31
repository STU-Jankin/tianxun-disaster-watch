import { getSourcePayloadPreview, listIngestionSnapshots, listSourceRegistry } from "../../../db/operational";
import { apiRole, authorizeApiRequest } from "../../../lib/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("sourceId")?.trim() || undefined;
  const payloadSha256 = url.searchParams.get("payload")?.trim();
  if (sourceId && !/^source-[a-f0-9]{8}$/.test(sourceId)) return Response.json({ error: "数据源编号无效" }, { status: 400 });
  if (payloadSha256) {
    if (!/^[a-f0-9]{64}$/.test(payloadSha256)) return Response.json({ error: "载荷摘要无效" }, { status: 400 });
    if (await apiRole(request) !== "admin") return Response.json({ error: "只有管理员可以查看脱敏后的原始响应预览" }, { status: 403 });
    const payload = await getSourcePayloadPreview(payloadSha256);
    return payload ? Response.json({ payload }, { headers: privateHeaders() }) : Response.json({ error: "原始响应已过保留期或不存在" }, { status: 404 });
  }
  const [{ sources, runs }, snapshots] = await Promise.all([
    listSourceRegistry(sourceId),
    listIngestionSnapshots(24),
  ]);
  return Response.json({ sources, runs, snapshots, retention: { rawFetchDays: 30, replayDays: 90, payloadPreviewBytes: 131_072 } }, { headers: privateHeaders() });
}

function privateHeaders() {
  return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
}
