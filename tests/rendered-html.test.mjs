import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const loginPassword = "Tianxun-Render-Test-2026";
const loginSalt = "12".repeat(16);
process.env.TIANXUN_SQLITE_PATH = join(await mkdtemp(join(tmpdir(), "tianxun-render-")), "operational.sqlite");
process.env.TIANXUN_LOGIN_USERNAME = "render-admin";
process.env.TIANXUN_LOGIN_PASSWORD_HASH = `pbkdf2-sha256$600000$${loginSalt}$${pbkdf2Sync(loginPassword, Buffer.from(loginSalt, "hex"), 600_000, 32, "sha256").toString("hex")}`;
process.env.TIANXUN_LOGIN_ROLE = "admin";

async function render(path = "/", authenticated = true) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const context = { waitUntil() {}, passThroughOnException() {} };
  let cookie = "";
  if (authenticated) {
    const login = await worker.fetch(
      new Request("https://localhost/api/auth/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", origin: "https://localhost" }, body: JSON.stringify({ username: "render-admin", password: loginPassword }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      context,
    );
    assert.equal(login.status, 200);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  }
  return worker.fetch(
    new Request(`https://localhost${path}`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    context,
  );
}

test("requires a server-side login before rendering the operations dashboard", async () => {
  const response = await render("/", false);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /登录天巡系统/);
  assert.match(html, /全球灾害监测与卫星任务规划/);
  assert.match(html, /登录并进入系统/);
  assert.match(html, /显示密码/);
  assert.doesNotMatch(html, /SECURE OPERATIONS CONSOLE|HttpOnly 会话|生产环境必须使用 HTTPS/);
  assert.doesNotMatch(html, /个可观测事件/);
});

test("server-renders the disaster watch dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /星联体·天巡灾情实时预报系统/);
  assert.match(html, /satellite-union-mark\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("includes the four observation scopes in the client bundle", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /无锡市/);
  assert.match(html, /江苏省/);
  assert.match(html, /中国/);
  assert.match(html, /全球/);
});

test("includes satellite task planning and export controls", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /任务候选/);
});

test("includes typed AOI, payload options, and expanded source connectors", async () => {
  const dashboard = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"));
  const route = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8"));
  for (const text of ["点目标", "圆形面", "矩形面", "线状走廊", "发生时间", "载荷类型（可多选）", "SAR 成像方式（可多选）"]) assert.ok(dashboard.includes(text));
  assert.match(dashboard, /const payloadOptions = \["光学", "SAR"\]/);
  assert.match(dashboard, /sarImagingModes/);
  for (const source of ["NASA FIRMS", "WMO SWIC/CAP", "Copernicus GloFAS", "USGS HANS", "Smithsonian GVP", "NASA LHASA", "OCHA ReliefWeb", "应急管理部地质灾害快报"]) assert.ok(route.includes(source));
  assert.match(route, /needs_config/);
});

test("exposes source governance, read-only replay, and three separate decision layers", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const eventsRoute = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const phrase of ["历史重演", "只读重演", "官方告警等级", "影响风险", "卫星观测优先级", "更新语义", "几何语义"]) assert.ok(dashboard.includes(phrase));
  assert.match(eventsRoute, /boundedReplayPayload/);
  assert.match(eventsRoute, /assessImpactRisk/);
  for (const table of ["source_registry", "source_payloads", "source_fetch_runs", "ingestion_snapshots"]) assert.ok(schema.includes(table));
});

test("keeps the demonstration workflow free of operator duty-review controls", async () => {
  const { readFile, access } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const eventsRoute = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /值守研判|保存研判新版本|确认收到/);
  assert.doesNotMatch(eventsRoute, /listEventReviews|summarizeEventReview/);
  await assert.rejects(() => access(new URL("../app/api/reviews/route.ts", import.meta.url)));
});

