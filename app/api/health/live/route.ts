export const dynamic = "force-dynamic";

// Liveness deliberately does not inspect upstream feeds or the database. It
// answers only whether the web process can serve requests; readiness remains
// /api/health and returns 503 while ingestion is stale or persistence is down.
export async function GET() {
  return Response.json({ status: "alive", at: new Date().toISOString() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
