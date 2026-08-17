import {
  calculatePriority,
  classifyScope,
  getObservationTimeline,
  hazardMeta,
  normalizeSeverity,
  normalizeCapSeverity,
  normalizeEarthquakeSeverity,
  type CycloneForecast,
  type DisasterEvent,
  type HazardType,
} from "../../../lib/disasters";
import { listRetainedCanonicalEvents, persistCanonicalEvents, resolveCanonicalEventsByReferences } from "../../../db/operational";
import { circularGeometryCenter, cycloneSeverityFromKnots, firmsConfidenceScore, firmsHeatSeverity, latestTrackPoint } from "../../../lib/source-normalization";
import { authorizeApiRequest } from "../../../lib/api-security";
import { buildHourlyCycloneImpactField, buildJmaCycloneForecast, extractKmlFromKmz, parseNhcConeKml, parseNhcTrackKml, parseNhcWindRadiiKml } from "../../../lib/cyclone-forecast";
import { eventHasInvalidIdentity, firstValidSourceEventId, isValidSourceEventId } from "../../../lib/event-integrity";
import { updateIngestionHealth } from "../../../lib/runtime-health";
import { floodProcessEntityKey, sameFloodRegion } from "../../../lib/process-identity";

export const dynamic = "force-dynamic";

const endpoints = {
  cenc: "https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_subao",
  taihu: "https://www.tba.gov.cn/",
  jiangsuWater: "https://jswater.jiangsu.gov.cn/",
  usgs: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
  eonet: "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30&limit=100",
  gdacs: "https://www.gdacs.org/xml/rss.xml",
  firms: "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
  nhc: "https://www.nhc.noaa.gov/CurrentStorms.json",
  tsunamiNtwc: "https://www.tsunami.gov/events/xml/PAAQCAP.xml",
  tsunamiPtwc: "https://www.tsunami.gov/events/xml/PHEBCAP.xml",
  jmaTyphoons: "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json",
  wmoChinaCap: "https://severeweather.wmo.int/v2/cap-alerts/cn-cma-xx/rss.xml",
  usgsVolcanoes: "https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes",
  geonetVolcanoes: "https://api.geonet.org.nz/volcano/val",
  smithsonianVolcanoes: "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml",
  lhasa: "https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/LHASA_Exposure/MapServer/0/query",
  reliefWeb: "https://api.reliefweb.int/v2/disasters",
};

type SourceState = "online" | "offline" | "needs_config";
type SourceTier = "中国第一批" | "中国第二批" | "基础" | "第一优先级" | "第二优先级";
type SourceRole = "事件" | "预报" | "核验";

type SourceConnector = {
  name: string;
  tier: SourceTier;
  role: SourceRole;
  setupUrl: string;
  config?: { ready: boolean; message: string };
  successMessage?: string;
  fetcher: () => Promise<DisasterEvent[]>;
};

type SourceRun = {
  name: string;
  tier: SourceTier;
  role: SourceRole;
  setupUrl: string;
  state: SourceState;
  online: boolean;
  count: number;
  message: string;
  events: DisasterEvent[];
  producing: boolean;
};

type CancellationReference = { source: string; sourceEventId: string; reason: string };
const cancellationBuffer: CancellationReference[] = [];
let eventsCache: { body: string; status: number; contentType: string; expiresAt: number; etag: string } | null = null;
let eventsRefresh: Promise<NonNullable<typeof eventsCache>> | null = null;
let lastSuccessfulFetchAt: string | null = null;

export async function GET(request: Request) {
  const unauthorized = authorizeApiRequest(request);
  if (unauthorized) return unauthorized;
  if (eventsCache && eventsCache.expiresAt > Date.now()) return cachedEventsResponse(eventsCache, request);
  if (!eventsRefresh) {
    eventsRefresh = refreshEvents().then(async (response) => {
      const body = await response.text();
      return {
        body,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json; charset=utf-8",
        expiresAt: Date.now() + (response.ok ? 120_000 : 15_000),
        etag: `W/"${hashText(body)}"`,
      };
    }).then((cached) => (eventsCache = cached)).finally(() => { eventsRefresh = null; });
  }
  return cachedEventsResponse(await eventsRefresh, request);
}

function cachedEventsResponse(cached: NonNullable<typeof eventsCache>, request: Request) {
  const headers = { "Content-Type": cached.contentType, "Cache-Control": "private, max-age=30", "X-Tianxun-Cache": "shared-refresh", ETag: cached.etag };
  if (request.headers.get("if-none-match") === cached.etag) return new Response(null, { status: 304, headers });
  return new Response(cached.body, { status: cached.status, headers });
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

async function refreshEvents() {
  const connectors: SourceConnector[] = [
    {
      name: "中国地震台网",
      tier: "中国第一批",
      role: "事件",
      setupUrl: endpoints.cenc,
      fetcher: fetchCenc,
    },
    {
      name: "太湖流域管理局",
      tier: "中国第一批",
      role: "事件",
      setupUrl: endpoints.taihu,
      fetcher: fetchTaihu,
    },
    {
      name: "江苏省水利厅",
      tier: "中国第一批",
      role: "事件",
      setupUrl: endpoints.jiangsuWater,
      fetcher: fetchJiangsuWater,
    },
    {
      name: "中国气象数据网 CMA",
      tier: "中国第二批",
      role: "事件",
      setupUrl: "https://data.cma.cn/",
      config: {
        ready: Boolean(process.env.CMA_EVENT_FEED_URL),
        message: "注册并获授权后配置 CMA_EVENT_FEED_URL（CAP 或 GeoJSON）",
      },
      fetcher: fetchCma,
    },
    { name: "USGS", tier: "基础", role: "事件", setupUrl: "https://earthquake.usgs.gov/earthquakes/feed/", fetcher: fetchUsgs },
    { name: "EONET", tier: "基础", role: "事件", setupUrl: "https://eonet.gsfc.nasa.gov/", fetcher: fetchEonet },
    { name: "GDACS", tier: "基础", role: "事件", setupUrl: "https://www.gdacs.org/", fetcher: fetchGdacs },
    {
      name: "NASA FIRMS",
      tier: "第一优先级",
      role: "事件",
      setupUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/",
      config: { ready: Boolean(process.env.FIRMS_MAP_KEY), message: "需要配置 FIRMS_MAP_KEY" },
      fetcher: fetchFirms,
    },
    { name: "NOAA NHC", tier: "第一优先级", role: "事件", setupUrl: "https://www.nhc.noaa.gov/productexamples/", fetcher: fetchNhc },
    {
      name: "NOAA NTWC 海啸",
      tier: "第一优先级",
      role: "事件",
      setupUrl: "https://www.tsunami.gov/",
      successMessage: "在线；仅在海啸警告、观察或提示生效时生成任务",
      fetcher: () => fetchNoaaTsunami(endpoints.tsunamiNtwc, "NOAA NTWC 海啸"),
    },
    {
      name: "NOAA PTWC 海啸",
      tier: "第一优先级",
      role: "事件",
      setupUrl: "https://www.tsunami.gov/",
      successMessage: "在线；信息声明和已取消报文不进入任务流",
      fetcher: () => fetchNoaaTsunami(endpoints.tsunamiPtwc, "NOAA PTWC 海啸"),
    },
    {
      name: "日本气象厅 JMA 台风",
      tier: "第一优先级",
      role: "事件",
      setupUrl: "https://www.jma.go.jp/bosai/map.html#contents=typhoon",
      successMessage: "在线；当前中心为事件坐标，并附官方中心路径、70%预报圆及可用的强风警戒域",
      fetcher: fetchJmaTyphoons,
    },
    {
      name: "WMO Alert Hub · 中国",
      tier: "中国第二批",
      role: "核验",
      setupUrl: "https://severeweather.wmo.int/feeds.html",
      successMessage: "在线；免费CAP缺少点/面几何，先作告警核验，不用行政区质心冒充坐标",
      fetcher: fetchWmoChinaCap,
    },
    {
      name: "WMO SWIC/CAP",
      tier: "第一优先级",
      role: "事件",
      setupUrl: "https://severeweather.wmo.int/feeds.html",
      config: { ready: Boolean(process.env.WMO_CAP_FEED_URL), message: "需要配置获准使用的 WMO_CAP_FEED_URL" },
      fetcher: fetchWmoCap,
    },
    {
      name: "Copernicus GloFAS",
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://global-flood.emergency.copernicus.eu/",
      config: { ready: Boolean(process.env.GLOFAS_EVENT_FEED_URL), message: "需要配置业务侧 GLOFAS_EVENT_FEED_URL" },
      fetcher: fetchGlofas,
    },
    { name: "USGS HANS", tier: "第二优先级", role: "事件", setupUrl: "https://volcanoes.usgs.gov/hans-public/", fetcher: fetchUsgsVolcanoes },
    {
      name: "GeoNet 火山警戒",
      tier: "第二优先级",
      role: "核验",
      setupUrl: "https://www.geonet.org.nz/volcano",
      successMessage: "在线；源不提供警戒起始时间，仅核验当前等级，不伪造新事件",
      fetcher: fetchGeonetVolcanoes,
    },
    { name: "Smithsonian GVP", tier: "第二优先级", role: "核验", setupUrl: "https://volcano.si.edu/reports_weekly.cfm", fetcher: fetchSmithsonianVolcanoes },
    {
      name: "NASA LHASA",
      tier: "第二优先级",
      role: "预报",
      setupUrl: "https://landslides.nasa.gov/",
      successMessage: "在线；当前图层为行政区暴露度面，仅作背景，不冒充实时滑坡点",
      fetcher: fetchLhasa,
    },
    {
      name: "OCHA ReliefWeb",
      tier: "第二优先级",
      role: "核验",
      setupUrl: "https://apidoc.reliefweb.int/parameters",
      config: { ready: Boolean(process.env.RELIEFWEB_APPNAME), message: "需要配置审批后的 RELIEFWEB_APPNAME" },
      fetcher: fetchReliefWeb,
    },
  ];
  const runs = await Promise.all(connectors.map(runConnector));
  const refreshCompletedAt = new Date().toISOString();
  if (runs.some((run) => run.online)) lastSuccessfulFetchAt = refreshCompletedAt;
  const cancellations = cancellationBuffer.splice(0);
  const collected = runs.flatMap((run) => run.events);
  const normalized = canonicalizeEvents(collected.filter((event) => !eventHasInvalidIdentity(event))).map(finalize);
  const allSourcesUnavailable = runs.every((source) => !source.online);
  const sourceCounts = runs.map((run) => ({
    name: run.name,
    tier: run.tier,
    role: run.role,
    setupUrl: run.setupUrl,
    state: run.state,
    online: run.online,
    message: run.message,
    producing: run.producing,
    count: normalized.filter((event) => event.evidence.some((item) => item.source.startsWith(run.name))).length,
  }));
  let persistenceAvailable = true;
  if (!allSourcesUnavailable) persistenceAvailable = await persistCanonicalEvents(normalized);
  if (cancellations.length) {
    const byReason = new Map<string, CancellationReference[]>();
    cancellations.forEach((item) => byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]));
    for (const [reason, items] of byReason) await resolveCanonicalEventsByReferences(items, reason);
  }
  const retained = await listRetainedEventsSafely();
  updateIngestionHealth({
    lastAttemptAt: refreshCompletedAt,
    lastSuccessAt: lastSuccessfulFetchAt,
    onlineSources: runs.filter((run) => run.online).length,
    producingSources: runs.filter((run) => run.producing).length,
    persistenceAvailable,
  });
  const liveEvidence = new Set(normalized.flatMap((event) => event.evidence.map((item) => `${sourceFamily(item.source)}|${item.sourceEventId}`)));
  const operationalEvents = canonicalizeEvents([...normalized, ...retained]).map((event) => {
    const presentInCurrentFeeds = event.evidence.some((item) => liveEvidence.has(`${sourceFamily(item.source)}|${item.sourceEventId}`));
    const finalized = finalize(event);
    return { ...finalized, sourcePresence: presentInCurrentFeeds ? "current" as const : "retained" as const, lifecycleStatus: presentInCurrentFeeds ? finalized.lifecycleStatus : "monitoring" as const };
  });
  const hazardCounts = Object.entries(
    operationalEvents.reduce<Record<string, number>>((counts, event) => {
      counts[event.hazard] = (counts[event.hazard] ?? 0) + 1;
      return counts;
    }, {}),
  ).map(([hazard, count]) => ({ hazard, count }));
  const events = selectBalancedEvents(operationalEvents.filter((event) => event.observationStatus === "actionable" && event.lifecycleStatus !== "resolved"), 250);
  const retainedCount = events.filter((event) => event.sourcePresence === "retained").length;
  const fallback = allSourcesUnavailable ? fallbackEvents().map(finalize) : [];
  const fallbackSourceCounts = allSourcesUnavailable
    ? sourceCounts.map((source) => ({ ...source, count: 0 }))
    : sourceCounts;

  return Response.json(
    {
      events: allSourcesUnavailable ? (events.length ? events : fallback) : events,
      sourceStatus: fallbackSourceCounts,
      hazardCounts,
      fetchedAt: refreshCompletedAt,
      lastSuccessfulFetchAt,
      producingSourceCount: runs.filter((run) => run.producing).length,
      fallback: allSourcesUnavailable,
      expiredCount: normalized.filter((event) => event.observationStatus === "expired").length,
      processedCount: normalized.length,
      retainedCount,
      persistenceAvailable,
      selectionPolicy: { limit: 250, reservedPerHazard: 20, wildfireCap: 100, perSourceCap: 80 },
      windowPolicyVersion: "2026.08-phased-v3",
    },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=120" } },
  );
}