test("closes the satellite mission loop with execution receipts, STAC products, and independent AOI review", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const executionRoute = await readFile(new URL("../app/api/execution/receipts/route.ts", import.meta.url), "utf8");
  const productRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  const workRoute = await readFile(new URL("../app/api/aoi-work-packages/route.ts", import.meta.url), "utf8");
  for (const phrase of ["任务闭环与覆盖复核", "执行回执", "STAC 产品", "领取人与复核人必须是不同账号", "按场景网格生成"]) assert.ok(dashboard.includes(phrase));
  for (const table of ["mission_execution_receipts", "observation_products", "aoi_work_packages", "aoi_work_package_history"]) assert.ok(schema.includes(table));
  assert.match(executionRoute, /authorizeApiRequest\(request, "executor"\)/);
  assert.match(productRoute, /stacVersion: "1\.0\.0"/);
  assert.match(workRoute, /separationOfDuties/);
});

test("adds a bounded and evidence-labelled population and infrastructure exposure workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/exposure/route.ts", import.meta.url), "utf8");
  const model = await readFile(new URL("../lib/exposure-assessment.ts", import.meta.url), "utf8");
  for (const phrase of ["人口与承灾体暴露", "范围内模型人口", "人口指数已生成", "已映射建筑", "已映射道路", "关键设施", "计算暴露度并叠加地图", "不是受损建筑数", "不代表里程或通行状态"]) assert.ok(dashboard.includes(phrase));
  for (const contract of ["authorizeApiRequest", "rejectCrossOriginBrowserWrite", "enforceRateLimit", "getCanonicalEventForTask", "upsertEventExposureAssessment", "boundedFetch"]) assert.ok(route.includes(contract));
  for (const guardrail of ["maximumWorldPopAreaKm2", "maximumOverpassAreaKm2", "derived_screening_buffer", "本指数仅含人口暴露"]) assert.ok(model.includes(guardrail));
});

test("includes both domestic connector batches and only filters base-map tiles", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const source of ["中国地震台网", "太湖流域管理局", "江苏省水利厅", "中国气象数据网 CMA"]) assert.ok(route.includes(source));
  for (const tier of ["中国第一批", "中国第二批"]) assert.ok(dashboard.includes(tier));
  assert.match(css, /\.leaflet-map\s*\.leaflet-tile-pane\s*\{[^}]*filter:/s);
  assert.doesNotMatch(css, /\.leaflet-map\s*\{[^}]*filter:/s);
});

test("keeps the data-source popover above every Leaflet pane", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.control-strip\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*20;/s);
  assert.match(css, /\.workspace\s*\{[^}]*z-index:\s*0;[^}]*isolation:\s*isolate;/s);
  assert.match(css, /\.map-stage\s*\{[^}]*z-index:\s*0;[^}]*isolation:\s*isolate;/s);
  assert.match(css, /\.event-panel\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*10;/s);
  assert.match(css, /\.map-title\s*\{[^}]*z-index:\s*900;/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.source-status-popover\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1000;/s);
});

test("keeps the cyclone 4D timeline to the right of the observation title and responsive around detail panels", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.cyclone-timeline\s*\{[^}]*left:\s*225px;[^}]*top:\s*20px;/s);
  assert.match(css, /\.workspace:has\(\.detail-panel\)\s+\.cyclone-timeline\s*\{[^}]*calc\(100% - 585px\)/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.cyclone-timeline,[^{]*\.event-panel\.closed[^{]*\{[^}]*top:\s*112px;[^}]*min-width:\s*0;/s);
});

test("separates expired cyclone forecast AOIs from post-event observation tasks", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const taskRoute = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  const contract = await readFile(new URL("../lib/task-contract.ts", import.meta.url), "utf8");
  assert.match(dashboard, /const cycloneForecastUsable = !event\.cycloneForecast/);
  assert.match(dashboard, /官方台风报次已不足一小时，不再作为预测 AOI/);
  assert.match(dashboard, /cycloneForecastUsable \? event\.cycloneForecast\?\.impactGeometry : undefined/);
  assert.match(taskRoute, /task\.aoiType === "source"/);
  assert.match(contract, /forecast\?\.impactField !== undefined && task\.aoiType === "source"/);
});

