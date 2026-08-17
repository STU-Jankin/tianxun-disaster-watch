import { operationalHealth } from "../../../db/operational";
import { getIngestionHealth } from "../../../lib/runtime-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [database, ingestion] = await Promise.all([operationalHealth(), Promise.resolve(getIngestionHealth())]);
    const stale = !ingestion.lastSuccessAt || Date.now() - Date.parse(ingestion.lastSuccessAt) > 15 * 60_000;
    const degraded = stale || !ingestion.persistenceAvailable;
    return Response.json({ status: degraded ? "degraded" : "ok", database, ingestion: { ...ingestion, stale } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("readiness check failed", error);
    return Response.json({ status: "unavailable", database: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
