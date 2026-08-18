import assert from "node:assert/strict";
import test from "node:test";

async function cmaSurface() {
  return import(new URL("../lib/cma-surface.ts", import.meta.url));
}

test("CMA legacy HTTP endpoint requires an explicit insecure transport opt-in", async () => {
  const { cmaSurfaceConfiguration } = await cmaSurface();
  const blocked = cmaSurfaceConfiguration({ CMA_SURFACE_USER_ID: "test-user", CMA_SURFACE_PASSWORD: "test-password" });
  assert.equal(blocked.ready, false);
  assert.match(blocked.message, /明文HTTP|HTTPS网关/);
  assert.doesNotMatch(blocked.message, /test-user|test-password/);

  const allowed = cmaSurfaceConfiguration({
    CMA_SURFACE_USER_ID: "test-user",
    CMA_SURFACE_PASSWORD: "test-password",
    CMA_SURFACE_ALLOW_INSECURE_HTTP: "true",
  });
  assert.equal(allowed.ready, true);
  assert.deepEqual(allowed.config?.stationIds, ["58354", "58346", "58351", "58349"]);
});

test("CMA request builder encodes the documented interface without leaking credentials into public evidence", async () => {
  const { buildCmaSurfaceRequestUrl, cmaSurfaceConfiguration, CMA_SURFACE_PUBLIC_URL } = await cmaSurface();
  const result = cmaSurfaceConfiguration({
    CMA_SURFACE_USER_ID: "synthetic-user",
    CMA_SURFACE_PASSWORD: "synthetic-password",
    CMA_SURFACE_API_URL: "https://example.com/cma-api",
    CMA_SURFACE_STATION_IDS: "58354",
  });
  assert.ok(result.config);
  const requestUrl = new URL(buildCmaSurfaceRequestUrl(result.config, new Date("2026-08-18T00:00:00Z")));
  assert.equal(requestUrl.searchParams.get("interfaceId"), "getSurfEleByTimeRangeAndStaID");
  assert.equal(requestUrl.searchParams.get("dataCode"), "SURF_CHN_MUL_HOR_3H");
  assert.equal(requestUrl.searchParams.get("staIDs"), "58354");
  assert.equal(CMA_SURFACE_PUBLIC_URL, "https://data.cma.cn/");
});

test("CMA observations create delayed verification candidates only for conservative rain and gale thresholds", async () => {
  const { parseCmaSurfacePayload } = await cmaSurface();
  const candidates = parseCmaSurfacePayload({
    returnCode: "0",
    DS: [{ Station_Id_C: "58354", Year: 2026, Mon: 8, Day: 16, Hour: 12, PRE_3h: 25.4, WIN_S_Inst_Max: 18.1 }],
  }, "UTC");
  assert.equal(candidates.length, 2);
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.hazard)), new Set(["flood", "cyclone"]));
  assert.ok(candidates.every((candidate) => candidate.country.includes("无锡")));
  assert.ok(candidates.every((candidate) => candidate.occurredAt === "2026-08-16T12:00:00.000Z"));
  assert.ok(candidates.every((candidate) => /核验|不.*独立任务|不.*任务/.test(candidate.description)));

  const missing = parseCmaSurfacePayload({
    returnCode: 0,
    DS: [{ Station_Id_C: "58354", Year: 2026, Mon: 8, Day: 16, Hour: 12, PRE_3h: 999999, WIN_S_Inst_Max: 999999 }],
  });
  assert.deepEqual(missing, []);
});

test("CMA parser applies the configured source time zone and redacts query credentials", async () => {
  const { parseCmaSurfacePayload, redactCmaSecret } = await cmaSurface();
  const [candidate] = parseCmaSurfacePayload({
    returnCode: 0,
    DS: [{ Station_Id_C: "58354", Year: 2026, Mon: 8, Day: 16, Hour: 12, PRE_3h: 21 }],
  }, "Asia/Shanghai");
  assert.equal(candidate.occurredAt, "2026-08-16T04:00:00.000Z");
  assert.equal(redactCmaSecret("http://host/api?userId=alice&pwd=secret&x=1"), "http://host/api?userId=[REDACTED]&pwd=[REDACTED]&x=1");
});