test("uses a white and blue command-center color system", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--paper:\s*#edf5fc;/);
  assert.match(css, /--panel:\s*#ffffff;/);
  assert.match(css, /--teal:\s*#0868be;/);
  assert.match(css, /Blue-white command-center theme/);
  assert.match(css, /\.brand-logo-frame\s*\{[^}]*background:\s*#fff url\("\/satellite-union-logo\.png"\) center \/ contain no-repeat;/s);
});

test("keeps map selection resilient while event geometry is being refreshed", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /selected\.geometry && selected\.geometry\.type !== "Point"/);
  assert.doesNotMatch(dashboard, /if \(selected\.geometry\.type !== "Point"/);
  assert.doesNotMatch(dashboard, /\|\| selected\.geometry\.type !== "Point"/);
});

test("includes free official tsunami, typhoon, CAP and volcano-status connectors", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const disasters = await readFile(new URL("../lib/disasters.ts", import.meta.url), "utf8");
  for (const source of ["NOAA NTWC 海啸", "NOAA PTWC 海啸", "日本气象厅 JMA 台风", "WMO Alert Hub · 中国", "GeoNet 火山警戒"]) assert.ok(route.includes(source));
  assert.match(route, /selectBalancedEvents/);
  assert.match(route, /information statement\|cancell\?ation/);
  assert.match(disasters, /tsunami: \{ goldenHours: 24, followupHours: 336, hardReviewHours: 720/);
  assert.match(disasters, /PhenomenonStage = "observed" \| "forecast" \| "warning"/);
});

test("models canonical events, evidence provenance and AOI dispatch gates", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(route, /canonicalizeEvents/);
  assert.match(route, /mergePolicy/);
  assert.match(route, /isSamePhysicalEvent/);
  for (const field of ["masterEventId", "evidenceCount", "confidenceScore", "locationQuality", "dispatchEligibility"]) assert.ok(route.includes(field));
  assert.match(dashboard, /保存为候选草稿/);
  assert.match(dashboard, /AOI 待复核/);
  assert.match(dashboard, /计算卫星任务机会/);
  for (const table of ["canonical_events", "event_evidence", "satellite_tasks", "task_status_history"]) assert.ok(schema.includes(table));
});

test("uses configured assumed-SAR geometry and retains an explicit TLE-only fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/visibility/route.ts", import.meta.url), "utf8");
  assert.match(route, /SATELLITE_VISIBILITY_API_URL/);
  assert.match(route, /screenConfiguredSarOpportunities/);
  assert.match(route, /mode: "assumed_sensor"/);
  assert.match(route, /screenTleOpportunities/);
  assert.match(route, /mode: "orbit_only"/);
  assert.match(route, /windows/);
  assert.doesNotMatch(route, /mock|fake|demo window/i);
});

