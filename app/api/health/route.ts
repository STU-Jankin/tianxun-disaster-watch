import { operationalHealth } from "../../../db/operational";
import { getIngestionHealth } from "../../../lib/runtime-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [database, ingestion] = await Promise.all([operationalHealth(), Promise.resolve(getIngestionHealth())]);
    const stale = !ingestion.lastSuccessAt || Date.now() - Date.parse(ingestion.lastSuccessAt) > 15 * 60_000;
    const noEventSource = ingestion.configuredSources > 0 && ingestion.eventCapableSources === 0;
    const degraded = stale || noEventSource || !ingestion.persistenceAvailable;
    return Response.json(
      { status: degraded ? "degraded" : "ok", database, ingestion: { ...ingestion, stale, noEventSource } },
      { status: degraded ? 503 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("readiness check failed", error);
    return Response.json({ status: "unavailable", database: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
