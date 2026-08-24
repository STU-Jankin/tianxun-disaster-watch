import { listOperationalChanges } from "../../../db/operational";
import { apiRole, authorizeApiRequest } from "../../../lib/api-security";
import { changesVisibleToViewer } from "../../../lib/operational-change-visibility";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const afterValue = url.searchParams.get("after") ?? "1970-01-01T00:00:00.000Z";
  const separator = afterValue.indexOf("|");
  const timePart = separator >= 0 ? afterValue.slice(0, separator) : afterValue;
  const afterId = separator >= 0 ? afterValue.slice(separator + 1) : "";
  if (afterId.length > 300 || [...afterId].some((character) => character.charCodeAt(0) < 32)) return Response.json({ error: "after 游标无效" }, { status: 400 });
  const after = new Date(timePart);
  if (!Number.isFinite(after.getTime())) return Response.json({ error: "after 必须是有效 ISO 时间" }, { status: 400 });
  try {
    const normalizedAfter = after.toISOString();
    const storedChanges = await listOperationalChanges(normalizedAfter, afterId, Number(url.searchParams.get("limit") ?? 200));
    const changes = await apiRole(request) === "viewer" ? changesVisibleToViewer(storedChanges) : storedChanges;
    const last = changes.at(-1);
    return Response.json({ changes, cursor: last ? `${last.createdAt}|${last.id}` : afterValue }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("operational change stream unavailable", error);
    return Response.json({ error: "变更流暂不可用", requestId: crypto.randomUUID() }, { status: 503 });
  }
}
