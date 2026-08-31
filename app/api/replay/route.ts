import { getIngestionSnapshot } from "../../../db/operational";
import { authorizeApiRequest } from "../../../lib/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  const rawAsOf = new URL(request.url).searchParams.get("asOf")?.trim();
  const asOfMs = rawAsOf ? Date.parse(rawAsOf) : Date.now();
  if (!Number.isFinite(asOfMs)) return Response.json({ error: "历史时刻格式无效" }, { status: 400 });
  if (asOfMs > Date.now() + 60_000) return Response.json({ error: "历史时刻不能晚于当前时间" }, { status: 400 });
  const snapshot = await getIngestionSnapshot(new Date(asOfMs).toISOString());
  if (!snapshot) return Response.json({ error: "所选时刻之前尚无可重演快照" }, { status: 404 });
  return Response.json({
    ...snapshot.payload,
    runtimeMode: "历史重演",
    replay: {
      readOnly: true,
      requestedAsOf: new Date(asOfMs).toISOString(),
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      eventCount: snapshot.eventCount,
    },
  }, { headers: { "Cache-Control": "private, no-store", "X-Tianxun-Mode": "historical-replay" } });
}