test("adds a daily cached CelesTrak orbit catalog without exposing refresh writes publicly", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/satellites/route.ts", import.meta.url), "utf8");
  const catalog = await readFile(new URL("../lib/satellite-orbits.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const nginx = await readFile(new URL("../vps/nginx/tianxun-public-readonly.conf", import.meta.url), "utf8");
  const timer = await readFile(new URL("../vps/systemd/tianxun-orbit-refresh.timer", import.meta.url), "utf8");
  for (const id of [51832, 56846, 61231, 64048, 69100, 58918]) assert.ok(catalog.includes(String(id)));
  assert.match(route, /fetchTrackedSatelliteTles/);
  assert.match(route, /recordSatelliteOrbitFailure/);
  assert.match(dashboard, /SAR仿真轨道/);
  assert.match(dashboard, /显示卫星轨道/);
  assert.match(dashboard, /TLE\/SGP4 外推/);
  assert.match(nginx, /application validates the HttpOnly session cookie/);
  assert.match(nginx, /location \/api\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.match(timer, /OnCalendar=\*-\*-\* 02:35:00 UTC/);
  assert.match(timer, /Persistent=true/);
});

test("syncs a compact task draft and lets the server rebuild canonical 4D products", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const sync = await readFile(new URL("../lib/task-sync.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  assert.match(dashboard, /compactSatelliteTaskForSync/);
  assert.doesNotMatch(dashboard, /JSON\.stringify\(\{ \.\.\.task, aoi:/);
  const draftAllowlist = sync.match(/taskDraftFields\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "";
  for (const canonical of ["sourceGeometry", "cycloneForecast", "timeIndexedAoi", "trackingValidFrom", "trackingCenterLatitude"]) assert.doesNotMatch(draftAllowlist, new RegExp(`"${canonical}"`));
  assert.match(route, /readJsonObject\(request, 256 \* 1024\)/);
  assert.match(route, /const timeIndexedAoi = cycloneTaskAoiSlices/);
  assert.match(route, /timeIndexedAoi: timeIndexedAoi\.length \? timeIndexedAoi : undefined/);
});

test("computes cyclone visibility against the forecast slice valid at each satellite pass", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const visibilityRoute = await readFile(new URL("../app/api/visibility/route.ts", import.meta.url), "utf8");
  const tracking = await readFile(new URL("../lib/cyclone-tracking-opportunities.ts", import.meta.url), "utf8");
  assert.match(dashboard, /台风动态跟踪目标/);
  assert.match(dashboard, /计算台风动态跟踪机会/);
  assert.match(dashboard, /拍摄时刻台风/);
  assert.match(dashboard, /选择并在地图查看/);
  assert.match(dashboard, /cycloneTrackingSliceAt\(activeTask\.timeIndexedAoi, activeTask\.closestApproachAt\)/);
  assert.match(dashboard, /onActivate\(task\.taskId\)/);
  assert.match(dashboard, /任务 4D 预测路径/);
  assert.match(dashboard, /回到拍摄时刻/);
  assert.match(dashboard, /拖动仅浏览预测，不改变已选卫星机会/);
  assert.match(dashboard, /taskForecastLayerRef/);
  assert.match(visibilityRoute, /screenCycloneConfiguredSarOpportunities/);
  assert.match(visibilityRoute, /screenCycloneTleOpportunities/);
  assert.match(tracking, /按卫星过境时刻匹配台风/);
  assert.match(tracking, /cycloneTrackingSliceAt/);
});

test("keeps satellite simulation results mounted while previewing opportunities", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(dashboard, /<TaskPanel open=\{taskPanelOpen\}/);
  assert.doesNotMatch(dashboard, /\{taskPanelOpen && <TaskPanel/);
  assert.match(dashboard, /hidden=\{!open\} inert=\{!open \? true : undefined\}/);
  assert.match(dashboard, /if \(window\.matchMedia\("\(max-width: 1050px\)"\)\.matches\) \{\s*setTaskPanelOpen\(false\)/);
  assert.match(styles, /\.task-panel\[hidden\] \{ display: none; \}/);
});

test("returns persisted canonical identities and heals stale local draft references conservatively", async () => {
  const { readFile } = await import("node:fs/promises");
  const eventsRoute = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const taskRoute = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  const operational = await readFile(new URL("../db/operational.ts", import.meta.url), "utf8");
  assert.match(eventsRoute, /\(persistedEvents \?\? normalizedWithPresence\)\.map/);
  assert.match(eventsRoute, /applyEventSourcePresence/);
  assert.match(taskRoute, /entityKey: typeof task\.entityKey/);
  assert.match(operational, /matches\.length === 1/);
  assert.match(operational, /candidate\.event\.evidence\.some/);
});

test("aggregates continuing named hazards into one process with update history", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  assert.match(route, /processEntityKey/);
  assert.match(route, /sameNamedProcess/);
  assert.match(route, /第\\s\*0\?\(\\d\{1,2\}\)\\s\*号台风/);
  assert.match(route, /updateHistory/);
  assert.match(route, /updateCount/);
  assert.match(dashboard, /过程更新 · 共/);
  assert.match(dashboard, /期更新/);
});

test("implements stale-data, map resize, AOI preview and server task gates", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const taskRoute = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  const eventRoute = await readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8");
  assert.match(dashboard, /ResizeObserver/);
  assert.match(dashboard, /invalidateSize/);
  assert.match(dashboard, /数据更新异常/);
  assert.match(dashboard, /aoiLayerRef/);
  assert.match(dashboard, /geo-cluster/);
  assert.match(dashboard, /aria-modal=\{compact \? "true"/);
  assert.match(dashboard, /obscured=\{mapObscured\}/);
  assert.match(dashboard, /高优先事件/);
  assert.match(dashboard, /重试解析/);
  assert.match(taskRoute, /validateSatelliteTask/);
  assert.match(taskRoute, /authorizeApiRequest/);
  assert.match(eventRoute, /recordCapCancellations/);
  assert.match(eventRoute, /confidenceCode/);
  assert.match(eventRoute, /aoiApprovalRequired: location\.aoiApprovalRequired/);
  assert.match(eventRoute, /dispatchEligibility: location\.dispatchEligibility/);
  assert.match(eventRoute, /windKt/);
  assert.match(eventRoute, /parseNhcTrackKml/);
  assert.match(eventRoute, /buildJmaCycloneForecast/);
  assert.match(dashboard, /官方台风预报/);
  assert.match(dashboard, /cyclone-forecast-track/);
  assert.match(dashboard, /台风官方路径\/风圈/);
  assert.match(eventRoute, /authorizeApiRequest/);
});

test("adds a bounded phase-three response simulation, disruption review and infrastructure screening workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const routing = await readFile(new URL("../lib/response-routing.ts", import.meta.url), "utf8");
  const disruptionApi = await readFile(new URL("../app/api/road-disruptions/route.ts", import.meta.url), "utf8");
  const infrastructureApi = await readFile(new URL("../app/api/infrastructure/route.ts", import.meta.url), "utf8");
  const infrastructure = await readFile(new URL("../lib/osm-infrastructure.ts", import.meta.url), "utf8");
  const overpassRuntime = await readFile(new URL("../lib/overpass-runtime.ts", import.meta.url), "utf8");
  const operational = await readFile(new URL("../db/operational.ts", import.meta.url), "utf8");
  assert.match(dashboard, /建立处置推演场景/);
  assert.match(dashboard, /真实路网、道路中断与基础设施复核/);
  assert.match(dashboard, /生成真实道路候选/);
  assert.match(dashboard, /真实路网不可用时：直线敏感性估算/);
  assert.match(dashboard, /耗时采用高德返回值，不读取直线估算速度/);
  assert.doesNotMatch(dashboard, /几何降级速度/);
  const realRoadBlock = dashboard.match(/const generateRoad = async[\s\S]*?const importRoadDisruptions/)?.[0] ?? "";
  assert.doesNotMatch(realRoadBlock, /fallbackSpeed|planResponseScenario/);
  assert.match(dashboard, /设施结构状态：未核验/);
  assert.match(dashboard, /OSM 设施暴露/);
  assert.match(dashboard, /道路毁损与封闭/);
  assert.match(dashboard, /电动自行车/);
  assert.match(dashboard, /导出 GeoJSON/);
  assert.match(dashboard, /responseLayerRef/);
  assert.match(dashboard, /setActiveResponseScenarioId\(null\);\s*setSelected\(event\)/);
  assert.match(routing, /geometric_preview_v1/);
  assert.match(routing, /amap_driving_v1/);
  assert.match(routing, /超出4D影响场有效期/);
  assert.match(routing, /禁止作为可用路线/);
  assert.match(disruptionApi, /authorizeApiRequest\(request, "admin"\)/);
  assert.match(disruptionApi, /default_24h/);
  assert.match(infrastructureApi, /authorizeApiRequest\(request, "operator"\)/);
  assert.match(infrastructureApi, /queryTimeoutSeconds \+ 5/);
  assert.match(overpassRuntime, /queryTimeoutSeconds: number/);
  assert.match(overpassRuntime, /OVERPASS_PROFILE/);
  assert.match(infrastructure, /maximumBboxAreaKm2 = 2_500/);
  assert.match(infrastructure, /不代表设施当前完好/);
  assert.match(operational, /CREATE TABLE IF NOT EXISTS road_disruptions/);
  assert.match(operational, /road_disruption_history/);
});

test("keeps the authenticated Nginx gateway bounded without synthetic browser roles", async () => {
  const { readFile } = await import("node:fs/promises");
  const nginx = await readFile(new URL("../vps/nginx/tianxun-public-readonly.conf", import.meta.url), "utf8");
  const proxyCommon = await readFile(new URL("../vps/nginx/tianxun-proxy-common.conf", import.meta.url), "utf8");
  const ipHttpsInstaller = await readFile(new URL("../vps/scripts/configure-ip-https.sh", import.meta.url), "utf8");
  const visibilityRoute = await readFile(new URL("../app/api/visibility/route.ts", import.meta.url), "utf8");
  assert.match(nginx, /listen 80 default_server/);
  assert.match(nginx, /tianxun_login:10m rate=5r\/m/);
  assert.match(nginx, /location = \/api\/auth\/login[\s\S]*client_max_body_size 8k[\s\S]*limit_req zone=tianxun_login/);
  assert.match(nginx, /location = \/api\/health\/live/);
  assert.match(nginx, /location \/api\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(nginx, /tianxun-proxy-secret\.conf|X-Tianxun-Role|X-Tianxun-Stateless-Visibility|public-read-only/);
  assert.match(proxyCommon, /proxy_set_header Host \$host:\$server_port/);
  assert.match(proxyCommon, /proxy_set_header X-Forwarded-Host \$host:\$server_port/);
  assert.match(proxyCommon, /proxy_set_header X-Forwarded-Port \$server_port/);
  assert.match(ipHttpsInstaller, /proxy_common_source=.*tianxun-proxy-common\.conf/);
  assert.match(ipHttpsInstaller, /install -o root -g root -m 0644 "\$proxy_common_source" "\$proxy_common_target"/);
  assert.match(visibilityRoute, /statelessPublicTrial/);
  assert.doesNotMatch(nginx, /listen\s+(?:127\.0\.0\.1:)?(?:3000|8644)/);
});

test("adds an authenticated compute-only multi-task scheduling baseline", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const scheduleRoute = await readFile(new URL("../app/api/planning/schedule/route.ts", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../lib/mission-scheduler.ts", import.meta.url), "utf8");
  assert.match(dashboard, /多任务联合试排/);
  assert.match(dashboard, /比较优先级贪心与有界约束搜索/);
  assert.match(dashboard, /不改任务状态、不自动下发/);
  assert.match(scheduleRoute, /authorizeApiRequest\(request, "operator"\)/);
  assert.match(scheduleRoute, /rejectCrossOriginBrowserWrite\(request\)/);
  assert.match(scheduleRoute, /readJsonObject\(request, 512 \* 1024\)/);
  assert.doesNotMatch(scheduleRoute, /putSatelliteTask|updateSatelliteTask|insert|delete/i);
  assert.match(scheduler, /priority_greedy_v1/);
  assert.match(scheduler, /bounded_constraint_search_v1/);
  assert.match(scheduler, /同一卫星相邻任务暂按/);
  assert.match(scheduler, /条件机会不得据此自动下发/);
  const nginx = await readFile(new URL("../vps/nginx/tianxun-public-readonly.conf", import.meta.url), "utf8");
  assert.match(nginx, /location ~ \^\/api\/planning\/\(\?:schedule\|scenarios\)\$[\s\S]*client_max_body_size 512k[\s\S]*burst=4/);
});

test("adds a versioned planning workbench without turning simulations into task execution", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../lib/mission-scheduler.ts", import.meta.url), "utf8");
  const scenarios = await readFile(new URL("../app/api/planning/scenarios/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0004_planning_scenarios.sql", import.meta.url), "utf8");
  for (const text of ["卫星时间轴", "人工规则", "锁定机会", "排除机会", "保存为新版本", "恢复此版本", "对比所选版本", "导出当前方案 JSON"]) assert.ok(dashboard.includes(text));
  assert.match(dashboard, /ScheduleTimeline/);
  assert.match(dashboard, /PlanningScenarioDiff/);
  assert.match(scheduler, /lockedOpportunityRefs/);
  assert.match(scheduler, /forcedSatelliteByTask/);
  assert.match(scheduler, /forcedImagingModeByTask/);
  assert.match(scenarios, /authorizeApiRequest\(request, "operator"\)/);
  assert.match(scenarios, /rejectCrossOriginBrowserWrite\(request\)/);
  assert.match(scenarios, /status: 201/);
  assert.doesNotMatch(scenarios, /export async function (?:PATCH|DELETE)/);
  assert.match(schema, /planning_scenarios/);
  assert.match(migration, /CREATE UNIQUE INDEX `planning_scenarios_series_version_uidx`/);
});

test("implements a server-side login, revocable sessions and password-hash configuration", async () => {
  const { readFile } = await import("node:fs/promises");
  const auth = await readFile(new URL("../lib/web-auth.ts", import.meta.url), "utf8");
  const operational = await readFile(new URL("../db/operational.ts", import.meta.url), "utf8");
  const login = await readFile(new URL("../app/authenticated-app.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const loginRoute = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(auth, /pbkdf2-sha256/);
  assert.match(auth, /HttpOnly; SameSite=Strict/);
  assert.match(auth, /secureLoginTransportRequired/);
  assert.match(operational, /CREATE TABLE IF NOT EXISTS web_sessions/);
  assert.match(operational, /DELETE FROM web_sessions WHERE session_hash/);
  assert.match(login, /登录天巡系统/);
  assert.match(login, /aria-invalid/);
  assert.match(login, /login-caps-lock/);
  assert.match(login, /Retry-After/);
  assert.doesNotMatch(login, /稍后后重试/);
  assert.match(dashboard, /安全退出/);
  assert.match(loginRoute, /enforceRateLimit\(request, `web-login:\$\{username/);
  assert.match(login, /api\/auth\/session/);
});

test("keeps the login form reachable on tablets and short mobile viewports", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.login-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-width: 900px\)\s*\{[\s\S]*?\.login-shell\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.topbar \.brand-logo-frame\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /@media \(max-width: 360px\)[\s\S]*?\n\s*\.brand-logo-frame\s*\{\s*display:\s*none/);
});

test("includes every Vinext build dependency in the hardened VPS release allow-list", async () => {
  const { readFile } = await import("node:fs/promises");
  const installer = await readFile(new URL("../vps/scripts/install.sh", import.meta.url), "utf8");
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(viteConfig, /\.\/\.openai\/hosting\.json/);
  assert.match(viteConfig, /\.\/build\/sites-vite-plugin\.ts/);
  assert.match(viteConfig, /main: "\.\/worker\/index\.ts"/);
  assert.match(installer, /for directory in \.openai app build db drizzle lib public tests types vps worker/);
  assert.match(installer, /npm_config_cache=.*"\$npm_bin" run verify/);
});

test("adds evidence-safe landslide terrain screening and complementary SAR task templates", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const terrainApi = await readFile(new URL("../app/api/landslide-terrain/route.ts", import.meta.url), "utf8");
  const planning = await readFile(new URL("../lib/landslide-planning.ts", import.meta.url), "utf8");
  assert.match(dashboard, /证据状态/);
  assert.match(dashboard, /生成地形约束 AOI/);
  assert.match(dashboard, /建立升轨 \+ 降轨 SAR 任务/);
  assert.match(dashboard, /不是滑坡或泥石流实况边界/);
  assert.match(terrainApi, /authorizeApiRequest\(request, "operator"\)/);
  assert.match(terrainApi, /plan\.points\.map/);
  assert.match(planning, /gridSize = 7/);
  assert.match(planning, /不代表滑坡概率/);
});

test("adds on-demand hourly weather to event details and satellite tasks", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const text of ["逐小时天气 · 全球预报", "光学气象窗口", "加载该 AOI 天气", "SAR不受云层遮挡", "forecast.provider"]) assert.ok(dashboard.includes(text));
  assert.match(dashboard, /weatherImagingWindows/);
  assert.match(css, /\.weather-card/);
});