async function listRetainedEventsSafely() {
  try {
    return await listRetainedCanonicalEvents();
  } catch (error) {
    console.error("retained event lookup unavailable", error);
    return [];
  }
}

async function runConnector(connector: SourceConnector): Promise<SourceRun> {
  if (connector.config && !connector.config.ready) {
    return { ...connector, state: "needs_config", online: false, producing: false, count: 0, message: connector.config.message, events: [] };
  }
  try {
    let events: DisasterEvent[];
    try {
      events = await connector.fetcher();
    } catch (firstError) {
      if (!isTransientConnectorError(firstError)) throw firstError;
      await new Promise((resolve) => setTimeout(resolve, 350));
      events = await connector.fetcher();
    }
    return {
      ...connector,
      state: "online",
      online: true,
      producing: events.length > 0,
      count: events.length,
      message: connector.successMessage ?? (connector.role === "核验" ? "在线，仅用于交叉核验，不生成任务坐标" : "在线"),
      events,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 90) : "未知错误";
    return { ...connector, state: "offline", online: false, producing: false, count: 0, message: `本轮连接失败：${reason}`, events: [] };
  }
}

function isTransientConnectorError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|eai_again|HTTP (?:408|425|429|5\d\d)|\b(?:408|425|429|5\d\d)\b/i.test(message);
}

