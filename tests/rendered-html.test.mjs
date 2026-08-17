import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the disaster watch dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /星联体·天巡灾情实时预报系统/);
  assert.match(html, /satellite-union-logo\.png/);
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
  for (const text of ["点目标", "圆形面", "矩形面", "线状走廊", "发生时间", "载荷选项（可多选）"]) assert.ok(dashboard.includes(text));
  for (const source of ["NASA FIRMS", "WMO SWIC/CAP", "Copernicus GloFAS", "USGS HANS", "Smithsonian GVP", "NASA LHASA", "OCHA ReliefWeb"]) assert.ok(route.includes(source));
  assert.match(route, /needs_config/);
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
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.cyclone-timeline,[^{]*\.event-panel\.closed[^{]*\{[^}]*top:\s*84px;[^}]*min-width:\s*0;/s);
});

test("uses a white and blue command-center color system", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--paper:\s*#edf5fc;/);
  assert.match(css, /--panel:\s*#ffffff;/);
  assert.match(css, /--teal:\s*#0868be;/);
  assert.match(css, /Blue-white command-center theme/);
  assert.match(css, /\.brand-logo-frame\s*\{[^}]*background:\s*#fff url\("\/satellite-union-logo\.png"\)/s);
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
  assert.match(disasters, /tsunami: \{ goldenHours: 72, followupHours: 720/);
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
  assert.match(dashboard, /需先人工核对 AOI/);
  assert.match(dashboard, /计算卫星可见窗口/);
  for (const table of ["canonical_events", "event_evidence", "satellite_tasks", "task_status_history"]) assert.ok(schema.includes(table));
});

test("keeps satellite visibility integration explicit when simulation is not configured", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/visibility/route.ts", import.meta.url), "utf8");
  assert.match(route, /SATELLITE_VISIBILITY_API_URL/);
  assert.match(route, /needs_config/);
  assert.match(route, /windows/);
  assert.doesNotMatch(route, /mock|fake|demo window/i);
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
  assert.match(dashboard, /aria-modal="true"/);
  assert.match(dashboard, /inert=\{taskPanelOpen/);
  assert.match(dashboard, /高优先事件/);
  assert.match(dashboard, /重试解析/);
  assert.match(taskRoute, /validateSatelliteTask/);
  assert.match(taskRoute, /authorizeApiRequest/);
  assert.match(eventRoute, /recordCapCancellations/);
  assert.match(eventRoute, /confidenceCode/);
  assert.match(eventRoute, /windKt/);
  assert.match(eventRoute, /parseNhcTrackKml/);
  assert.match(eventRoute, /buildJmaCycloneForecast/);
  assert.match(dashboard, /官方台风预报/);
  assert.match(dashboard, /cyclone-forecast-track/);
  assert.match(dashboard, /台风官方路径\/风圈/);
  assert.match(eventRoute, /authorizeApiRequest/);
});

test("keeps the public Nginx trial read-only and leaves internal services unexposed", async () => {
  const { readFile } = await import("node:fs/promises");
  const nginx = await readFile(new URL("../vps/nginx/tianxun-public-readonly.conf", import.meta.url), "utf8");
  assert.match(nginx, /listen 80 default_server/);
  assert.equal(nginx.match(/tianxun-proxy-secret\.conf/g)?.length, 3);
  assert.match(nginx, /location = \/api\/tasks[\s\S]*public-read-only[\s\S]*return 403/);
  assert.match(nginx, /location ~ \^\/api\/\(changes\|visibility\)[\s\S]*return 403/);
  assert.doesNotMatch(nginx, /listen\s+(?:127\.0\.0\.1:)?(?:3000|8644)/);
});
