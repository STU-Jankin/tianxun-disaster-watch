import { authorizeApiRequest, enforceRateLimit, rejectCrossOriginBrowserWrite } from "../../../lib/api-security";
import { listSatelliteOrbitCache, recordSatelliteOrbitFailure, recordSatelliteOrbitSuccess } from "../../../db/operational";
import { buildSatelliteOrbitSnapshot, fetchTrackedSatelliteTles, trackedSarSatellites } from "../../../lib/satellite-orbits";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  try {
    return Response.json(satellitePayload(await listSatelliteOrbitCache()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("satellite orbit cache unavailable", error);
    return Response.json({ state: "error", satellites: [], message: "卫星轨道缓存暂不可用" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = (await authorizeApiRequest(request, "admin")) ?? rejectCrossOriginBrowserWrite(request);
  if (unauthorized) return unauthorized;
  const limited = enforceRateLimit(request, "satellite-orbit-refresh", 2, 60 * 60_000);
  if (limited) return limited;
  const attemptedAt = new Date();
  const results = await fetchTrackedSatelliteTles(fetch, attemptedAt);
  try {
    for (const result of results) {
      if (result.tle) await recordSatelliteOrbitSuccess(result.tle);
      else await recordSatelliteOrbitFailure(result.satellite.noradId, attemptedAt.toISOString(), result.error ?? "CelesTrak未返回轨道数据");
    }
    const cache = await listSatelliteOrbitCache();
    const success = results.filter((result) => result.tle).length;
    return Response.json({ ...satellitePayload(cache), refresh: { attemptedAt: attemptedAt.toISOString(), success, failed: trackedSarSatellites.length - success } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("satellite orbit refresh persistence unavailable", error);
    return Response.json({ state: "error", satellites: [], message: "轨道刷新结果无法写入业务数据库" }, { status: 503 });
  }
}

function satellitePayload(cache: Awaited<ReturnType<typeof listSatelliteOrbitCache>>) {
  const satellites = buildSatelliteOrbitSnapshot(cache);
  const current = satellites.filter((item) => item.orbitStatus === "current").length;
  const available = satellites.filter((item) => item.orbitStatus !== "unavailable").length;
  return {
    schemaVersion: "tianxun.satellite-orbits/v1",
    state: current === satellites.length ? "ready" : available ? "partial" : "unavailable",
    source: "CelesTrak GP",
    refreshPolicy: "daily",
    computedAt: new Date().toISOString(),
    summary: { configured: satellites.length, current, available },
    satellites,
  };
}