async function fetchJson(url: string) {
  const safeUrl = validateExternalFeedUrl(url);
  const response = await fetch(safeUrl, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(8_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
  return JSON.parse(await readLimitedText(response, 5_000_000, "JSON"));
}

async function fetchText(url: string) {
  const safeUrl = validateExternalFeedUrl(url);
  const response = await fetch(safeUrl, {
    headers: {
      Accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Tianxun-Disaster-Watch/0.1",
    },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
  return readLimitedText(response, 5_000_000, "文本");
}

async function fetchKmzKml(url: string) {
  const safeUrl = validateExternalFeedUrl(url, ["nhc.noaa.gov", "www.nhc.noaa.gov"]);
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/vnd.google-earth.kmz,application/zip", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 6_000_000) throw new Error("KMZ 文件超过安全上限");
  return extractKmlFromKmz(await readLimitedBytes(response, 6_000_000, "KMZ"));
}

async function readLimitedBytes(response: Response, maximumBytes: number, label: string) {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error(`${label}响应超过安全上限`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function readLimitedText(response: Response, maximumBytes: number, label: string) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label}响应超过安全上限`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label}响应超过安全上限`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function validateExternalFeedUrl(value: string, allowedHosts: string[] = []) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("上游地址必须是不含凭据的 HTTPS URL");
  const host = url.hostname.toLowerCase();
  if (allowedHosts.length && !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) throw new Error("上游地址不在允许域名中");
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1" || isPrivateIpv4(host)) throw new Error("禁止访问本机或内网地址");
  return url.toString();
}

function isPrivateIpv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function publicSourceUrl(value: string, fallback: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return fallback;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

async function fetchCenc(): Promise<DisasterEvent[]> {
  const html = await fetchText(endpoints.cenc);
  return [...html.matchAll(/<tr[^>]*id=["']earthquake_subao_guid_catalog_tr_[^"']+["'][^>]*>([\s\S]*?)<\/tr>/gi)]
    .flatMap((match) => {
      const cellHtml = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
      const cells = cellHtml.map((cell) => stripHtml(decodeXml(cell)));
      const dateIndex = cells.findIndex((cell) => /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2}$/.test(cell));
      if (dateIndex < 0 || cells.length < dateIndex + 7) return [];
      const occurredAt = chinaLocalIso(cells[dateIndex]);
      const longitude = Number(cells[dateIndex + 1]);
      const latitude = Number(cells[dateIndex + 2]);
      const depthKm = Number(cells[dateIndex + 3]);
      const magnitude = Number(cells[dateIndex + 4]);
      const fullLocation = cellHtml[dateIndex + 5]?.match(/wx_tip\(['"]([^'"]+)['"]/i)?.[1];
      const location = decodeXml(fullLocation ?? cells[dateIndex + 5]);
      const eventKind = cells[dateIndex + 6];
      if (!occurredAt || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(magnitude)) return [];
      if (eventKind && !eventKind.includes("天然地震")) return [];
      return [baseEvent({
        id: `cenc-${occurredAt}-${latitude.toFixed(3)}-${longitude.toFixed(3)}-m${magnitude.toFixed(1)}`,
        title: `${location || "未命名地区"} M${magnitude.toFixed(1)} 地震`,
        hazard: "earthquake",
        latitude,
        longitude,
        occurredAt,
        updatedAt: occurredAt,
        source: "中国地震台网",
        sourceUrl: endpoints.cenc,
        sourceSeverity: `M${magnitude.toFixed(1)}`,
        severity: normalizeEarthquakeSeverity(magnitude),
        magnitude,
        magnitudeUnit: "M",
        country: location,
        description: `中国地震台网统一速报目录；震源深度${Number.isFinite(depthKm) ? `${depthKm}千米` : "待核验"}。地震本体不可直接成像，任务应针对形变、破裂与次生灾害。`,
      })];
    });
}

async function fetchTaihu(): Promise<DisasterEvent[]> {
  const html = await fetchText(endpoints.taihu);
  const pageYear = new Date().getUTCFullYear();
  const seen = new Set<string>();
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .flatMap((match) => {
      const hrefRaw = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      const date = match[2].match(/\[\s*(\d{1,2})-(\d{1,2})\s*\]/);
      if (!hrefRaw || !date) return [];
      const href = new URL(hrefRaw, endpoints.taihu).toString();
      const titleAttribute = match[1].match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1];
      const title = stripHtml(decodeXml(titleAttribute ?? match[2])).replace(/^•\s*/, "").trim();
      const isTaihuFlood = /太湖.*洪水|洪水.*太湖/.test(title);
      const isTyphoonUpdate = /台风.*最新动态/.test(title);
      if (seen.has(href) || (!isTaihuFlood && !isTyphoonUpdate)) return [];
      seen.add(href);
      const month = Number(date[1]);
      const day = Number(date[2]);
      const now = new Date();
      let year = pageYear;
      if (month > now.getUTCMonth() + 2) year -= 1;
      const occurredAt = chinaLocalIso(`${year}-${month}-${day} 08:00:00`);
      if (!occurredAt) return [];
      const hazard: HazardType = isTyphoonUpdate ? "cyclone" : "flood";
      const [longitude, latitude] = [120.20, 31.23];
      return [baseEvent({
        id: `taihu-${href.split("/").pop()?.replace(/\.html$/i, "") ?? `${year}-${month}-${day}`}`,
        title,
        hazard,
        latitude,
        longitude,
        occurredAt,
        updatedAt: occurredAt,
        source: "太湖流域管理局",
        sourceUrl: href,
        sourceSeverity: title.includes("洪水") ? "流域洪水通报" : "台风防御动态",
        severity: title.includes("洪水") ? "orange" : "yellow",
        country: "中国 · 太湖流域",
        description: "官方流域事件通报。坐标为太湖流域任务初筛AOI中心，不代表单一传感器或精确受灾点；下发任务前应叠加河湖矢量和最新淹没边界。",
      })];
    })
    .slice(0, 12);
}

const jiangsuWaterTargets: Record<string, [number, number]> = {
  太浦河: [120.79, 31.08],
  苏南运河: [120.30, 31.57],
  望虞河: [120.48, 31.58],
};

async function fetchJiangsuWater(): Promise<DisasterEvent[]> {
  const html = await fetchText(endpoints.jiangsuWater);
  const briefing = html.match(/<a\s+href=["']([^"']*\/art\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/[^"']+)["'][^>]*>([\s\S]*?洪水(?:红色|橙色|黄色|蓝色)预警[\s\S]*?)<\/a>/i);
  if (!briefing) return [];
  const sourceUrl = new URL(briefing[1], endpoints.jiangsuWater).toString();
  const occurredAt = chinaLocalIso(`${briefing[2]}-${briefing[3]}-${briefing[4]} 08:00:00`);
  if (!occurredAt) return [];
  const text = stripHtml(decodeXml(briefing[5]));
  return [...text.matchAll(/([^，。；]{1,24}?)洪水(红色|橙色|黄色|蓝色)预警/g)].flatMap((match, index) => {
    const target = match[1].replace(/^.*?当前我省/, "").trim();
    const color = match[2];
    const coordinates = jiangsuWaterTargets[target];
    if (!coordinates) return [];
    return [baseEvent({
      id: `jiangsu-water-${target}-${occurredAt.slice(0, 10)}-${index}`,
      title: `${target}洪水${color}预警`,
      hazard: "flood",
      latitude: coordinates[1],
      longitude: coordinates[0],
      occurredAt,
      updatedAt: occurredAt,
      source: "江苏省水利厅",
      sourceUrl,
      sourceSeverity: `${color}预警`,
      severity: officialColorSeverity(color),
      country: `中国 · 江苏省 · ${target}`,
      description: "江苏省水利厅发布的河段级洪水预警。坐标为河段任务初筛AOI锚点，不是受灾边界；规划成像时应改用正式河道矢量或实测淹没面。",
    })];
  });
}

async function fetchCma(): Promise<DisasterEvent[]> {
  const url = process.env.CMA_EVENT_FEED_URL;
  if (!url) return [];
  const safeUrl = validateExternalFeedUrl(url);
  const authorization = process.env.CMA_EVENT_FEED_AUTHORIZATION?.trim();
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/geo+json,application/json,application/xml,text/xml", "User-Agent": "Tianxun-Disaster-Watch/0.1", ...(authorization ? { Authorization: authorization } : {}) },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} CMA`);
  const body = await readLimitedText(response, 5_000_000, "CMA");
  if (/^\s*</.test(body)) return parseCapFeed(body, "中国气象数据网 CMA", publicSourceUrl(url, "https://data.cma.cn/"));
  const data = JSON.parse(body) as { features?: Array<{ id?: string | number; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> };
  const now = new Date().toISOString();
  return (data.features ?? []).flatMap((feature, index) => {
    const center = geometryCenter(feature.geometry?.coordinates);
    const properties = feature.properties ?? {};
    const title = String(properties.title ?? properties.event ?? properties.name ?? "气象灾害预警");
    const hazard = textHazard(title);
    if (!center || !hazard) return [];
    const issuedAt = validIso(properties.issuedAt ?? properties.sent ?? properties.datetime ?? properties.date) ?? now;
    const sourceSeverity = String(properties.severity ?? properties.level ?? properties.color ?? "气象预警");
    return [baseEvent({
      id: `cma-${String(feature.id ?? properties.id ?? index)}-${issuedAt}`,
      title,
      hazard,
      latitude: center[1],
      longitude: center[0],
      occurredAt: issuedAt,
      updatedAt: validIso(properties.updatedAt ?? properties.updated) ?? issuedAt,
      source: "中国气象数据网 CMA",
      sourceUrl: String(properties.url ?? url),
      sourceSeverity,
      severity: officialColorSeverity(sourceSeverity),
      geometry: feature.geometry?.type && feature.geometry.coordinates !== undefined ? sanitizeGeometry({ type: feature.geometry.type, coordinates: feature.geometry.coordinates }) : undefined,
      country: String(properties.area ?? properties.location ?? "中国"),
      description: String(properties.description ?? "来自已授权CMA业务接口；仅接收带点位或面几何、且遥感可直接或间接观测的事件。"),
    })];
  });
}

async function fetchUsgs(): Promise<DisasterEvent[]> {
  const data = await fetchJson(endpoints.usgs) as {
    features: Array<{
      id: string;
      geometry: { coordinates: [number, number, number] };
      properties: Record<string, unknown>;
    }>;
  };
  return data.features.map((feature) => {
    const p = feature.properties;
    const magnitude = Number(p.mag ?? 0);
    return baseEvent({
      id: `usgs-${feature.id}`,
      title: String(p.title ?? "地震事件"),
      hazard: "earthquake",
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
      occurredAt: new Date(Number(p.time)).toISOString(),
      updatedAt: new Date(Number(p.updated)).toISOString(),
      source: "USGS",
      sourceUrl: String(p.url ?? endpoints.usgs),
      sourceSeverity: String(p.alert ?? `M${magnitude.toFixed(1)}`),
      severity: p.alert ? normalizeSeverity(String(p.alert)) : normalizeEarthquakeSeverity(magnitude),
      magnitude,
      magnitudeUnit: "Mw",
      country: String(p.place ?? ""),
      description: p.tsunami ? "存在海啸标记，建议同步检查沿岸观测需求。" : "适合触发震后形变、滑坡与建成区损毁观测。",
    });
  });
}

async function fetchEonet(): Promise<DisasterEvent[]> {
  const data = await fetchJson(endpoints.eonet) as {
    features: Array<{
      id?: string;
      geometry: { type: string; coordinates: unknown };
      properties: Record<string, unknown>;
    }>;
  };
  return data.features.flatMap((feature) => {
    const geometryDates = Array.isArray(pickRecordValue(feature.properties, "geometryDates")) ? pickRecordValue(feature.properties, "geometryDates") as unknown[] : [];
    const coords = pointFromGeometry(feature.geometry, geometryDates);
    if (!coords) return [];
    const p = feature.properties;
    const sourceEventId = firstValidSourceEventId(p.id, feature.id);
    if (!sourceEventId) return [];
    const categories = (p.categories as Array<{ id?: string; title?: string }> | undefined) ?? [];
    const hazard = eonetHazard(categories[0]?.id ?? categories[0]?.title ?? "");
    if (!hazard) return [];
    const source = ((p.sources as Array<{ id?: string; url?: string }> | undefined) ?? [])[0];
    const magnitude = Number(p.magnitudeValue ?? 0) || undefined;
    const occurredAt = String(p.date ?? new Date().toISOString());
    return [baseEvent({
      id: `eonet-${sourceEventId}`,
      title: String(p.title ?? categories[0]?.title ?? "自然灾害事件"),
      hazard,
      latitude: coords[1],
      longitude: coords[0],
      occurredAt,
      updatedAt: occurredAt,
      source: `EONET${source?.id ? ` · ${source.id}` : ""}`,
      sourceUrl: source?.url ?? String(p.link ?? "https://eonet.gsfc.nasa.gov/"),
      sourceSeverity: magnitude ? String(magnitude) : "监测中",
      severity: normalizeEonetSeverity(hazard, String(p.magnitudeUnit ?? ""), magnitude),
      magnitude,
      magnitudeUnit: String(p.magnitudeUnit ?? "") || undefined,
      geometry: sanitizeGeometry(feature.geometry),
      description: String(p.description ?? "NASA EONET 收录的持续自然事件。"),
    })];
  });
}

async function fetchGdacs(): Promise<DisasterEvent[]> {
  const response = await fetch(endpoints.gdacs, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(8_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} GDACS`);
  const xml = await readLimitedText(response, 5_000_000, "GDACS");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match, index) => {
    const item = match[1];
    const typeCode = tag(item, "gdacs:eventtype");
    const hazard = gdacsHazard(typeCode);
    const point = tag(item, "georss:point").trim().split(/\s+/).map(Number);
    if (!hazard || point.length < 2 || point.some(Number.isNaN)) return [];
    const sourceSeverity = tag(item, "gdacs:alertlevel") || "Green";
    const occurredAt = new Date(tag(item, "pubDate") || Date.now()).toISOString();
    return [baseEvent({
      id: `gdacs-${tag(item, "guid") || `${typeCode}-${index}`}`,
      title: decodeXml(tag(item, "title") || `${hazardMeta[hazard].label}事件`),
      hazard,
      latitude: point[0],
      longitude: point[1],
      occurredAt,
      updatedAt: occurredAt,
      source: "GDACS",
      sourceUrl: decodeXml(tag(item, "link") || "https://www.gdacs.org/"),
      sourceSeverity,
      severity: normalizeSeverity(sourceSeverity),
      country: decodeXml(tag(item, "gdacs:country")),
      description: stripHtml(decodeXml(tag(item, "description"))).slice(0, 260),
    })];
  });
}

async function fetchFirms(): Promise<DisasterEvent[]> {
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) return [];
  const url = `${endpoints.firms}/${encodeURIComponent(mapKey)}/VIIRS_NOAA20_NRT/world/1`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} FIRMS`);
  const rows = parseCsv(await readLimitedText(response, 8_000_000, "FIRMS"));
  const cells = new Map<string, Array<Record<string, string>>>();
  rows.forEach((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const cell = `${Math.round(latitude * 4) / 4},${Math.round(longitude * 4) / 4}`;
    cells.set(cell, [...(cells.get(cell) ?? []), row]);
  });
  return [...cells.entries()]
    .map(([cell, detections]) => {
      const latitude = detections.reduce((sum, row) => sum + Number(row.latitude), 0) / detections.length;
      const longitude = detections.reduce((sum, row) => sum + Number(row.longitude), 0) / detections.length;
      const newest = detections.sort((a, b) => String(b.acq_date + b.acq_time).localeCompare(String(a.acq_date + a.acq_time)))[0];
      const occurredAt = firmsDate(newest.acq_date, newest.acq_time);
      const confidenceCode = String(newest.confidence ?? "").toLowerCase();
      const confidence = firmsConfidenceScore(newest.confidence);
      const frp = Math.max(...detections.map((row) => Number(row.frp) || 0));
      const event = baseEvent({
        id: `firms-${cell}-${newest.acq_date}-${newest.acq_time}`,
        title: `VIIRS 热异常簇（${detections.length}个探测）`,
        hazard: "wildfire",
        latitude,
        longitude,
        occurredAt,
        updatedAt: occurredAt,
        source: "NASA FIRMS",
        sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
        sourceSeverity: `FRP ${frp.toFixed(1)} MW`,
        severity: firmsHeatSeverity(frp),
        magnitude: frp,
        magnitudeUnit: "MW FRP",
        description: `同一0.25°网格聚合 ${detections.length} 个VIIRS近实时热异常（置信度 ${confidenceCode || "未知"}）；它不是已确认森林火灾，必须结合地表覆盖、常年热源和其他证据复核。`,
      });
      const detectionConfidence = Math.min(event.confidenceScore, confidence);
      return { ...event, confidenceScore: detectionConfidence, confidenceLevel: confidenceLevel(detectionConfidence), observable: "conditional" as const, dispatchEligibility: "review_required" as const, aoiApprovalRequired: true };
    });
}

async function fetchNhc(): Promise<DisasterEvent[]> {
  const data = await fetchJson(endpoints.nhc) as Record<string, unknown>;
  const storms = ((data.activeStorms ?? data.storms ?? []) as Array<Record<string, unknown>>);
  const events = await Promise.all(storms.slice(0, 12).map(async (storm, index): Promise<DisasterEvent | null> => {
    const latitude = parseCoordinate(storm.latitude ?? storm.lat);
    const longitude = parseCoordinate(storm.longitude ?? storm.lon);
    if (latitude === null || longitude === null) return null;
    const publicAdvisory = isRecord(storm.publicAdvisory) ? storm.publicAdvisory : {};
    const forecastTrack = isRecord(storm.forecastTrack) ? storm.forecastTrack : {};
    const trackCone = isRecord(storm.trackCone) ? storm.trackCone : {};
    const forecastWindRadii = isRecord(storm.forecastWindRadiiGIS) ? storm.forecastWindRadiiGIS : {};
    const occurredAt = validIso(storm.lastUpdate ?? publicAdvisory.issuance ?? storm.advisoryDate ?? storm.binNumber) ?? new Date().toISOString();
    const name = String(storm.stormName ?? storm.name ?? storm.id ?? `热带气旋 ${index + 1}`);
    const windKt = Number(storm.intensity ?? storm.windSpeed ?? 0);
    const pressureHpa = Number(storm.pressure);
    const sourceUrl = String(publicAdvisory.url ?? (isRecord(storm.forecastGraphics) ? storm.forecastGraphics.url : undefined) ?? "https://www.nhc.noaa.gov/");
    let cycloneForecast: CycloneForecast | undefined;
    const trackKmzUrl = typeof forecastTrack.kmzFile === "string" ? forecastTrack.kmzFile : "";
    if (trackKmzUrl) {
      try {
        const trackKml = await fetchKmzKml(trackKmzUrl);
        const issuedAt = validIso(forecastTrack.issuance) ?? occurredAt;
        const parsedTrack = parseNhcTrackKml(trackKml, issuedAt, {
          latitude,
          longitude,
          windSpeedKnots: Number.isFinite(windKt) && windKt > 0 ? windKt : undefined,
          pressureHpa: Number.isFinite(pressureHpa) && pressureHpa > 0 ? pressureHpa : undefined,
          category: String(storm.classification ?? storm.stormType ?? ""),
        });
        if (parsedTrack) {
          const [coneResult, windResult] = await Promise.allSettled([
            typeof trackCone.kmzFile === "string" ? fetchKmzKml(trackCone.kmzFile) : Promise.reject(new Error("无概率锥")),
            typeof forecastWindRadii.kmzFile === "string" ? fetchKmzKml(forecastWindRadii.kmzFile) : Promise.reject(new Error("无预报风圈")),
          ]);
          const uncertaintyGeometry = coneResult.status === "fulfilled" ? parseNhcConeKml(coneResult.value) : undefined;
          const windRadii = windResult.status === "fulfilled"
            ? parseNhcWindRadiiKml(windResult.value, parsedTrack.track)
            : { timeSlices: [], geometry: undefined, thresholdKnots: undefined };
          cycloneForecast = {
            official: true,
            source: "NOAA NHC",
            sourceUrl,
            advisory: forecastTrack.advNum ? `Advisory ${String(forecastTrack.advNum)}` : undefined,
            issuedAt,
            forecastValidUntil: parsedTrack.track[parsedTrack.track.length - 1].forecastAt,
            track: parsedTrack.track,
            trackGeometry: parsedTrack.trackGeometry,
            uncertaintyGeometry,
            uncertaintyLabel: uncertaintyGeometry ? "NHC 官方路径概率锥（约 60%–70% 的中心路径落入）" : undefined,
            impactGeometry: windRadii.geometry,
            impactField: buildHourlyCycloneImpactField(parsedTrack.track, windRadii.timeSlices, uncertaintyGeometry),
            impactBasis: windRadii.geometry ? "forecast_wind_radii" : "uncertainty_only",
            impactThreshold: windRadii.thresholdKnots ? `预报 ≥${windRadii.thresholdKnots} kt 风圈` : undefined,
            note: "预报路径、概率锥和风圈会随每个报次更新；概率锥只表示中心路径不确定性，不代表风雨影响边界。",
          };
        }
      } catch (error) {
        console.warn(`NHC forecast unavailable for ${String(storm.id ?? name)}`, error);
      }
    }
    return baseEvent({
      id: `nhc-${String(storm.id ?? storm.stormId ?? name)}-${occurredAt}`,
      title: `${String(storm.classification ?? storm.stormType ?? "热带气旋")} ${name}`,
      hazard: "cyclone",
      latitude,
      longitude,
      occurredAt,
      updatedAt: occurredAt,
      source: "NOAA NHC",
      sourceUrl,
      sourceSeverity: windKt ? `${windKt} kt` : String(storm.classification ?? "活动中"),
      severity: cycloneSeverityFromKnots(windKt),
      magnitude: windKt || undefined,
      magnitudeUnit: windKt ? "kt" : undefined,
      description: cycloneForecast
        ? "NHC业务区当前热带气旋中心位置，并附官方预报路径、路径概率锥及可用的预报风圈。"
        : "NHC业务区当前热带气旋中心位置；本轮官方预报图层暂未取得。",
      cycloneForecast,
    });
  }));
  return events.filter((event): event is DisasterEvent => Boolean(event));
}

async function fetchNoaaTsunami(url: string, source: string): Promise<DisasterEvent[]> {
  const xml = await fetchText(url);
  const status = tag(xml, "status");
  const messageType = tag(xml, "msgType");
  const eventName = decodeXml(tag(xml, "event"));
  const headline = decodeXml(tag(xml, "headline"));
  const responseType = tag(xml, "responseType");
  const expiresAt = validIso(tag(xml, "expires"));
  if (/cancel/i.test(messageType) || /cancell?ation|cancelled|final/i.test(`${eventName} ${headline}`) || (expiresAt && +new Date(expiresAt) <= Date.now())) {
    recordCapCancellations(xml, source, `权威海啸报文已${/cancel/i.test(messageType) ? "撤销" : "结束或过期"}`);
    return [];
  }
  const isActionable = /warning|watch|advisory/i.test(`${eventName} ${headline} ${responseType}`)
    && !/information statement|cancell?ation|cancelled|final/i.test(`${eventName} ${headline}`)
    && status.toLowerCase() === "actual"
    && messageType.toLowerCase() !== "cancel"
    && (!expiresAt || +new Date(expiresAt) > Date.now());
  if (!isActionable) return [];

  const circle = tag(xml, "circle");
  const coordinateText = circle || parameterValue(xml, "EventLatLon");
  const coordinateMatch = coordinateText.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!coordinateMatch) return [];
  const latitude = Number(coordinateMatch[1]);
  const longitude = Number(coordinateMatch[2]);
  const occurredAt = validIso(parameterValue(xml, "EventOriginTime") || tag(xml, "onset") || tag(xml, "sent"));
  const updatedAt = validIso(tag(xml, "sent")) ?? occurredAt;
  if (!occurredAt || !updatedAt || !validCoordinates(latitude, longitude)) return [];
  const severityText = tag(xml, "severity") || eventName;
  const magnitude = Number(parameterValue(xml, "EventPreliminaryMagnitude")) || undefined;

  return [baseEvent({
    id: `noaa-tsunami-${tag(xml, "identifier") || occurredAt}`,
    title: headline || eventName || "海啸预警",
    hazard: "tsunami",
    latitude,
    longitude,
    occurredAt,
    updatedAt,
    source,
    sourceUrl: decodeXml(tag(xml, "web") || url),
    sourceSeverity: `${eventName}${severityText ? ` · ${severityText}` : ""}`,
    severity: /warning|extreme|severe/i.test(`${eventName} ${severityText}`) ? "red" : /watch|moderate/i.test(`${eventName} ${severityText}`) ? "orange" : "yellow",
    magnitude,
    magnitudeUnit: magnitude ? parameterValue(xml, "EventPreliminaryMagnitudeType") || "M" : undefined,
    country: decodeXml(tag(xml, "areaDesc") || parameterValue(xml, "EventLocationName")),
    description: stripHtml(decodeXml(tag(xml, "description"))).slice(0, 320),
  })];
}

async function fetchJmaTyphoons(): Promise<DisasterEvent[]> {
  const feed = await fetchJson(endpoints.jmaTyphoons) as unknown;
  const entries = collectRecords(feed).filter((entry) => {
    const text = JSON.stringify(entry).toLowerCase();
    return /台風|typhoon|tropical cyclone|tropicalcyclone|"tc\d{4}"/.test(text);
  });
  const candidates: Array<{ record: Record<string, unknown>; eventId: string }> = [];
  entries.forEach((record) => {
    const eventId = String(record.tropicalCyclone ?? record.eventId ?? record.eventID ?? record.id ?? record.key ?? "");
    if (eventId) candidates.push({ record, eventId });
  });
  const unique = [...new Map(candidates.map((candidate) => [candidate.eventId, candidate])).values()].slice(0, 12);

  const resolved = await Promise.all(unique.map(async ({ record, eventId }) => {
    let specification: unknown = record;
    let forecast: unknown = [];
    try {
      [specification, forecast] = await Promise.all([
        fetchJson(`https://www.jma.go.jp/bosai/typhoon/data/${encodeURIComponent(eventId)}/specifications.json`),
        fetchJson(`https://www.jma.go.jp/bosai/typhoon/data/${encodeURIComponent(eventId)}/forecast.json`),
      ]);
    } catch {
      // 部分列表项已包含完整实况；详情端点短暂不可用时仍可按相同字段解析。
    }
    return parseJmaTyphoon(specification, eventId, forecast);
  }));
  return resolved.filter((event): event is DisasterEvent => Boolean(event));
}

function parseJmaTyphoon(payload: unknown, eventId: string, forecastPayload: unknown): DisasterEvent | null {
  const records = collectRecords(payload);
  const current = records.find((record) => /実況|analysis|current|observation/i.test(String(record.type ?? record.label ?? record.status ?? record.kind ?? "")))
    ?? records.find((record) => Number(record.advancedHours) === 0)
    ?? records.find((record) => findLatLon(record) !== null);
  if (!current) return null;
  const sourceUrl = `https://www.jma.go.jp/bosai/map.html#contents=typhoon&typhoon=${encodeURIComponent(eventId)}`;
  const cycloneForecast = buildJmaCycloneForecast(payload, forecastPayload, sourceUrl);
  const currentForecastPoint = cycloneForecast?.track.find((point) => point.leadHours === 0);
  const position = isRecord(current.position) && Array.isArray(current.position.deg) ? current.position.deg : null;
  const coordinates = currentForecastPoint
    ? [currentForecastPoint.longitude, currentForecastPoint.latitude] as [number, number]
    : position && validCoordinates(Number(position[0]), Number(position[1]))
      ? [Number(position[1]), Number(position[0])] as [number, number]
      : findLatLon(current);
  if (!coordinates) return null;
  const occurredAt = currentForecastPoint?.forecastAt ?? findIsoValue(current) ?? findIsoValue(payload);
  if (!occurredAt) return null;
  const titleRecord = records.find((record) => record.part === "title") ?? {};
  const name = localizedText(current.name ?? titleRecord.name ?? current.typhoonName ?? titleRecord.typhoonName) || eventId;
  const location = localizedText(current.location ?? current.area ?? titleRecord.location);
  const wind = firstFinite(
    valueAtPath(current, ["maximumWind", "sustained", "m/s"]),
    valueAtPath(current, ["maximumWind", "sustained", "ms"]),
    current.maximumWind,
    current.maxWind,
  );
  const pressure = firstFinite(current.pressure, current.centralPressure);
  return baseEvent({
    id: `jma-typhoon-${eventId}-${occurredAt}`,
    title: `日本气象厅台风 ${name}`,
    hazard: "cyclone",
    latitude: coordinates[1],
    longitude: coordinates[0],
    occurredAt,
    updatedAt: cycloneForecast?.issuedAt ?? occurredAt,
    source: "日本气象厅 JMA 台风",
    sourceUrl,
    sourceSeverity: wind !== null ? `最大风速 ${wind} m/s` : pressure !== null ? `中心气压 ${pressure} hPa` : "活动中",
    severity: wind !== null && wind >= 51 ? "red" : wind !== null && wind >= 33 ? "orange" : wind !== null && wind >= 17 ? "yellow" : "blue",
    magnitude: wind ?? pressure ?? undefined,
    magnitudeUnit: wind !== null ? "m/s" : pressure !== null ? "hPa" : undefined,
    country: location || "西北太平洋",
    description: cycloneForecast
      ? "JMA当前台风中心实况，并附官方预报中心路径、70%预报圆及当前强风警戒域；预报点不冒充灾害发生坐标。"
      : "JMA当前台风中心实况；本轮官方预报图层暂未取得。",
    cycloneForecast,
  });
}

async function fetchWmoChinaCap(): Promise<DisasterEvent[]> {
  const feed = await fetchText(endpoints.wmoChinaCap);
  const entries = [...feed.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (!entries.length || !entries.some((entry) => tag(entry, "cap:event"))) throw new Error("WMO CAP 返回结构异常");
  // 中国汇聚报文当前只带CPEAS行政区代码和areaDesc，不带point/polygon/circle。
  // 在行政区边界库接入前仅作在线告警核验，避免把行政区质心当成灾害精确坐标。
  return [];
}

async function fetchUsgsVolcanoes(): Promise<DisasterEvent[]> {
  const notices = await fetchJson(endpoints.usgsVolcanoes) as Array<Record<string, unknown>>;
  const enriched = await Promise.all(notices.slice(0, 20).map(async (notice) => {
    const vnum = String(notice.vnum ?? "");
    if (!vnum) return null;
    let volcano: Record<string, unknown> = {};
    try {
      volcano = await fetchJson(`https://volcanoes.usgs.gov/hans-public/api/volcano/getVolcano/${encodeURIComponent(vnum)}`) as Record<string, unknown>;
    } catch {
      return null;
    }
    const latitude = firstFinite(volcano.latitude, volcano.lat, volcano.latitude_dd);
    const longitude = firstFinite(volcano.longitude, volcano.lon, volcano.longitude_dd);
    if (latitude === null || longitude === null) return null;
    const occurredAt = new Date(Number(notice.sent_unixtime ?? Date.now() / 1000) * 1000).toISOString();
    const level = `${String(notice.color_code ?? "")} ${String(notice.alert_level ?? "")}`.trim();
    return baseEvent({
      id: `hans-${vnum}-${String(notice.sent_unixtime ?? "current")}`,
      title: `${String(notice.volcano_name ?? volcano.volcano_name ?? "火山")} 活动等级升高`,
      hazard: "volcano",
      latitude,
      longitude,
      occurredAt,
      updatedAt: occurredAt,
      source: "USGS HANS",
      sourceUrl: String(notice.notice_url ?? "https://volcanoes.usgs.gov/hans-public/"),
      sourceSeverity: level || "Elevated",
      severity: normalizeSeverity(level),
      country: String(volcano.country ?? notice.obs_fullname ?? ""),
      description: "USGS HANS在管辖范围内发布的火山警戒等级升高通知。",
    });
  }));
  return enriched.filter((event): event is DisasterEvent => Boolean(event));
}

async function fetchGeonetVolcanoes(): Promise<DisasterEvent[]> {
  const response = await fetch(endpoints.geonetVolcanoes, {
    headers: {
      Accept: "application/vnd.geo+json;version=2,application/geo+json,application/json",
      "User-Agent": "Tianxun-Disaster-Watch/0.1",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`${response.status} GeoNet`);
  const data = JSON.parse(await readLimitedText(response, 2_000_000, "GeoNet")) as { type?: string; features?: unknown[] };
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("GeoNet 返回结构异常");
  // 该端点提供当前警戒状态，但不提供警戒开始/更新时间。这里仅验证数据可用性，
  // 不把响应时间伪造成灾害发生时间，也不生成卫星任务坐标。
  return [];
}

async function fetchSmithsonianVolcanoes(): Promise<DisasterEvent[]> {
  const response = await fetch(endpoints.smithsonianVolcanoes, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${response.status} Smithsonian GVP`);
  await readLimitedText(response, 2_000_000, "Smithsonian GVP");
  return [];
}

async function fetchLhasa(): Promise<DisasterEvent[]> {
  const params = new URLSearchParams({
    where: "1=1",
    returnCountOnly: "true",
    returnGeometry: "false",
    f: "json",
  });
  const data = await fetchJson(`${endpoints.lhasa}?${params}`) as {
    count?: number;
  };
  if (!Number.isFinite(Number(data.count))) throw new Error("LHASA 返回结构异常");
  // 先对官方服务做轻量健康检查。LHASA输出是行政区面风险图，不能用国家/地区质心冒充灾害精确坐标，
  // 因而保持在线预报源状态，但只在后续接入正式面几何处理链后生成任务事件。
  return [];
}

async function fetchWmoCap(): Promise<DisasterEvent[]> {
  const url = process.env.WMO_CAP_FEED_URL;
  if (!url) return [];
  const safeUrl = validateExternalFeedUrl(url);
  const response = await fetch(safeUrl, { headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  if (!response.ok) throw new Error(`${response.status} WMO CAP`);
  const xml = await readLimitedText(response, 5_000_000, "WMO CAP");
  return parseCapFeed(xml, "WMO SWIC/CAP", publicSourceUrl(url, "https://severeweather.wmo.int/feeds.html"));
}

async function fetchGlofas(): Promise<DisasterEvent[]> {
  const url = process.env.GLOFAS_EVENT_FEED_URL;
  if (!url) return [];
  const data = await fetchJson(url) as { features?: Array<{ id?: string | number; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> };
  const now = new Date().toISOString();
  return (data.features ?? []).flatMap((feature) => {
    const coordinates = feature.geometry?.coordinates;
    const center = geometryCenter(coordinates);
    if (!center) return [];
    const p = feature.properties ?? {};
    const issuedAt = validIso(p.issuedAt ?? p.issued_at ?? p.datetime ?? p.date) ?? now;
    const forecastAt = validIso(p.onset ?? p.validFrom ?? p.valid_from ?? p.forecastStart ?? p.forecast_start ?? p.forecastTime) ?? issuedAt;
    const validTo = validIso(p.validTo ?? p.valid_to ?? p.forecastEnd ?? p.forecast_end ?? p.expires);
    const returnPeriod = Number(p.returnPeriod ?? p.return_period ?? 0);
    const rawProbability = Number(p.probability ?? p.exceedanceProbability ?? p.exceedance_probability);
    const probability = Number.isFinite(rawProbability) ? Math.max(0, Math.min(1, rawProbability > 1 ? rawProbability / 100 : rawProbability)) : null;
    const severity = returnPeriod >= 20 && (probability === null || probability >= 0.5)
      ? "orange" as const
      : returnPeriod >= 5 || (probability !== null && probability >= 0.3) ? "yellow" as const : "blue" as const;
    const event = baseEvent({
      id: `glofas-${String(feature.id ?? p.id ?? `${center[1]}-${center[0]}`)}-${issuedAt}`,
      title: String(p.title ?? p.name ?? "GloFAS洪水预报目标"),
      hazard: "flood",
      latitude: center[1],
      longitude: center[0],
      occurredAt: forecastAt,
      updatedAt: issuedAt,
      activityAt: issuedAt,
      source: "Copernicus GloFAS",
      sourceUrl: String(p.url ?? "https://global-flood.emergency.copernicus.eu/"),
      sourceSeverity: `${returnPeriod ? `预测重现期 ${returnPeriod} 年` : String(p.severity ?? "洪水预报")}${probability === null ? "" : ` · 超阈概率 ${(probability * 100).toFixed(0)}%`}`,
      severity,
      geometry: feature.geometry?.type && coordinates !== undefined ? sanitizeGeometry({ type: feature.geometry.type, coordinates }) : undefined,
      description: `由业务侧 GloFAS 处理链输出的洪水预测目标；目标时间为预测起始时间，更新时间为预报发布时间${validTo ? `，有效期至 ${validTo}` : ""}。它不是已确认洪水，必须经实况或人工复核后下发任务。`,
    });
    return [{ ...event, observable: "conditional" as const, dispatchEligibility: "review_required" as const, aoiApprovalRequired: true }];
  });
}

async function fetchReliefWeb(): Promise<DisasterEvent[]> {
  const appname = process.env.RELIEFWEB_APPNAME;
  if (!appname) return [];
  const params = new URLSearchParams({ appname, preset: "latest", limit: "20", profile: "list" });
  await fetchJson(`${endpoints.reliefWeb}?${params}`);
  return [];
}

function baseEvent(input: Omit<DisasterEvent, "masterEventId" | "entityKey" | "lifecycleStatus" | "sourcePresence" | "evidence" | "evidenceCount" | "updateHistory" | "updateCount" | "confidenceScore" | "confidenceLevel" | "geometryType" | "geometry" | "activityAt" | "locationQuality" | "locationAccuracyKm" | "aoiApprovalRequired" | "dispatchEligibility" | "observable" | "observationTargets" | "recommendedSensors" | "scope" | "priority" | "priorityBreakdown" | "observationGoldenHours" | "observationWindowHours" | "observationReviewAt" | "observationExpiresAt" | "observationPhase" | "observationStatus"> & { geometry?: DisasterEvent["geometry"]; activityAt?: string }): DisasterEvent {
  const meta = hazardMeta[input.hazard];
  const location = inferLocationProfile(input.source, input.hazard, input.description);
  const confidenceScore = sourceTrust(input.source) - (location.quality === "representative" ? 18 : location.quality === "estimated" ? 8 : 0);
  return {
    ...input,
    activityAt: input.activityAt ?? input.occurredAt,
    masterEventId: input.id,
    entityKey: processEntityKey(input),
    lifecycleStatus: "active",
    sourcePresence: "current",
    evidence: [{
      source: input.source,
      sourceUrl: input.sourceUrl,
      sourceEventId: input.id,
      observedAt: input.updatedAt,
      role: evidenceRole(input.source),
    }],
    evidenceCount: 1,
    updateHistory: [{
      source: input.source,
      sourceUrl: input.sourceUrl,
      sourceEventId: input.id,
      title: input.title,
      observedAt: input.updatedAt,
      sourceSeverity: input.sourceSeverity,
    }],
    updateCount: 1,
    confidenceScore,
    confidenceLevel: confidenceLevel(confidenceScore),
    geometryType: input.geometry?.type ?? "Point",
    geometry: input.geometry ?? { type: "Point", coordinates: [input.longitude, input.latitude] },
    locationQuality: location.quality,
    locationAccuracyKm: location.accuracyKm,
    aoiApprovalRequired: location.quality !== "precise",
    dispatchEligibility: location.quality === "precise" ? "ready" : "review_required",
    observable: meta.observable,
    observationTargets: meta.targets,
    recommendedSensors: meta.sensors,
    scope: "global",
    priority: 0,
    priorityBreakdown: { severity: 0, scope: 0, observability: 0, time: 0, confidence: 0 },
    observationGoldenHours: 0,
    observationWindowHours: 0,
    observationReviewAt: input.updatedAt,
    observationExpiresAt: input.updatedAt,
    observationPhase: "golden",
    observationStatus: "actionable",
  };
}

function finalize(event: DisasterEvent): DisasterEvent {
  const scope = classifyScope(event.latitude, event.longitude, `${event.country ?? ""} ${event.title}`);
  const timeline = getObservationTimeline(
    event.occurredAt,
    event.activityAt,
    event.hazard,
    event.severity,
  );
  const priority = calculatePriority(event.severity, scope, event.hazard, event.activityAt, event.observable, event.confidenceScore);
  return {
    ...event,
    scope,
    priority: priority.total,
    priorityBreakdown: {
      severity: priority.severity,
      scope: priority.scope,
      observability: priority.observability,
      time: priority.time,
      confidence: priority.confidence,
    },
    observationGoldenHours: timeline.goldenHours,
    observationWindowHours: timeline.followupHours,
    observationReviewAt: timeline.reviewAt,
    observationExpiresAt: timeline.expiresAt,
    observationPhase: timeline.phase,
    observationStatus: timeline.phase === "archive" ? "expired" : "actionable",
    lifecycleStatus: timeline.phase === "archive" ? "archived" : timeline.phase === "followup" ? "monitoring" : "active",
  };
}

function canonicalizeEvents(events: DisasterEvent[]) {
  const groups: DisasterEvent[][] = [];
  const sorted = [...events].sort((a, b) => sourceTrust(b.source) - sourceTrust(a.source) || +new Date(b.updatedAt) - +new Date(a.updatedAt));

  for (const event of sorted) {
    const group = groups.find((candidates) => candidates.every((candidate) => isSamePhysicalEvent(candidate, event)));
    if (group) group.push(event);
    else groups.push([event]);
  }

  return groups.map((candidates) => {
    const primary = [...candidates].sort((a, b) => eventAuthority(b) - eventAuthority(a) || +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    const evidence = [...new Map(candidates.flatMap((event) => event.evidence)
      .sort((a, b) => +new Date(b.observedAt) - +new Date(a.observedAt))
      .map((item) => [`${sourceFamily(item.source)}|${item.sourceEventId}`, item])).values()];
    const updateHistory = [...new Map(candidates.flatMap((event) => event.updateHistory?.length ? event.updateHistory : event.evidence.map((item) => ({
      ...item,
      title: event.title,
      sourceSeverity: event.sourceSeverity,
    })))
      .sort((a, b) => +new Date(b.observedAt) - +new Date(a.observedAt))
      .map((item) => [`${sourceFamily(item.source)}|${item.sourceEventId}`, item])).values()].slice(0, 50);
    const location = [...candidates].sort((a, b) => locationRank(b.locationQuality) - locationRank(a.locationQuality) || a.locationAccuracyKm - b.locationAccuracyKm)[0];
    const cycloneForecast = candidates.flatMap((event) => event.cycloneForecast ? [event.cycloneForecast] : [])
      .sort((a, b) => +new Date(b.issuedAt) - +new Date(a.issuedAt) || b.track.length - a.track.length)[0];
    const independentEvidenceCount = new Set(evidence.filter((item) => sourceTrust(item.source) >= 85).map((item) => sourceFamily(item.source))).size;
    const confidenceScore = Math.min(99, primary.confidenceScore + Math.min(18, Math.max(0, independentEvidenceCount - 1) * 6));
    const strongestSeverity = [...candidates].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    const entityKey = candidates.map((event) => event.entityKey || processEntityKey(event)).sort((a, b) => entityKeySpecificity(b) - entityKeySpecificity(a))[0];
    return {
      ...primary,
      id: primary.id,
      masterEventId: masterEventId(entityKey, primary.id),
      entityKey,
      evidence,
      evidenceCount: evidence.length,
      severity: strongestSeverity.severity,
      sourceSeverity: strongestSeverity.sourceSeverity,
      updateHistory,
      updateCount: updateHistory.length,
      confidenceScore,
      confidenceLevel: confidenceLevel(confidenceScore),
      latitude: location.latitude,
      longitude: location.longitude,
      geometryType: location.geometryType,
      geometry: location.geometry,
      cycloneForecast,
      locationQuality: location.locationQuality,
      locationAccuracyKm: location.locationAccuracyKm,
      aoiApprovalRequired: location.locationQuality !== "precise",
      dispatchEligibility: location.locationQuality === "precise" ? "ready" as const : "review_required" as const,
      occurredAt: new Date(Math.min(...candidates.map((event) => +new Date(event.occurredAt)))).toISOString(),
      updatedAt: new Date(Math.max(...candidates.map((event) => +new Date(event.updatedAt)))).toISOString(),
      activityAt: new Date(Math.max(...candidates.map((event) => +new Date(event.activityAt || event.occurredAt)))).toISOString(),
    };
  });
}

function severityRank(value: DisasterEvent["severity"]) {
  return { blue: 1, yellow: 2, orange: 3, red: 4 }[value];
}

const mergePolicy: Record<HazardType, { hours: number; kilometers: number }> = {
  earthquake: { hours: 0.5, kilometers: 12 },
  tsunami: { hours: 12, kilometers: 100 },
  wildfire: { hours: 24, kilometers: 5 },
  flood: { hours: 72, kilometers: 50 },
  cyclone: { hours: 48, kilometers: 180 },
  volcano: { hours: 72, kilometers: 30 },
  landslide: { hours: 48, kilometers: 20 },
  drought: { hours: 168, kilometers: 250 },
  dust: { hours: 24, kilometers: 250 },
  ice: { hours: 168, kilometers: 150 },
};

function isSamePhysicalEvent(a: DisasterEvent, b: DisasterEvent) {
  if (a.hazard !== b.hazard) return false;
  if (a.id === b.id && isValidSourceEventId(a.id)) return true;
  const entityA = a.entityKey || processEntityKey(a);
  const entityB = b.entityKey || processEntityKey(b);
  if (sameNamedProcess(entityA, entityB)) return true;
  // Bulletins from the same flood process often change their title as the
  // situation develops (for example, "No. 1 flood" -> "basin-wide flood").
  // Join them before the same-source stable-id guard, but only inside a narrow
  // spatiotemporal window so unrelated annual floods cannot be collapsed.
  if (a.hazard === "flood" && sameFloodRegion(entityA, entityB)) {
    const floodTimeDifference = Math.abs(+new Date(a.occurredAt) - +new Date(b.occurredAt)) / 3_600_000;
    if (floodTimeDifference <= 14 * 24 && distanceKm(a.latitude, a.longitude, b.latitude, b.longitude) <= mergePolicy.flood.kilometers) return true;
  }
  if (sourceFamily(a.source) === sourceFamily(b.source)) {
    const stableA = stablePrimaryId(a.id);
    const stableB = stablePrimaryId(b.id);
    if (stableA === a.id || stableB === b.id || stableA !== stableB) return false;
  }
  // Floods in adjacent rivers can start on the same day and be closer than a
  // coarse AOI accuracy radius. Spatial proximity alone is not an identity
  // signal; require the regional/process identity above.
  if (a.hazard === "flood") return false;
  const policy = mergePolicy[a.hazard];
  const timeDifference = Math.abs(+new Date(a.occurredAt) - +new Date(b.occurredAt)) / 3_600_000;
  return timeDifference <= policy.hours && distanceKm(a.latitude, a.longitude, b.latitude, b.longitude) <= policy.kilometers;
}

function distanceKm(latA: number, lonA: number, latB: number, lonB: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(latB - latA);
  const dLon = radians(lonB - lonA);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function inferLocationProfile(source: string, hazard: HazardType, description?: string): { quality: DisasterEvent["locationQuality"]; accuracyKm: number } {
  if (/太湖流域管理局|江苏省水利厅/.test(source) || /AOI锚点|代表点/.test(description ?? "")) return { quality: "representative", accuracyKm: 100 };
  if (/FIRMS/.test(source) && /0\.25°网格聚合/.test(description ?? "")) return { quality: "estimated", accuracyKm: 20 };
  if (/GDACS|EONET|GloFAS|WMO|Smithsonian|LHASA/.test(source)) return { quality: "estimated", accuracyKm: hazard === "cyclone" ? 25 : hazard === "flood" ? 50 : 20 };
  if (/中国地震台网|USGS|FIRMS|NOAA|JMA|GeoNet/.test(source)) return { quality: "precise", accuracyKm: hazard === "wildfire" ? 1 : hazard === "cyclone" ? 10 : 5 };
  return { quality: "unknown", accuracyKm: 100 };
}

function sourceTrust(source: string) {
  if (/中国地震台网/.test(source)) return 92;
  if (/USGS/.test(source)) return 91;
  if (/NOAA|JMA|GeoNet/.test(source)) return 90;
  if (/FIRMS/.test(source)) return 89;
  if (/GDACS|EONET|WMO|Smithsonian|LHASA/.test(source)) return 78;
  if (/太湖流域管理局|江苏省水利厅/.test(source)) return 62;
  return 68;
}

function eventAuthority(event: DisasterEvent) {
  return sourceTrust(event.source) + locationRank(event.locationQuality) * 4 + Math.min(5, event.evidenceCount);
}

function locationRank(quality: DisasterEvent["locationQuality"]) {
  return { precise: 4, estimated: 3, representative: 2, unknown: 1 }[quality];
}

function evidenceRole(source: string): "detection" | "warning" | "verification" {
  if (/ReliefWeb|Smithsonian/.test(source)) return "verification";
  if (/WMO|NOAA|JMA/.test(source)) return "warning";
  return "detection";
}

function confidenceLevel(score: number): DisasterEvent["confidenceLevel"] {
  return score >= 85 ? "high" : score >= 70 ? "medium" : "low";
}

function stablePrimaryId(id: string) {
  if (id.startsWith("hans-")) return id.replace(/^(hans-[^-]+)-.*$/, "$1");
  return id
    .replace(/-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}-\d{3,4}$/, "");
}

function processEntityKey(event: Pick<DisasterEvent, "hazard" | "title" | "source" | "country" | "occurredAt" | "id">) {
  const year = new Date(event.occurredAt).getUTCFullYear();
  const title = normalizeEntityText(event.title);
  if (event.hazard === "cyclone") {
    const nhcIdentifier = event.id.match(/^nhc-([a-z]{2})(\d{2})(\d{4})(?:-|$)/i);
    if (nhcIdentifier) return `cyclone:${Number(nhcIdentifier[3])}:${nhcIdentifier[1].toLowerCase()}:${Number(nhcIdentifier[2])}`;
    const numbered = event.title.match(/第\s*0?(\d{1,2})\s*号台风\s*[“"'‘]?([^”"'’\s（(，。]{2,20})?/i);
    if (numbered) return `cyclone:${year}:wp:${Number(numbered[1])}${numbered[2] ? `:${cycloneNameAlias(numbered[2])}` : ""}`;
    const international = event.title.match(/(?:tropical\s+(?:cyclone|storm|depression)|typhoon|hurricane|\bTS|\bTD|\bTC|\bPC)\s+[“"']?([a-z][a-z-]{2,}?)(?:-(\d{2,4}))?(?:\s|$)/i);
    if (international) return `cyclone:${international[2] ? normalizeYear(international[2], year) : year}:name:${cycloneNameAlias(international[1])}`;
  }
  if (event.hazard === "flood") {
    const floodKey = floodProcessEntityKey(event);
    if (floodKey) return floodKey;
  }
  if (event.hazard === "volcano") {
    const volcano = event.title.match(/^(.{2,50}?)(?:活动等级升高|火山|\s+volcanic|\s+eruption)/i);
    if (volcano) return `volcano:${normalizeEntityText(volcano[1])}`;
  }
  if (event.hazard === "drought") return `drought:${year}:${Math.floor((new Date(event.occurredAt).getUTCMonth()) / 3)}:${normalizeEntityText(event.country || title)}`;
  return `event:${event.hazard}:${stablePrimaryId(event.id)}`;
}

function normalizeEntityText(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/[“”‘’"'`]/g, "").replace(/[\s·_—–-]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/^-|-$/g, "").slice(0, 80);
}

function cycloneNameAlias(value: string) {
  const normalized = normalizeEntityText(value);
  return ({ "白海豚": "dolphin", "dolphin-26": "dolphin" } as Record<string, string>)[normalized] ?? normalized;
}

function normalizeYear(value: string, fallback: number) {
  const year = Number(value);
  if (!Number.isFinite(year)) return fallback;
  return year < 100 ? 2000 + year : year;
}

function isNamedProcessKey(key: string) {
  return /^(cyclone|flood|volcano|drought):/.test(key);
}

function sameNamedProcess(a: string, b: string) {
  if (a === b && isNamedProcessKey(a)) return true;
  const cycloneA = a.match(/^cyclone:(\d{4}):([^:]+):(\d+)(?::.*)?$/);
  const cycloneB = b.match(/^cyclone:(\d{4}):([^:]+):(\d+)(?::.*)?$/);
  return Boolean(cycloneA && cycloneB && cycloneA[1] === cycloneB[1] && cycloneA[2] === cycloneB[2] && cycloneA[3] === cycloneB[3]);
}

function entityKeySpecificity(key: string) {
  return isNamedProcessKey(key) ? 2 : 1;
}

function masterEventId(entityKey: string, fallbackId: string) {
  return `ME-${isNamedProcessKey(entityKey) ? entityKey : stablePrimaryId(fallbackId)}`;
}

function selectBalancedEvents(events: DisasterEvent[], limit: number) {
  const sorted = [...events].sort(compareEvents);
  if (sorted.length <= limit) return sorted;
  const selected: DisasterEvent[] = [];
  const selectedIds = new Set<string>();
  const hazardCounts = new Map<HazardType, number>();
  const sourceCounts = new Map<string, number>();
  const hazards = [...new Set(sorted.map((event) => event.hazard))];

  const add = (event: DisasterEvent) => {
    if (selectedIds.has(event.id) || selected.length >= limit) return false;
    selected.push(event);
    selectedIds.add(event.id);
    hazardCounts.set(event.hazard, (hazardCounts.get(event.hazard) ?? 0) + 1);
    const source = sourceFamily(event.source);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    return true;
  };

  hazards.forEach((hazard) => sorted.filter((event) => event.hazard === hazard).slice(0, 20).forEach(add));
  for (const event of sorted) {
    if (selected.length >= limit) break;
    const hazardCap = event.hazard === "wildfire" ? 100 : Math.max(35, Math.ceil(limit * 0.28));
    if ((hazardCounts.get(event.hazard) ?? 0) >= hazardCap) continue;
    if ((sourceCounts.get(sourceFamily(event.source)) ?? 0) >= 80) continue;
    add(event);
  }
  return selected.sort(compareEvents);
}

function compareEvents(a: DisasterEvent, b: DisasterEvent) {
  return b.priority - a.priority || +new Date(b.updatedAt) - +new Date(a.updatedAt);
}

function sourceFamily(source: string) {
  return source.split(" · ")[0].trim();
}

function pointFromGeometry(geometry: { type: string; coordinates: unknown }, geometryDates: unknown[] = []): [number, number] | null {
  if (geometry.type === "Point") return coordinatePair(geometry.coordinates);
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    return latestTrackPoint(geometry.coordinates, geometryDates);
  }
  return pointOnGeometry(sanitizeGeometry(geometry));
}

function geometryCenter(coordinates: unknown): [number, number] | null {
  return circularGeometryCenter(coordinates);
}

function coordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  return validCoordinates(latitude, longitude) ? [longitude, latitude] : null;
}

function sanitizeGeometry(geometry: { type: string; coordinates: unknown }): DisasterEvent["geometry"] {
  let vertices = 0;
  const pair = (value: unknown): [number, number] => {
    const parsed = coordinatePair(value);
    if (!parsed || ++vertices > 10_000) throw new Error("几何坐标无效或顶点超过上限");
    return parsed;
  };
  const line = (value: unknown, closed = false) => {
    if (!Array.isArray(value) || value.length < (closed ? 3 : 2) || value.length > 10_000) throw new Error("几何线环结构无效");
    const coordinates = value.map(pair);
    if (closed && (coordinates[0][0] !== coordinates.at(-1)?.[0] || coordinates[0][1] !== coordinates.at(-1)?.[1])) coordinates.push([...coordinates[0]]);
    if (closed && coordinates.length < 4) throw new Error("多边形环顶点不足");
    return coordinates;
  };
  if (geometry.type === "Point") return { type: "Point", coordinates: pair(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: line(geometry.coordinates) };
  if (geometry.type === "Polygon") {
    if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 100) throw new Error("多边形结构无效");
    return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => line(ring, true)) };
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 100) throw new Error("复合多边形结构无效");
    return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => {
      if (!Array.isArray(polygon) || !polygon.length || polygon.length > 100) throw new Error("复合多边形结构无效");
      return polygon.map((ring) => line(ring, true));
    }) };
  }
  throw new Error("不支持的几何类型");
}

function pointOnGeometry(geometry: DisasterEvent["geometry"]): [number, number] | null {
  if (geometry.type === "Point") return coordinatePair(geometry.coordinates);
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) return coordinatePair(geometry.coordinates[geometry.coordinates.length - 1]);
  return geometryCenter(geometry.coordinates);
}

function parseCsv(value: string) {
  const rows = value.trim().split(/\r?\n/).filter(Boolean).map(csvColumns);
  const headers = rows.shift() ?? [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header.trim(), row[index]?.trim() ?? ""])));
}

function csvColumns(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function firmsDate(date: string, time: string) {
  const compact = String(time ?? "").padStart(4, "0");
  const parsed = new Date(`${date}T${compact.slice(0, 2)}:${compact.slice(2)}:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function parseCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().toUpperCase();
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return null;
  return text.endsWith("S") || text.endsWith("W") ? -Math.abs(parsed) : parsed;
}

function firstFinite(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validIso(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function chinaLocalIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  const date = new Date(utc);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function officialColorSeverity(value: string): DisasterEvent["severity"] {
  if (/红|red/i.test(value)) return "red";
  if (/橙|orange/i.test(value)) return "orange";
  if (/黄|yellow/i.test(value)) return "yellow";
  return "blue";
}

function parseCapFeed(xml: string, source: string, sourceUrl: string): DisasterEvent[] {
  const documents = [...xml.matchAll(/<(?:entry|item|alert)(?:\s[^>]*)?>([\s\S]*?)<\/(?:entry|item|alert)>/gi)].map((match) => match[1]);
  return documents.flatMap((document, index) => {
    const messageType = tag(document, "cap:msgType") || tag(document, "msgType");
    const status = tag(document, "cap:status") || tag(document, "status");
    const expiresAt = validIso(tag(document, "cap:expires") || tag(document, "expires"));
    if (/cancel/i.test(messageType) || (expiresAt && +new Date(expiresAt) <= Date.now())) {
      recordCapCancellations(document, source, `CAP ${messageType || "Expire"}`);
      return [];
    }
    if (/update/i.test(messageType)) recordCapCancellations(document, source, "CAP Update superseded referenced alert");
    if (/error|test|exercise/i.test(`${messageType} ${status}`)) return [];
    const capGeometry = capGeometryFromDocument(document);
    const coordinates = capGeometry ? pointOnGeometry(capGeometry) : null;
    if (!coordinates) return [];
    const eventName = decodeXml(tag(document, "cap:event") || tag(document, "event") || tag(document, "cap:headline") || tag(document, "headline") || tag(document, "title"));
    const hazard = textHazard(eventName);
    if (!hazard) return [];
    const severity = tag(document, "cap:severity") || tag(document, "severity") || "Moderate";
    const urgency = tag(document, "cap:urgency") || tag(document, "urgency");
    const certainty = tag(document, "cap:certainty") || tag(document, "certainty");
    const occurredAt = validIso(tag(document, "cap:sent") || tag(document, "sent") || tag(document, "updated") || tag(document, "pubDate")) ?? new Date().toISOString();
    const linkValue = decodeXml(tag(document, "link"));
    const linkHref = document.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
    const identifier = tag(document, "cap:identifier") || tag(document, "identifier") || tag(document, "id") || String(index);
    return [baseEvent({
      id: capSourceEventId(source, identifier),
      title: eventName || `${hazardMeta[hazard].label}预警`,
      hazard,
      latitude: coordinates[1],
      longitude: coordinates[0],
      occurredAt,
      updatedAt: occurredAt,
      source,
      sourceUrl: decodeXml(linkValue || linkHref || sourceUrl),
      sourceSeverity: [severity, urgency, certainty].filter(Boolean).join(" · "),
      severity: normalizeCapSeverity(severity, urgency, certainty),
      geometry: capGeometry ?? undefined,
      country: decodeXml(tag(document, "cap:areaDesc") || tag(document, "areaDesc")),
      description: stripHtml(decodeXml(tag(document, "cap:description") || tag(document, "description"))).slice(0, 260),
    })];
  });
}

function recordCapCancellations(xml: string, source: string, reason: string) {
  const references = decodeXml(tag(xml, "cap:references") || tag(xml, "references"));
  for (const reference of references.split(/\s+/).filter(Boolean)) {
    const parts = reference.split(",");
    const identifier = parts.length >= 2 ? parts[1] : reference;
    if (identifier) cancellationBuffer.push({ source, sourceEventId: capSourceEventId(source, identifier), reason });
  }
}

function capGeometryFromDocument(xml: string): DisasterEvent["geometry"] | null {
  const pointText = tag(xml, "cap:point") || tag(xml, "georss:point") || tag(xml, "point");
  const point = pointText.trim().split(/[\s,]+/).map(Number);
  if (point.length >= 2 && validCoordinates(point[0], point[1])) return { type: "Point", coordinates: [point[1], point[0]] };
  const circle = tag(xml, "cap:circle") || tag(xml, "circle");
  const circleMatch = circle.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?/);
  if (circleMatch) {
    const latitude = Number(circleMatch[1]);
    const longitude = Number(circleMatch[2]);
    const radiusKm = Number(circleMatch[3]);
    if (!validCoordinates(latitude, longitude)) return null;
    if (Number.isFinite(radiusKm) && radiusKm > 0 && radiusKm <= 2_000) return { type: "Polygon", coordinates: [geodesicCircle(latitude, longitude, radiusKm)] };
    return { type: "Point", coordinates: [longitude, latitude] };
  }
  const polygon = tag(xml, "cap:polygon") || tag(xml, "polygon");
  const ring = [...polygon.matchAll(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)].map((match) => [Number(match[2]), Number(match[1])]);
  if (ring.length >= 3) {
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]]);
    return { type: "Polygon", coordinates: [ring] };
  }
  return null;
}

function geodesicCircle(latitude: number, longitude: number, radiusKm: number) {
  const angularDistance = radiusKm / 6371.0088;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  return Array.from({ length: 65 }, (_, index) => {
    const bearing = 2 * Math.PI * index / 64;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
    return [Number((((lon2 * 180 / Math.PI + 540) % 360) - 180).toFixed(6)), Number((lat2 * 180 / Math.PI).toFixed(6))];
  });
}

function capSourceEventId(source: string, identifier: string) {
  if (/NOAA .*海啸/.test(source)) return `noaa-tsunami-${identifier}`;
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${identifier}`;
}

function textHazard(value: string): HazardType | null {
  const text = value.toLowerCase();
  if (/tsunami|海啸|津波/.test(text)) return "tsunami";
  if (/volcan|eruption|volcanic ash|火山|喷发/.test(text)) return "volcano";
  if (/wildfire|forest fire|bushfire|山火|野火|森林火灾|草原火灾/.test(text)) return "wildfire";
  if (/flood|inundation|rainstorm|heavy rain|flash flood|洪|暴雨/.test(text)) return "flood";
  if (/cyclone|hurricane|typhoon|tropical storm|台风|飓风/.test(text)) return "cyclone";
  if (/landslide|mudslide|debris flow|滑坡|泥石流|山崩/.test(text)) return "landslide";
  if (/drought|干旱/.test(text)) return "drought";
  if (/dust|sandstorm|沙尘/.test(text)) return "dust";
  if (/ice|snow|blizzard|冰雪|暴雪/.test(text)) return "ice";
  if (/earthquake|seismic|地震/.test(text)) return "earthquake";
  return null;
}

function eonetHazard(value: string): HazardType | null {
  const v = value.toLowerCase();
  if (v.includes("wildfire")) return "wildfire";
  if (v.includes("flood")) return "flood";
  if (v.includes("storm") || v.includes("cyclone")) return "cyclone";
  if (v.includes("volcano")) return "volcano";
  if (v.includes("landslide")) return "landslide";
  if (v.includes("drought")) return "drought";
  if (v.includes("dust")) return "dust";
  if (v.includes("ice") || v.includes("snow")) return "ice";
  if (v.includes("earthquake")) return "earthquake";
  if (v.includes("tsunami")) return "tsunami";
  return null;
}

function normalizeEonetSeverity(hazard: HazardType, unit: string, magnitude?: number): DisasterEvent["severity"] {
  if (hazard === "earthquake" && /^(m|mw|ml|mb)$/i.test(unit.trim())) return normalizeEarthquakeSeverity(magnitude);
  return "blue";
}

function pickRecordValue(record: Record<string, unknown>, key: string) {
  return record[key];
}

function gdacsHazard(code: string): HazardType | null {
  return ({ EQ: "earthquake", TS: "tsunami", TC: "cyclone", FL: "flood", WF: "wildfire", VO: "volcano", DR: "drought" } as Record<string, HazardType>)[code] ?? null;
}

function parameterValue(xml: string, name: string) {
  const parameters = [...xml.matchAll(/<(?:cap:)?parameter(?:\s[^>]*)?>([\s\S]*?)<\/(?:cap:)?parameter>/gi)].map((match) => match[1]);
  const parameter = parameters.find((item) => decodeXml(tag(item, "valueName")).toLowerCase() === name.toLowerCase());
  return parameter ? decodeXml(tag(parameter, "value")) : "";
}

function validCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectRecords(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 8 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectRecords(item, depth + 1));
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap((item) => collectRecords(item, depth + 1))];
}

function findLatLon(value: unknown): [number, number] | null {
  for (const record of collectRecords(value)) {
    const longitude = firstFinite(record.longitude, record.lon, record.lng, record.x);
    const latitude = firstFinite(record.latitude, record.lat, record.y);
    if (latitude !== null && longitude !== null && validCoordinates(latitude, longitude)) return [longitude, latitude];
    const position = isRecord(record.position) ? record.position : null;
    const degree = position && isRecord(position.deg) ? position.deg : isRecord(record.deg) ? record.deg : null;
    if (degree) {
      const nestedLongitude = firstFinite(degree.longitude, degree.lon, degree.lng, degree.x);
      const nestedLatitude = firstFinite(degree.latitude, degree.lat, degree.y);
      if (nestedLatitude !== null && nestedLongitude !== null && validCoordinates(nestedLatitude, nestedLongitude)) return [nestedLongitude, nestedLatitude];
    }
  }
  return null;
}

function findIsoValue(value: unknown): string | null {
  for (const record of collectRecords(value)) {
    for (const key of ["validtime", "validTime", "reportDatetime", "datetime", "updated", "dateTime", "time"]) {
      const parsed = validIso(record[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function localizedText(value: unknown) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return String(value.zh ?? value.ja ?? value.en ?? value.name ?? "");
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function tag(xml: string, name: string) {
  return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"))?.[1]?.trim() ?? "";
}

function decodeXml(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function fallbackEvents(): DisasterEvent[] {
  const now = Date.now();
  return [
    baseEvent({ id: "demo-eq", title: "西太平洋 M6.2 地震", hazard: "earthquake", latitude: 28.4, longitude: 139.2, occurredAt: new Date(now - 22 * 60_000).toISOString(), updatedAt: new Date().toISOString(), source: "演示数据", sourceUrl: "https://earthquake.usgs.gov/", sourceSeverity: "M6.2", severity: "orange", magnitude: 6.2, magnitudeUnit: "Mw", description: "实时源不可用时展示的回退事件。" }),
    baseEvent({ id: "demo-fire", title: "北美西部森林火灾", hazard: "wildfire", latitude: 49.1, longitude: -119.6, occurredAt: new Date(now - 70 * 60_000).toISOString(), updatedAt: new Date().toISOString(), source: "演示数据", sourceUrl: "https://eonet.gsfc.nasa.gov/", sourceSeverity: "监测中", severity: "yellow", description: "实时源不可用时展示的回退事件。" }),
    baseEvent({ id: "demo-cyclone", title: "西北太平洋热带气旋", hazard: "cyclone", latitude: 18.2, longitude: 126.7, occurredAt: new Date(now - 2 * 3_600_000).toISOString(), updatedAt: new Date().toISOString(), source: "演示数据", sourceUrl: "https://www.gdacs.org/", sourceSeverity: "Orange", severity: "orange", description: "实时源不可用时展示的回退事件。" }),
  ];
}
