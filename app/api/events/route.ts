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
  type PhenomenonStage,
} from "../../../lib/disasters";
import { normalizeAntimeridianGeometry, validateGeoGeometry } from "../../../lib/geo-geometry";
import { latestByKey } from "../../../lib/latest-by-key";
import { applyEventSourcePresence } from "../../../lib/event-presence";
import { getForecastRasterProduct, listRetainedCanonicalEvents, persistCanonicalEvents, persistIngestionArtifacts, resolveCanonicalEventsByReferences, upsertForecastRasterProduct, type SourceFetchCapture } from "../../../db/operational";
import { circularGeometryCenter, cycloneSeverityFromKnots, firmsConfidenceScore, firmsHeatSeverity, latestTrackPoint } from "../../../lib/source-normalization";
import { authorizeApiRequest } from "../../../lib/api-security";
import { buildHourlyCycloneImpactField, buildJmaCycloneForecast, extractKmlFromKmz, parseNhcConeKml, parseNhcTrackKml, parseNhcWindRadiiKml } from "../../../lib/cyclone-forecast";
import { eventHasInvalidIdentity, firstValidSourceEventId, isValidSourceEventId, latestEventVersionsByMasterId } from "../../../lib/event-integrity";
import { updateIngestionHealth } from "../../../lib/runtime-health";
import { floodProcessEntityKey, sameFloodRegion } from "../../../lib/process-identity";
import { selectFirmsEvents } from "../../../lib/event-selection";
import {
  buildCmaSurfaceRequestUrl,
  cmaSurfaceConfiguration,
  CMA_SURFACE_PUBLIC_URL,
  CMA_SURFACE_SOURCE,
  isCmaSurfaceSource,
  parseCmaSurfacePayload,
} from "../../../lib/cma-surface";
import {
  parseCopernicusActivations,
  parseEcccAlerts,
  parseEmscEvents,
  parseNwsAlerts,
  type PublicEventCandidate,
} from "../../../lib/public-event-sources";
import {
  combinePolygonGeometries,
  geoJsonBoundaryGeometry,
  nveWarningBoundaryKeys,
  parseNveLandslideWarning,
  parseUsgsGroundFailureDetails,
} from "../../../lib/landslide-sources";
import { parseMemGeohazardBulletin, parseMemGeohazardListing } from "../../../lib/china-geohazard-sources";
import { coarsenLhasaRiskRaster, decodeLhasaRiskPng, lhasaCandidatesFromRaster, summarizeLhasaRiskRaster } from "../../../lib/lhasa-nowcast";
import { storeForecastRasterObject } from "../../../lib/forecast-raster-storage";
import { amapConfiguration, buildAmapGeocodeUrl, parseAmapGeocodes, type RoutingCoordinate } from "../../../lib/amap-routing";
import { assessImpactRisk } from "../../../lib/impact-risk";
import { sanitizeSnapshotUrl, sourceGovernance, sourceIdForName, sourceNameForUrl, type SourceGovernance, type SourceRole, type SourceTier } from "../../../lib/source-governance";

export const dynamic = "force-dynamic";

const endpoints = {
  cenc: "https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_subao",
  taihu: "https://www.tba.gov.cn/",
  jiangsuWater: "https://jswater.jiangsu.gov.cn/",
  usgs: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
  usgsGroundFailure: "https://earthquake.usgs.gov/fdsnws/event/1/query",
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
  memGeohazards: "https://www.mem.gov.cn/xw/yjglbgzdt/",
  lhasaImages: "https://pmmpublisher.pps.eosdis.nasa.gov/img/lhasa_v2/",
  nveLandslide: "https://api01.nve.no/hydrology/forecast/landslide/v1.0.10/api/Warning/2",
  nveBoundary: "https://api.kartverket.no/kommuneinfo/v1",
  reliefWeb: "https://api.reliefweb.int/v2/disasters",
  nwsAlerts: "https://api.weather.gov/alerts/active",
  emsc: "https://www.seismicportal.eu/fdsnws/event/1/query",
  ecccAlerts: "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500&filter=properties.status_en%3C%3E%27ended%27",
  copernicusRapidMapping: "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/",
};

type SourceState = "online" | "offline" | "needs_config";

type SourceConnector = {
  name: string;
  tier: SourceTier;
  role: SourceRole;
  setupUrl: string;
  config?: { ready: boolean; message: string };
  successMessage?: string;
  fetcher: () => Promise<DisasterEvent[]>;
};

type SourceRun = SourceGovernance & {
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
  durationMs: number;
  attempts: number;
  lastAttemptAt: string;
};

type CancellationReference = { source: string; sourceEventId: string; reason: string };
const cancellationBuffer: CancellationReference[] = [];
type EventsCacheEntry = { body: string; status: number; contentType: string; expiresAt: number; etag: string };
let eventsCache: EventsCacheEntry | null = null;
let eventsRefresh: Promise<EventsCacheEntry> | null = null;
let lastSuccessfulFetchAt: string | null = null;
let copernicusCache: { events: DisasterEvent[]; expiresAt: number } | null = null;
let usgsGroundFailureCache: { events: DisasterEvent[]; expiresAt: number } | null = null;
const nveBoundaryCache = new Map<string, { geometry: { type: string; coordinates: unknown }; expiresAt: number }>();
const memGeocodeCache = new Map<string, { coordinate: RoutingCoordinate; expiresAt: number }>();
let activeRefreshId: string | null = null;
const sourceFetchCaptureBuffer: SourceFetchCapture[] = [];

export async function GET(request: Request) {
  const unauthorized = await authorizeApiRequest(request);
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

function cachedEventsResponse(cached: EventsCacheEntry, request: Request) {
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
  const refreshId = crypto.randomUUID();
  activeRefreshId = refreshId;
  sourceFetchCaptureBuffer.splice(0);
  const cmaSurface = cmaSurfaceConfiguration();
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
      name: "应急管理部地质灾害快报",
      tier: "中国第一批",
      role: "事件",
      setupUrl: endpoints.memGeohazards,
      successMessage: "在线；仅把含明确发生时间和受影响地的官方灾情通报作为实况，地名编码点仍要求人工复核 AOI",
      fetcher: fetchMemGeohazards,
    },
    {
      name: "中国气象数据网 CMA 预警",
      tier: "中国第二批",
      role: "事件",
      setupUrl: "https://data.cma.cn/",
      config: {
        ready: Boolean(process.env.CMA_EVENT_FEED_URL),
        message: "注册并获授权后配置 CMA_EVENT_FEED_URL（CAP 或 GeoJSON）",
      },
      fetcher: fetchCmaEventFeed,
    },
    {
      name: "中国气象数据网 CMA · 地面观测",
      tier: "中国第二批",
      role: "核验",
      setupUrl: CMA_SURFACE_PUBLIC_URL,
      config: { ready: cmaSurface.ready, message: cmaSurface.message },
      successMessage: "在线；逐三小时资料约滞后2天，只核验时空匹配的既有洪水/台风，不独立生成任务",
      fetcher: fetchCmaSurface,
    },
    { name: "USGS", tier: "基础", role: "事件", setupUrl: "https://earthquake.usgs.gov/earthquakes/feed/", fetcher: fetchUsgs },
    {
      name: "USGS Ground Failure",
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://earthquake.usgs.gov/data/ground-failure/",
      successMessage: "在线；只纳入黄色及以上震生滑坡概率产品，模型覆盖框不冒充已发生滑坡边界，任务必须人工复核",
      fetcher: fetchUsgsGroundFailure,
    },
    {
      name: "EMSC SeismicPortal",
      tier: "第一优先级",
      role: "核验",
      setupUrl: "https://www.seismicportal.eu/fdsn-wsevent.html",
      successMessage: "在线；M4.5+近实时目录作为地震独立证据，与USGS/CENC按时空阈值聚合",
      fetcher: fetchEmsc,
    },
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
      name: "NOAA/NWS Alerts",
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://www.weather.gov/documentation/services-web-api",
      successMessage: "在线；仅纳入带官方面几何且可遥感观测的生效告警，告警区下发前需人工复核",
      fetcher: fetchNwsAlerts,
    },
    {
      name: "ECCC GeoMet Alerts",
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://eccc-msc.github.io/open-data/msc-data/alerts/readme_alerts-geomet_en/",
      successMessage: "在线；仅纳入带官方面几何且可遥感观测的加拿大生效告警，告警区不冒充受灾边界",
      fetcher: fetchEcccAlerts,
    },
    {
      name: "NVE Jordskredvarsling",
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://api.nve.no/doc/jordskredvarsling/",
      successMessage: "在线；仅纳入2级及以上生效预警，并用 Kartverket 官方市县边界构建预警面，不冒充滑坡影响边界",
      fetcher: fetchNveLandslideWarnings,
    },
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
    {
      name: "Copernicus EMS Rapid Mapping",
      tier: "第二优先级",
      role: "核验",
      setupUrl: "https://mapping.emergency.copernicus.eu/about/how-to-harvest-cems-mapping-data/emergency-response-data/",
      successMessage: "在线；官方AOI用于成像与制图任务核验，不把AOI边界冒充最终受灾范围",
      fetcher: fetchCopernicusRapidMapping,
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
      tier: "第一优先级",
      role: "预报",
      setupUrl: "https://pmmpublisher.pps.eosdis.nasa.gov/precip-apps/",
      successMessage: "在线；读取带官方批次时间的 LHASA nowcast，仅在24小时有效期内产出80%以上模型风险区，不代表灾害已发生且禁止自动下发",
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
  if (runs.some((run) => run.producing && run.role !== "核验")) lastSuccessfulFetchAt = refreshCompletedAt;
  const cancellations = cancellationBuffer.splice(0);
  const collected = runs.flatMap((run) => run.events).filter(isOperationalEventValid);
  const currentEvents = canonicalizeEvents(collected.filter((event) => !eventHasInvalidIdentity(event)))
    .filter((event) => event.evidence.some((item) => !isCmaSurfaceSource(item.source)))
    .map(finalize);
  // Merge the last persisted event and evidence snapshot before writing the new
  // batch. Otherwise a transient source outage would overwrite a multi-source
  // evidence chain with the one source that happened to answer this refresh.
  const retained = await listRetainedEventsSafely();
  const normalized = canonicalizeEvents([...currentEvents, ...retained]).map(finalize);
  const liveEvidence = new Set(currentEvents.flatMap((event) => event.evidence.map((item) => `${sourceFamily(item.source)}|${item.sourceEventId}`)));
  const normalizedWithPresence = normalized.map((event) => {
    const presentInCurrentFeeds = event.evidence.some((item) => liveEvidence.has(`${sourceFamily(item.source)}|${item.sourceEventId}`));
    return applyEventSourcePresence(event, presentInCurrentFeeds);
  });
  const allSourcesUnavailable = runs.every((source) => !source.online);
  const sourceCounts = runs.map((run) => ({
    name: run.name,
    sourceId: run.sourceId,
    tier: run.tier,
    role: run.role,
    authorityClass: run.authorityClass,
    pollIntervalMinutes: run.pollIntervalMinutes,
    latencySloMinutes: run.latencySloMinutes,
    updateSemantics: run.updateSemantics,
    geometrySemantics: run.geometrySemantics,
    licenseNote: run.licenseNote,
    setupUrl: run.setupUrl,
    state: run.state,
    online: run.online,
    message: run.message,
    producing: run.producing,
    durationMs: run.durationMs,
    attempts: run.attempts,
    lastAttemptAt: run.lastAttemptAt,
    lastSuccessAt: run.online ? run.lastAttemptAt : null,
    count: currentEvents.filter((event) => event.evidence.some((item) => item.source.startsWith(run.name))).length,
  }));
  const persistedEvents = allSourcesUnavailable ? normalizedWithPresence : await persistCanonicalEvents(normalizedWithPresence);
  const persistenceAvailable = persistedEvents !== null;
  if (cancellations.length) {
    const byReason = new Map<string, CancellationReference[]>();
    cancellations.forEach((item) => byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]));
    for (const [reason, items] of byReason) await resolveCanonicalEventsByReferences(items, reason);
  }
  updateIngestionHealth({
    lastAttemptAt: refreshCompletedAt,
    lastSuccessAt: lastSuccessfulFetchAt,
    configuredSources: runs.filter((run) => run.state !== "needs_config").length,
    totalSources: runs.length,
    onlineSources: runs.filter((run) => run.online).length,
    producingSources: runs.filter((run) => run.producing).length,
    eventCapableSources: runs.filter((run) => run.producing && run.role !== "核验").length,
    persistenceAvailable,
  });
  const operationalEvents = latestEventVersionsByMasterId(persistedEvents ?? normalizedWithPresence).map((event) => {
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
  const selectedEvents = selectBalancedEvents(operationalEvents.filter((event) => event.observationStatus !== "expired" && event.lifecycleStatus !== "resolved"), 250);
  const events = selectedEvents;
  const retainedCount = events.filter((event) => event.sourcePresence === "retained").length;
  const fallback = allSourcesUnavailable ? fallbackEvents().map(finalize) : [];
  const fallbackSourceCounts = allSourcesUnavailable
    ? sourceCounts.map((source) => ({ ...source, count: 0 }))
    : sourceCounts;

  const responsePayload = {
      events: allSourcesUnavailable ? (events.length ? events : fallback) : events,
      sourceStatus: fallbackSourceCounts,
      hazardCounts,
      fetchedAt: refreshCompletedAt,
      lastSuccessfulFetchAt,
      producingSourceCount: runs.filter((run) => run.producing).length,
      fallback: allSourcesUnavailable,
      expiredCount: currentEvents.filter((event) => event.observationStatus === "expired").length,
      processedCount: currentEvents.length,
      retainedCount,
      persistenceAvailable,
      selectionPolicy: { limit: 250, reservedPerHazard: 20, wildfireCap: 100, perSourceCap: 80, firmsIngestionCap: 600, firmsSpatialReserveDegrees: 5 },
      windowPolicyVersion: "2026.08-science-v5",
      runtimeMode: allSourcesUnavailable ? "缓存/兜底" : "实时",
    };
  try {
    const replayPayload = boundedReplayPayload(responsePayload);
    const replayJson = JSON.stringify(replayPayload);
    const snapshotHash = await sha256Text(replayJson);
    await persistIngestionArtifacts({
      refreshId,
      sources: runs.map((run) => ({
        sourceId: run.sourceId,
        name: run.name,
        tier: run.tier,
        role: run.role,
        authorityClass: run.authorityClass,
        setupUrl: run.setupUrl,
        pollIntervalMinutes: run.pollIntervalMinutes,
        latencySloMinutes: run.latencySloMinutes,
        updateSemantics: run.updateSemantics,
        geometrySemantics: run.geometrySemantics,
        licenseNote: run.licenseNote,
        state: run.state,
        lastAttemptAt: run.lastAttemptAt,
        durationMs: run.durationMs,
        count: run.count,
        message: run.message,
      })),
      fetches: sourceFetchCaptureBuffer.splice(0),
      snapshot: {
        snapshotId: `snapshot-${refreshId}`,
        refreshId,
        capturedAt: refreshCompletedAt,
        payloadSha256: snapshotHash,
        eventCount: Array.isArray(replayPayload.events) ? replayPayload.events.length : 0,
        sourceCount: runs.length,
        payload: replayPayload,
      },
    });
  } catch (error) {
    console.error("ingestion governance persistence unavailable", error);
  } finally {
    activeRefreshId = null;
    sourceFetchCaptureBuffer.splice(0);
  }

  return Response.json(
    responsePayload,
    { headers: { "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } },
  );
}

function boundedReplayPayload(payload: Record<string, unknown>) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  let retainedEvents = events;
  let replay = { ...payload, events: retainedEvents, replaySnapshotTruncated: false };
  while (new TextEncoder().encode(JSON.stringify(replay)).byteLength > 650_000 && retainedEvents.length > 25) {
    retainedEvents = retainedEvents.slice(0, Math.ceil(retainedEvents.length * 0.75));
    replay = { ...payload, events: retainedEvents, replaySnapshotTruncated: true };
  }
  return replay;
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
  const startedAt = Date.now();
  const lastAttemptAt = new Date(startedAt).toISOString();
  const governance = sourceGovernance(connector.name, connector.tier, connector.role);
  if (connector.config && !connector.config.ready) {
    return { ...connector, ...governance, state: "needs_config", online: false, producing: false, count: 0, message: connector.config.message, events: [], durationMs: 0, attempts: 0, lastAttemptAt };
  }
  let attempts = 1;
  try {
    let events: DisasterEvent[];
    try {
      events = await connector.fetcher();
    } catch (firstError) {
      if (!isTransientConnectorError(firstError)) throw firstError;
      await new Promise((resolve) => setTimeout(resolve, 350));
      attempts = 2;
      events = await connector.fetcher();
    }
    return {
      ...connector,
      ...governance,
      state: "online",
      online: true,
      producing: events.length > 0,
      count: events.length,
      message: connector.successMessage ?? (connector.role === "核验"
        ? "在线，仅用于交叉核验，不生成任务坐标"
        : events.length ? "在线并产出本轮有效事件" : "连接成功，但本轮没有通过时间、身份与几何校验的有效事件"),
      events,
      durationMs: Date.now() - startedAt,
      attempts,
      lastAttemptAt,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 90) : "未知错误";
    return { ...connector, ...governance, state: "offline", online: false, producing: false, count: 0, message: `本轮连接失败：${reason}`, events: [], durationMs: Date.now() - startedAt, attempts, lastAttemptAt };
  }
}

function isTransientConnectorError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|eai_again|HTTP (?:408|425|429|5\d\d)|\b(?:408|425|429|5\d\d)\b/i.test(message);
}

const officialUserAgent = "Tianxun-Disaster-Watch/0.1 github.com/STU-Jankin/tianxun-disaster-watch";

async function fetchJson(url: string, options: { maximumBytes?: number; timeoutMs?: number; headers?: Record<string, string>; sourceName?: string; archive?: boolean } = {}) {
  const startedAt = Date.now();
  const safeUrl = validateExternalFeedUrl(url);
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/json,application/geo+json", "User-Agent": officialUserAgent, ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    redirect: "manual",
  });
  if (!response.ok) {
    if (options.archive !== false) await recordSourceFetch(url, response, "", startedAt, `上游返回 HTTP ${response.status}`, options.sourceName);
    throw new Error(`上游返回 HTTP ${response.status}`);
  }
  const body = await readLimitedText(response, options.maximumBytes ?? 5_000_000, "JSON");
  if (options.archive !== false) await recordSourceFetch(url, response, body, startedAt, null, options.sourceName);
  return JSON.parse(body);
}

async function fetchText(url: string) {
  const startedAt = Date.now();
  const safeUrl = validateExternalFeedUrl(url);
  const response = await fetch(safeUrl, {
    headers: {
      Accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Tianxun-Disaster-Watch/0.1",
    },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) {
    await recordSourceFetch(url, response, "", startedAt, `上游返回 HTTP ${response.status}`);
    throw new Error(`上游返回 HTTP ${response.status}`);
  }
  const body = await readLimitedText(response, 5_000_000, "文本");
  await recordSourceFetch(url, response, body, startedAt, null);
  return body;
}

async function recordSourceFetch(url: string, response: Response, body: string, startedAt: number, errorMessage: string | null, explicitSourceName?: string) {
  if (!activeRefreshId) return;
  const encoded = new TextEncoder().encode(body);
  const maximumStoredBytes = 128 * 1024;
  const storedBody = encoded.byteLength > maximumStoredBytes
    ? new TextDecoder().decode(encoded.slice(0, maximumStoredBytes))
    : body;
  const payloadSha256 = body ? await sha256Text(body) : null;
  const sourceName = sourceNameForUrl(url, explicitSourceName);
  sourceFetchCaptureBuffer.push({
    runId: crypto.randomUUID(),
    refreshId: activeRefreshId,
    sourceId: sourceIdForName(sourceName),
    requestedUrl: sanitizeSnapshotUrl(url),
    fetchedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    httpStatus: response.status,
    ok: response.ok && !errorMessage,
    payloadSha256,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    bodyText: storedBody,
    byteLength: encoded.byteLength,
    storedByteLength: new TextEncoder().encode(storedBody).byteLength,
    truncated: encoded.byteLength > maximumStoredBytes,
    errorMessage,
  });
}

async function sha256Text(value: string) {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchKmzKml(url: string) {
  const startedAt = Date.now();
  const safeUrl = validateExternalFeedUrl(url, ["nhc.noaa.gov", "www.nhc.noaa.gov"]);
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/vnd.google-earth.kmz,application/zip", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 6_000_000) throw new Error("KMZ 文件超过安全上限");
  const bytes = await readLimitedBytes(response, 6_000_000, "KMZ");
  await recordBinarySourceFetch(url, response, bytes, startedAt, "NOAA NHC");
  return extractKmlFromKmz(bytes);
}

async function recordBinarySourceFetch(url: string, response: Response, body: ArrayBuffer, startedAt: number, explicitSourceName?: string) {
  const payloadSha256 = await sha256Bytes(body);
  if (!activeRefreshId) return payloadSha256;
  const sourceName = sourceNameForUrl(url, explicitSourceName);
  const bodyText = "[二进制响应仅保存摘要；请按来源和抓取时刻获取原始文件]";
  sourceFetchCaptureBuffer.push({
    runId: crypto.randomUUID(), refreshId: activeRefreshId, sourceId: sourceIdForName(sourceName),
    requestedUrl: sanitizeSnapshotUrl(url), fetchedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - startedAt),
    httpStatus: response.status, ok: response.ok, payloadSha256,
    contentType: response.headers.get("content-type") ?? "application/octet-stream", bodyText, byteLength: body.byteLength,
    storedByteLength: new TextEncoder().encode(bodyText).byteLength, truncated: true, errorMessage: null,
  });
  return payloadSha256;
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
  return [...html.matchAll(/<tr[^>]*id=["']earthquake_subao_guid_catalog_tr_([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/gi)]
    .flatMap((match) => {
      const catalogId = firstValidSourceEventId(match[1]);
      const cellHtml = [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
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
        id: `cenc-${catalogId ?? `${occurredAt}-${latitude.toFixed(3)}-${longitude.toFixed(3)}`}`,
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

async function fetchMemGeohazards(): Promise<DisasterEvent[]> {
  const listing = parseMemGeohazardListing(await fetchText(endpoints.memGeohazards));
  const details = await Promise.allSettled(listing.map(async (item) => parseMemGeohazardBulletin(await fetchText(item.url), item.url)));
  const bulletins = details.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  const coordinates = new Map<string, RoutingCoordinate>();
  await Promise.all([...new Set(bulletins.map((bulletin) => bulletin.locationQuery))].map(async (location) => {
    const coordinate = await resolveMemGeohazardCoordinate(location);
    if (coordinate) coordinates.set(location, coordinate);
  }));
  return bulletins.flatMap((bulletin): DisasterEvent[] => {
    const coordinate = coordinates.get(bulletin.locationQuery);
    if (!coordinate) return [];
    return [publicCandidateEvent({
      sourceEventId: bulletin.sourceEventId,
      title: bulletin.title,
      hazard: "landslide",
      hazardSubtype: bulletin.hazardSubtype,
      geometry: { type: "Point", coordinates: coordinate },
      occurredAt: bulletin.occurredAt,
      updatedAt: bulletin.updatedAt,
      activityAt: bulletin.updatedAt,
      issuedAt: bulletin.updatedAt,
      phenomenonStage: "observed",
      sourceUrl: bulletin.sourceUrl,
      sourceSeverity: bulletin.sourceSeverity,
      severity: bulletin.severity,
      country: bulletin.country,
      originCountry: bulletin.originCountry,
      affectedCountries: bulletin.affectedCountries,
      crossBorder: bulletin.crossBorder,
      description: bulletin.description,
      requiresReview: true,
    }, "应急管理部地质灾害快报", "mem-geohazard")];
  });
}

async function resolveMemGeohazardCoordinate(location: string): Promise<RoutingCoordinate | null> {
  const cached = memGeocodeCache.get(location);
  if (cached && cached.expiresAt > Date.now()) return cached.coordinate;
  const configuration = amapConfiguration();
  if (configuration.ready && configuration.config) {
    try {
      const payload = await fetchJson(buildAmapGeocodeUrl(configuration.config, location), { maximumBytes: 1_000_000, timeoutMs: 8_000, archive: false });
      const geocode = parseAmapGeocodes(payload)[0];
      if (geocode) {
        memGeocodeCache.set(location, { coordinate: geocode.coordinate, expiresAt: Date.now() + 30 * 86_400_000 });
        return geocode.coordinate;
      }
    } catch (error) {
      console.warn(`MEM geocode fallback used (${location})`, error instanceof Error ? error.message : "geocode unavailable");
    }
  }
  // 仅作为官方地名代表点兜底；坐标由高德兴趣点结果近似归一为 WGS84，
  // 事件仍是 Point + review_required，绝不把该点冒充泥石流边界。
  if (/吉隆口岸/.test(location)) return [85.377307, 28.280317];
  return null;
}

async function fetchCmaEventFeed(): Promise<DisasterEvent[]> {
  const url = process.env.CMA_EVENT_FEED_URL;
  if (!url) return [];
  const safeUrl = validateExternalFeedUrl(url);
  const authorization = process.env.CMA_EVENT_FEED_AUTHORIZATION?.trim();
  const startedAt = Date.now();
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/geo+json,application/json,application/xml,text/xml", "User-Agent": "Tianxun-Disaster-Watch/0.1", ...(authorization ? { Authorization: authorization } : {}) },
    signal: AbortSignal.timeout(12_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} CMA`);
  const body = await readLimitedText(response, 5_000_000, "CMA");
  await recordSourceFetch(url, response, body, startedAt, null, "中国气象数据网 CMA 预警");
  if (/^\s*</.test(body)) return parseCapFeed(body, "中国气象数据网 CMA 预警", publicSourceUrl(url, "https://data.cma.cn/"));
  const data = JSON.parse(body) as { features?: Array<{ id?: string | number; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> };
  return (data.features ?? []).flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const title = String(properties.title ?? properties.event ?? properties.name ?? "气象灾害预警");
    const hazard = textHazard(title);
    const issuedAt = validIso(properties.issuedAt ?? properties.sent ?? properties.datetime ?? properties.date);
    const validFrom = validIso(properties.onset ?? properties.effective ?? properties.validFrom) ?? issuedAt;
    const validTo = validIso(properties.expires ?? properties.ends ?? properties.validTo);
    if (!hazard || !issuedAt || !validFrom || (validTo && +new Date(validTo) <= Date.now())) return [];
    let geometry: DisasterEvent["geometry"];
    try {
      if (!feature.geometry?.type || feature.geometry.coordinates === undefined) return [];
      geometry = sanitizeGeometry({ type: feature.geometry.type, coordinates: feature.geometry.coordinates });
    } catch {
      return [];
    }
    const center = pointOnGeometry(geometry);
    if (!center) return [];
    const sourceSeverity = String(properties.severity ?? properties.level ?? properties.color ?? "气象预警");
    return [baseEvent({
      id: `cma-${String(feature.id ?? properties.id ?? index)}-${issuedAt}`,
      title,
      hazard,
      latitude: center[1],
      longitude: center[0],
      occurredAt: issuedAt,
      updatedAt: validIso(properties.updatedAt ?? properties.updated) ?? issuedAt,
      activityAt: issuedAt,
      issuedAt,
      validFrom,
      validTo: validTo ?? undefined,
      phenomenonStage: "warning",
      source: "中国气象数据网 CMA 预警",
      sourceUrl: String(properties.url ?? url),
      sourceSeverity,
      severity: officialColorSeverity(sourceSeverity),
      geometry,
      country: String(properties.area ?? properties.location ?? "中国"),
      description: String(properties.description ?? "来自已授权CMA业务接口；仅接收带点位或面几何、且遥感可直接或间接观测的事件。"),
    })];
  });
}

async function fetchCmaSurface(): Promise<DisasterEvent[]> {
  const configuration = cmaSurfaceConfiguration();
  if (!configuration.ready || !configuration.config) return [];
  const requestUrl = buildCmaSurfaceRequestUrl(configuration.config);
  let response: Response;
  const startedAt = Date.now();
  try {
    response = await fetch(requestUrl, {
      headers: { Accept: "application/json", "User-Agent": "Tianxun-Disaster-Watch/0.1" },
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
  } catch {
    throw new Error("CMA 地面观测请求失败；未记录含凭据的请求地址");
  }
  if (!response.ok) throw new Error(`CMA 地面观测返回 HTTP ${response.status}`);
  const body = await readLimitedText(response, 5_000_000, "CMA 地面观测");
  await recordSourceFetch(requestUrl, response, body, startedAt, null, CMA_SURFACE_SOURCE);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("CMA 地面观测返回了无效 JSON");
  }
  return parseCmaSurfacePayload(payload, configuration.config.timeZone).map((candidate) => baseEvent({
    ...candidate,
    source: CMA_SURFACE_SOURCE,
    sourceUrl: CMA_SURFACE_PUBLIC_URL,
    severity: "blue",
  }));
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

async function fetchUsgsGroundFailure(): Promise<DisasterEvent[]> {
  if (usgsGroundFailureCache && usgsGroundFailureCache.expiresAt > Date.now()) return usgsGroundFailureCache.events;
  const overviewUrl = new URL(endpoints.usgsGroundFailure);
  overviewUrl.search = new URLSearchParams({
    format: "geojson",
    producttype: "ground-failure",
    starttime: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    orderby: "time",
    limit: "12",
  }).toString();
  const overview = await fetchJson(overviewUrl.toString(), { maximumBytes: 3_000_000, timeoutMs: 12_000 }) as { features?: unknown[] };
  const ids = (Array.isArray(overview.features) ? overview.features : [])
    .flatMap((feature) => feature && typeof feature === "object" && !Array.isArray(feature) && typeof (feature as { id?: unknown }).id === "string"
      ? [(feature as { id: string }).id]
      : [])
    .filter((id) => isValidSourceEventId(id));
  if (!ids.length) {
    usgsGroundFailureCache = { events: [], expiresAt: Date.now() + 10 * 60_000 };
    return [];
  }
  const details = await Promise.allSettled(ids.map((eventId) => {
    const detailUrl = new URL(endpoints.usgsGroundFailure);
    detailUrl.search = new URLSearchParams({ eventid: eventId, format: "geojson" }).toString();
    return fetchJson(detailUrl.toString(), { maximumBytes: 4_000_000, timeoutMs: 12_000 });
  }));
  const fulfilled = details.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!fulfilled.length) throw new Error("USGS Ground Failure 详情均读取失败");
  const candidates = fulfilled.flatMap((payload) => parseUsgsGroundFailureDetails(payload));
  const events = candidates.map((candidate) => publicCandidateEvent(candidate, "USGS Ground Failure", "usgs-ground-failure"));
  usgsGroundFailureCache = { events, expiresAt: Date.now() + 10 * 60_000 };
  return events;
}

async function fetchEmsc(): Promise<DisasterEvent[]> {
  const start = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const params = new URLSearchParams({ format: "json", starttime: start, minmag: "4.5", orderby: "time", limit: "100" });
  return parseEmscEvents(await fetchJson(`${endpoints.emsc}?${params}`, { maximumBytes: 4_000_000, timeoutMs: 10_000 }))
    .map((candidate) => publicCandidateEvent(candidate, "EMSC SeismicPortal", "emsc"));
}

async function fetchNwsAlerts(): Promise<DisasterEvent[]> {
  const payload = await fetchJson(endpoints.nwsAlerts, {
    maximumBytes: 15_000_000,
    timeoutMs: 12_000,
    headers: { Accept: "application/geo+json" },
  });
  return parseNwsAlerts(payload).map((candidate) => publicCandidateEvent(candidate, "NOAA/NWS Alerts", "nws"));
}

async function fetchEcccAlerts(): Promise<DisasterEvent[]> {
  const payload = await fetchJson(endpoints.ecccAlerts, { maximumBytes: 15_000_000, timeoutMs: 12_000 });
  return parseEcccAlerts(payload).map((candidate) => publicCandidateEvent(candidate, "ECCC GeoMet Alerts", "eccc"));
}

async function fetchNveLandslideWarnings(): Promise<DisasterEvent[]> {
  const payload = await fetchJson(endpoints.nveLandslide, { maximumBytes: 5_000_000, timeoutMs: 12_000 });
  if (!Array.isArray(payload)) throw new Error("NVE 返回结构异常");
  const warnings = payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((warning) => Number(warning.ActivityLevel) >= 2)
    .slice(0, 16);
  if (!warnings.length) return [];
  const boundaryKeys = [...new Map(warnings.flatMap(nveWarningBoundaryKeys).map((key) => [`${key.kind}:${key.id}`, key])).values()].slice(0, 64);
  const boundaryResults = await Promise.allSettled(boundaryKeys.map(fetchNveBoundary));
  const boundaries = new Map(boundaryKeys.flatMap((key, index) => {
    const result = boundaryResults[index];
    return result.status === "fulfilled" && result.value ? [[`${key.kind}:${key.id}`, result.value] as const] : [];
  }));
  const boundaryFailures = boundaryResults.filter((result) => result.status === "rejected").length;
  const candidates: PublicEventCandidate[] = [];
  for (const warning of warnings) {
    const geometries = nveWarningBoundaryKeys(warning).flatMap((key) => boundaries.get(`${key.kind}:${key.id}`) ?? []);
    const candidate = parseNveLandslideWarning(warning, combinePolygonGeometries(geometries));
    if (candidate) candidates.push(candidate);
  }
  if (!candidates.length && boundaryFailures) throw new Error("NVE 有生效预警，但 Kartverket 官方边界读取失败");
  return candidates.map((candidate) => publicCandidateEvent(candidate, "NVE Jordskredvarsling", "nve-landslide"));
}

async function fetchNveBoundary(key: { kind: "kommuner" | "fylker"; id: string }) {
  const cacheKey = `${key.kind}:${key.id}`;
  const cached = nveBoundaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.geometry;
  const path = `${key.kind}/${encodeURIComponent(key.id)}/omrade`;
  let payload: unknown;
  try {
    payload = await fetchJson(`${endpoints.nveBoundary}/${path}`, { maximumBytes: 4_000_000, timeoutMs: 7_000, headers: { Accept: "application/geo+json,application/json" } });
  } catch {
    payload = await fetchJson(`https://ws.geonorge.no/kommuneinfo/v1/${path}`, { maximumBytes: 4_000_000, timeoutMs: 7_000, headers: { Accept: "application/geo+json,application/json" } });
  }
  const geometry = geoJsonBoundaryGeometry(payload);
  if (!geometry) throw new Error(`Kartverket ${cacheKey} 几何无效`);
  nveBoundaryCache.set(cacheKey, { geometry, expiresAt: Date.now() + 7 * 86_400_000 });
  return geometry;
}

async function fetchCopernicusRapidMapping(): Promise<DisasterEvent[]> {
  if (copernicusCache && copernicusCache.expiresAt > Date.now()) return copernicusCache.events;
  const listUrl = new URL(endpoints.copernicusRapidMapping);
  listUrl.search = new URLSearchParams({ limit: "30", ordering: "-lastUpdate" }).toString();
  const overview = await fetchJson(listUrl.toString(), { maximumBytes: 3_000_000, timeoutMs: 12_000 }) as { results?: unknown[] };
  const recent = (Array.isArray(overview.results) ? overview.results : []).filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (typeof record.code !== "string") return false;
    const updated = validIso(record.lastUpdate ?? record.activationTime);
    return !record.closed || Boolean(updated && Date.now() - +new Date(updated) <= 7 * 86_400_000);
  }).slice(0, 8);
  const details = await Promise.allSettled(recent.map((item) => {
    const url = new URL("https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/");
    url.searchParams.set("code", String(item.code));
    return fetchJson(url.toString(), { maximumBytes: 12_000_000, timeoutMs: 15_000 });
  }));
  const records = details.flatMap((result) => result.status === "fulfilled" && result.value && typeof result.value === "object" && Array.isArray((result.value as { results?: unknown }).results)
    ? (result.value as { results: unknown[] }).results
    : []);
  const candidates = parseCopernicusActivations({ results: records.length ? records : recent });
  // One malformed third-party AOI must not take the whole official connector
  // offline. Invalid records are rejected individually by the shared topology
  // gate; valid activations from the same response remain available.
  const events = candidates.flatMap((candidate) => {
    try {
      return [publicCandidateEvent(candidate, "Copernicus EMS Rapid Mapping", "copernicus-ems")];
    } catch (error) {
      console.warn(`Copernicus EMS activation skipped (${candidate.sourceEventId})`, error instanceof Error ? error.message : "invalid geometry");
      return [];
    }
  });
  copernicusCache = { events, expiresAt: Date.now() + 15 * 60_000 };
  return events;
}

function publicCandidateEvent(candidate: PublicEventCandidate, source: string, prefix: string) {
  const geometry = sanitizeGeometry(candidate.geometry);
  const center = pointOnGeometry(geometry);
  if (!center) throw new Error(`${source} 几何中心无效`);
  const event = baseEvent({
    id: `${prefix}-${candidate.sourceEventId}`,
    title: candidate.title,
    hazard: candidate.hazard,
    hazardSubtype: candidate.hazardSubtype,
    latitude: center[1],
    longitude: center[0],
    occurredAt: candidate.occurredAt,
    updatedAt: candidate.updatedAt,
    activityAt: candidate.activityAt,
    issuedAt: candidate.issuedAt,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    phenomenonStage: candidate.phenomenonStage,
    source,
    sourceUrl: candidate.sourceUrl,
    sourceSeverity: candidate.sourceSeverity,
    severity: candidate.severity,
    magnitude: candidate.magnitude,
    magnitudeUnit: candidate.magnitudeUnit,
    geometry,
    country: candidate.country,
    originCountry: candidate.originCountry,
    affectedCountries: candidate.affectedCountries,
    crossBorder: candidate.crossBorder,
    description: candidate.description,
  });
  return candidate.requiresReview
    ? { ...event, aoiApprovalRequired: true, dispatchEligibility: "review_required" as const }
    : event;
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
    const occurredAt = validIso(p.date);
    if (!occurredAt) return [];
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
  const startedAt = Date.now();
  const response = await fetch(endpoints.gdacs, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(8_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} GDACS`);
  const xml = await readLimitedText(response, 5_000_000, "GDACS");
  await recordSourceFetch(endpoints.gdacs, response, xml, startedAt, null, "GDACS");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match, index) => {
    const item = match[1];
    const typeCode = tag(item, "gdacs:eventtype");
    const hazard = gdacsHazard(typeCode);
    const point = tag(item, "georss:point").trim().split(/\s+/).map(Number);
    if (!hazard || point.length < 2 || point.some(Number.isNaN)) return [];
    const sourceSeverity = tag(item, "gdacs:alertlevel") || "Green";
    const occurredAt = validIso(tag(item, "pubDate"));
    if (!occurredAt) return [];
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
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`${response.status} FIRMS`);
  const body = await readLimitedText(response, 8_000_000, "FIRMS");
  await recordSourceFetch(url, response, body, startedAt, null, "NASA FIRMS");
  const rows = parseCsv(body);
  const cells = new Map<string, Array<Record<string, string>>>();
  rows.forEach((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      const cell = `${Math.round(latitude * 10) / 10},${Math.round(longitude * 10) / 10}`;
    cells.set(cell, [...(cells.get(cell) ?? []), row]);
  });
  const events = [...cells.entries()]
    .flatMap(([cell, detections]): DisasterEvent[] => {
      const latitude = detections.reduce((sum, row) => sum + Number(row.latitude), 0) / detections.length;
      const longitude = detections.reduce((sum, row) => sum + Number(row.longitude), 0) / detections.length;
      const newest = detections.sort((a, b) => String(b.acq_date + b.acq_time).localeCompare(String(a.acq_date + a.acq_time)))[0];
      const occurredAt = firmsDate(newest.acq_date, newest.acq_time);
      if (!occurredAt) return [];
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
        description: `同一0.1°网格聚合 ${detections.length} 个VIIRS近实时热异常（置信度 ${confidenceCode || "未知"}）；它不是已确认森林火灾，必须结合地表覆盖、常年热源和其他证据复核。`,
      });
      const detectionConfidence = Math.min(event.confidenceScore, confidence);
      return [{ ...event, confidenceScore: detectionConfidence, confidenceLevel: confidenceLevel(detectionConfidence), observable: "conditional" as const, dispatchEligibility: "review_required" as const, aoiApprovalRequired: true }];
    });
  // A global VIIRS day can contain tens of thousands of 0.1° cells. Keeping
  // every low-confidence cell makes canonicalization and SQLite persistence
  // monopolize the single web process for minutes. Preserve broad geographic
  // coverage first, then fill the remaining budget with the strongest cells.
  return selectFirmsEvents(events, 600);
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
    const occurredAt = validIso(storm.lastUpdate ?? publicAdvisory.issuance ?? storm.advisoryDate);
    if (!occurredAt) return null;
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
      activityAt: occurredAt,
      issuedAt: cycloneForecast?.issuedAt ?? occurredAt,
      validFrom: occurredAt,
      validTo: cycloneForecast?.forecastValidUntil,
      phenomenonStage: "observed",
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
    activityAt: updatedAt,
    issuedAt: updatedAt,
    validFrom: validIso(tag(xml, "effective") || tag(xml, "onset")) ?? updatedAt,
    validTo: expiresAt ?? undefined,
    phenomenonStage: "warning",
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
    activityAt: cycloneForecast?.issuedAt ?? occurredAt,
    issuedAt: cycloneForecast?.issuedAt ?? occurredAt,
    validFrom: occurredAt,
    validTo: cycloneForecast?.forecastValidUntil,
    phenomenonStage: "observed",
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
    const sentUnixTime = Number(notice.sent_unixtime);
    if (!Number.isFinite(sentUnixTime) || sentUnixTime <= 0) return null;
    const occurredAt = new Date(sentUnixTime * 1000).toISOString();
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
  const startedAt = Date.now();
  const response = await fetch(endpoints.geonetVolcanoes, {
    headers: {
      Accept: "application/vnd.geo+json;version=2,application/geo+json,application/json",
      "User-Agent": "Tianxun-Disaster-Watch/0.1",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`${response.status} GeoNet`);
  const body = await readLimitedText(response, 2_000_000, "GeoNet");
  await recordSourceFetch(endpoints.geonetVolcanoes, response, body, startedAt, null, "GeoNet 火山警戒");
  const data = JSON.parse(body) as { type?: string; features?: unknown[] };
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("GeoNet 返回结构异常");
  // 该端点提供当前警戒状态，但不提供警戒开始/更新时间。这里仅验证数据可用性，
  // 不把响应时间伪造成灾害发生时间，也不生成卫星任务坐标。
  return [];
}

async function fetchSmithsonianVolcanoes(): Promise<DisasterEvent[]> {
  const startedAt = Date.now();
  const response = await fetch(endpoints.smithsonianVolcanoes, {
    headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${response.status} Smithsonian GVP`);
  const body = await readLimitedText(response, 2_000_000, "Smithsonian GVP");
  await recordSourceFetch(endpoints.smithsonianVolcanoes, response, body, startedAt, null, "Smithsonian GVP");
  return [];
}

async function fetchLhasa(): Promise<DisasterEvent[]> {
  for (let dayOffset = 0; dayOffset <= 4; dayOffset += 1) {
    const productDate = new Date(Date.now() - dayOffset * 86_400_000);
    const date = `${productDate.getUTCFullYear()}${String(productDate.getUTCMonth() + 1).padStart(2, "0")}${String(productDate.getUTCDate()).padStart(2, "0")}`;
    const productTime = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00.000Z`;
    const imageUrl = `${endpoints.lhasaImages}global_landslide_nowcast_${date}.0000_float.png`;
    const startedAt = Date.now();
    const response = await fetch(imageUrl, {
      headers: { Accept: "image/png", "User-Agent": officialUserAgent },
      signal: AbortSignal.timeout(8_000),
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.startsWith("image/png")) {
      await response.body?.cancel();
      continue;
    }
    if (Date.now() >= Date.parse(productTime) + 24 * 3_600_000) {
      await response.body?.cancel();
      return [];
    }
    const image = await readLimitedBytes(response, 2_000_000, "LHASA PNG");
    const payloadSha256 = await recordBinarySourceFetch(imageUrl, response, image, startedAt, "NASA LHASA");
    const fullResolutionRaster = await decodeLhasaRiskPng(image, 1);
    const raster = coarsenLhasaRiskRaster(fullResolutionRaster, 5);
    const productId = `lhasa-${date}-0000`;
    try {
      const existing = await getForecastRasterProduct(productId);
      if (!existing || existing.payloadSha256 !== payloadSha256) {
        const storageKey = `lhasa/${date.slice(0, 4)}/${date.slice(4, 6)}/global_landslide_nowcast_${date}.0000_float-${payloadSha256.slice(0, 12)}.png`;
        const storageBackend = await storeForecastRasterObject({
          storageKey,
          bytes: image,
          contentType: "image/png",
          metadata: { source: "NASA LHASA", productTime, payloadSha256 },
        });
        await upsertForecastRasterProduct({
          productId,
          sourceId: sourceIdForName("NASA LHASA"),
          productTime,
          validFrom: productTime,
          validTo: new Date(Date.parse(productTime) + 24 * 3_600_000).toISOString(),
          sourceUrl: imageUrl,
          payloadSha256,
          storageKey,
          storageBackend,
          contentType: "image/png",
          byteLength: image.byteLength,
          sourceWidth: fullResolutionRaster.sourceWidth,
          sourceHeight: fullResolutionRaster.sourceHeight,
          groupPixels: fullResolutionRaster.groupPixels,
          gridWidth: fullResolutionRaster.width,
          gridHeight: fullResolutionRaster.height,
          summary: summarizeLhasaRiskRaster(fullResolutionRaster),
          archivedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      // Archival quality is reported separately. A temporary storage problem
      // must not suppress the current high-risk event feed.
      console.error("LHASA complete probability archive failed", error);
    }
    return lhasaCandidatesFromRaster(raster, productTime, imageUrl).map((candidate) => publicCandidateEvent(candidate, "NASA LHASA", "lhasa"));
  }
  throw new Error("LHASA 最近5天没有可识别的官方批次 PNG");
}

async function fetchWmoCap(): Promise<DisasterEvent[]> {
  const url = process.env.WMO_CAP_FEED_URL;
  if (!url) return [];
  const safeUrl = validateExternalFeedUrl(url);
  const startedAt = Date.now();
  const response = await fetch(safeUrl, { headers: { "User-Agent": "Tianxun-Disaster-Watch/0.1" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  if (!response.ok) throw new Error(`${response.status} WMO CAP`);
  const xml = await readLimitedText(response, 5_000_000, "WMO CAP");
  await recordSourceFetch(url, response, xml, startedAt, null, "WMO SWIC/CAP");
  return parseCapFeed(xml, "WMO SWIC/CAP", publicSourceUrl(url, "https://severeweather.wmo.int/feeds.html"));
}

async function fetchGlofas(): Promise<DisasterEvent[]> {
  const url = process.env.GLOFAS_EVENT_FEED_URL;
  if (!url) return [];
  const data = await fetchJson(url, { sourceName: "Copernicus GloFAS" }) as { features?: Array<{ id?: string | number; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> };
  return (data.features ?? []).flatMap((feature) => {
    const p = feature.properties ?? {};
    const issuedAt = validIso(p.issuedAt ?? p.issued_at ?? p.datetime ?? p.date);
    const forecastAt = validIso(p.onset ?? p.validFrom ?? p.valid_from ?? p.forecastStart ?? p.forecast_start ?? p.forecastTime);
    const validTo = validIso(p.validTo ?? p.valid_to ?? p.forecastEnd ?? p.forecast_end ?? p.expires);
    if (!issuedAt || !forecastAt || !validTo || +new Date(validTo) <= Date.now() || +new Date(validTo) <= +new Date(forecastAt)) return [];
    let geometry: DisasterEvent["geometry"];
    try {
      if (!feature.geometry?.type || feature.geometry.coordinates === undefined) return [];
      geometry = sanitizeGeometry({ type: feature.geometry.type, coordinates: feature.geometry.coordinates });
    } catch {
      return [];
    }
    const center = pointOnGeometry(geometry);
    if (!center) return [];
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
      issuedAt,
      validFrom: forecastAt,
      validTo,
      phenomenonStage: "forecast",
      source: "Copernicus GloFAS",
      sourceUrl: String(p.url ?? "https://global-flood.emergency.copernicus.eu/"),
      sourceSeverity: `${returnPeriod ? `预测重现期 ${returnPeriod} 年` : String(p.severity ?? "洪水预报")}${probability === null ? "" : ` · 超阈概率 ${(probability * 100).toFixed(0)}%`}`,
      severity,
      geometry,
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

function baseEvent(input: Omit<DisasterEvent, "masterEventId" | "entityKey" | "lifecycleStatus" | "sourcePresence" | "evidence" | "evidenceCount" | "updateHistory" | "updateCount" | "confidenceScore" | "confidenceLevel" | "geometryType" | "geometry" | "activityAt" | "issuedAt" | "validFrom" | "validTo" | "phenomenonStage" | "locationQuality" | "locationAccuracyKm" | "aoiApprovalRequired" | "dispatchEligibility" | "observable" | "observationTargets" | "recommendedSensors" | "scope" | "priority" | "priorityBreakdown" | "observationGoldenHours" | "observationWindowHours" | "observationReviewAt" | "observationExpiresAt" | "observationHardReviewAt" | "observationReferenceAt" | "observationRationale" | "observationPolicyVersion" | "observationPhase" | "observationStatus"> & {
  geometry?: DisasterEvent["geometry"];
  activityAt?: string;
  issuedAt?: string;
  validFrom?: string;
  validTo?: string;
  phenomenonStage?: PhenomenonStage;
}): DisasterEvent {
  const meta = hazardMeta[input.hazard];
  const subtypeTargets = input.hazard === "landslide" && input.hazardSubtype === "debris_flow"
    ? ["冲淤范围", "沟道堆积体", "堵江", "道路桥梁损毁"]
    : input.hazard === "landslide" && input.hazardSubtype === "rockfall"
      ? ["崩塌源区", "落石堆积", "道路阻断"]
      : meta.targets;
  const location = inferLocationProfile(input.source, input.hazard, input.description);
  const confidenceScore = sourceTrust(input.source) - (location.quality === "representative" ? 18 : location.quality === "estimated" ? 8 : 0);
  const geometry = input.geometry ?? { type: "Point" as const, coordinates: [input.longitude, input.latitude] };
  const phenomenonStage = input.phenomenonStage ?? "observed";
  const hasDispatchableArea = geometry.type === "Polygon" || geometry.type === "MultiPolygon" || Boolean(input.cycloneForecast?.impactGeometry);
  const sourceReady = phenomenonStage === "observed" && location.quality === "precise" && hasDispatchableArea && meta.observable !== "conditional";
  return {
    ...input,
    activityAt: input.activityAt ?? input.occurredAt,
    issuedAt: input.issuedAt ?? input.updatedAt,
    validFrom: input.validFrom,
    validTo: input.validTo,
    phenomenonStage,
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
    independentSourceCount: 1,
    bulletinCount: 1,
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
    geometryType: geometry.type,
    geometry,
    locationQuality: location.quality,
    locationAccuracyKm: location.accuracyKm,
    aoiApprovalRequired: !sourceReady,
    dispatchEligibility: sourceReady ? "ready" : "review_required",
    observable: meta.observable,
    observationTargets: subtypeTargets,
    recommendedSensors: meta.sensors,
    scope: "global",
    priority: 0,
    priorityBreakdown: { severity: 0, scope: 0, observability: 0, time: 0, confidence: 0 },
    observationGoldenHours: 0,
    observationWindowHours: 0,
    observationReviewAt: input.updatedAt,
    observationExpiresAt: input.updatedAt,
    observationHardReviewAt: input.updatedAt,
    observationReferenceAt: input.occurredAt,
    observationRationale: "尚未应用观测期策略",
    observationPolicyVersion: "2026.08-science-v5",
    observationPhase: "golden",
    observationStatus: sourceReady ? "actionable" : "review_required",
  };
}

function finalize(event: DisasterEvent): DisasterEvent {
  const scope = classifyScope(event.latitude, event.longitude, `${event.country ?? ""} ${event.title}`);
  const timeline = getObservationTimeline(
    event.occurredAt,
    event.activityAt,
    event.hazard,
    event.severity,
    {
      phenomenonStage: event.phenomenonStage ?? "observed",
      issuedAt: event.issuedAt ?? event.updatedAt,
      validFrom: event.validFrom,
      validTo: event.validTo,
      forecastValidUntil: event.cycloneForecast?.forecastValidUntil,
      hazardSubtype: event.hazardSubtype,
      targets: event.observationTargets,
      sensors: event.recommendedSensors,
    },
  );
  // 对持续型已观测过程使用上游“实质活动时间”计算时效；预报/预警仍由
  // calculateTimeScore 内部使用权威发布时间与有效期，缓存读取时间不会续期。
  const priorityReferenceAt = event.phenomenonStage === "observed" ? event.activityAt : event.occurredAt;
  const priority = calculatePriority(event.severity, scope, event.hazard, priorityReferenceAt, event.observable, event.confidenceScore, {
    phenomenonStage: event.phenomenonStage ?? "observed",
    issuedAt: event.issuedAt ?? event.updatedAt,
    validFrom: event.validFrom,
  });
  const policyNeedsReview = timeline.requiresReview;
  return {
    ...event,
    impactRisk: assessImpactRisk(event),
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
    observationHardReviewAt: timeline.hardReviewAt,
    observationReferenceAt: timeline.referenceAt,
    observationRationale: timeline.rationale,
    observationPolicyVersion: "2026.08-science-v5",
    observationPhase: timeline.phase,
    observationStatus: timeline.phase === "archive" ? "expired" : policyNeedsReview ? "review_required" : "actionable",
    dispatchEligibility: policyNeedsReview && event.dispatchEligibility === "ready" ? "review_required" : event.dispatchEligibility,
    aoiApprovalRequired: policyNeedsReview || event.aoiApprovalRequired,
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
    const latestCandidates = latestByKey(
      candidates,
      (event) => `${sourceFamily(event.source)}|${stablePrimaryId(event.id)}`,
      (event) => Date.parse(event.updatedAt),
    );
    const authoritativeCandidates = latestCandidates.filter((event) => !isCmaSurfaceSource(event.source));
    const canonicalCandidates = authoritativeCandidates.length ? authoritativeCandidates : latestCandidates;
    const primary = [...canonicalCandidates].sort((a, b) => eventAuthority(b) - eventAuthority(a) || +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    const evidence = latestByKey(
      candidates.flatMap((event) => event.evidence),
      (item) => `${sourceFamily(item.source)}|${item.sourceEventId}`,
      (item) => Date.parse(item.observedAt),
    );
    const updateHistory = [...new Map(candidates.flatMap((event) => event.updateHistory?.length ? event.updateHistory : event.evidence.map((item) => ({
      ...item,
      title: event.title,
      sourceSeverity: event.sourceSeverity,
    })))
      .sort((a, b) => +new Date(b.observedAt) - +new Date(a.observedAt))
      .map((item) => [`${sourceFamily(item.source)}|${item.sourceEventId}|${item.observedAt}|${item.sourceSeverity}`, item])).values()].slice(0, 100);
    const location = [...canonicalCandidates].sort((a, b) => locationRank(b.locationQuality) - locationRank(a.locationQuality) || a.locationAccuracyKm - b.locationAccuracyKm)[0];
    const cycloneForecast = candidates.flatMap((event) => event.cycloneForecast ? [event.cycloneForecast] : [])
      .sort((a, b) => +new Date(b.issuedAt) - +new Date(a.issuedAt) || b.track.length - a.track.length)[0];
    const independentEvidenceCount = new Set(evidence
      .filter((item) => sourceTrust(item.source) >= 85 && item.role !== "driver" && item.role !== "context")
      .map((item) => sourceFamily(item.source))).size;
    const confidenceScore = Math.min(99, primary.confidenceScore + Math.min(18, Math.max(0, independentEvidenceCount - 1) * 6));
    const strongestSeverity = [...candidates].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    const temporal = [...canonicalCandidates].sort((a, b) => +new Date(b.issuedAt ?? b.updatedAt) - +new Date(a.issuedAt ?? a.updatedAt))[0];
    const phenomenonStage = [...canonicalCandidates]
      .sort((a, b) => phenomenonStageRank(b.phenomenonStage ?? "observed") - phenomenonStageRank(a.phenomenonStage ?? "observed") || +new Date(b.updatedAt) - +new Date(a.updatedAt))[0]
      .phenomenonStage ?? "observed";
    const entityKey = candidates.map((event) => event.entityKey || processEntityKey(event)).sort((a, b) => entityKeySpecificity(b) - entityKeySpecificity(a))[0];
    return {
      ...primary,
      id: primary.id,
      masterEventId: masterEventId(entityKey, primary.id),
      entityKey,
      evidence,
      evidenceCount: evidence.length,
      independentSourceCount: new Set(evidence.map((item) => sourceFamily(item.source))).size,
      bulletinCount: updateHistory.length,
      // Current status follows the newest snapshot from the most authoritative
      // event source; a later context-only catalogue must not overwrite it.
      severity: primary.severity,
      sourceSeverity: primary.sourceSeverity,
      peakSeverity: strongestSeverity.severity,
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
      aoiApprovalRequired: location.aoiApprovalRequired,
      dispatchEligibility: location.dispatchEligibility,
      issuedAt: temporal.issuedAt ?? temporal.updatedAt,
      validFrom: temporal.validFrom,
      validTo: temporal.validTo,
      phenomenonStage,
      occurredAt: new Date(Math.min(...candidates.map((event) => +new Date(event.occurredAt)))).toISOString(),
      updatedAt: new Date(Math.max(...candidates.map((event) => +new Date(event.updatedAt)))).toISOString(),
      activityAt: new Date(Math.max(...candidates.map((event) => +new Date(event.activityAt || event.occurredAt)))).toISOString(),
    };
  });
}

function phenomenonStageRank(value: PhenomenonStage) {
  return { driver: 1, context: 2, forecast: 3, warning: 4, observed: 5 }[value];
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
  const surfaceObservation = isCmaSurfaceSource(a.source) ? a : isCmaSurfaceSource(b.source) ? b : null;
  const authoritativeEvent = surfaceObservation === a ? b : surfaceObservation === b ? a : null;
  if (surfaceObservation && authoritativeEvent && !isCmaSurfaceSource(authoritativeEvent.source)) {
    // A nearby station observation is a driver/verification signal, not proof
    // that it belongs to this disaster. Attach it only after an upstream source
    // supplies an explicit correlation identity (not available in this feed).
    return false;
  }
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
  if (isCmaSurfaceSource(source)) return { quality: "precise", accuracyKm: 2 };
  if (/太湖流域管理局|江苏省水利厅/.test(source) || /AOI锚点|代表点/.test(description ?? "")) return { quality: "representative", accuracyKm: 100 };
  if (/FIRMS/.test(source) && /0\.1°网格聚合/.test(description ?? "")) return { quality: "estimated", accuracyKm: 8 };
  if (/NWS Alerts|ECCC GeoMet|NVE Jordskredvarsling/.test(source)) return { quality: "precise", accuracyKm: 1 };
  if (/应急管理部地质灾害快报/.test(source)) return { quality: "representative", accuracyKm: 5 };
  if (/USGS Ground Failure|GDACS|EONET|GloFAS|WMO|Smithsonian|LHASA/.test(source)) return { quality: "estimated", accuracyKm: hazard === "cyclone" ? 25 : hazard === "flood" ? 50 : 20 };
  if (/中国地震台网|USGS|EMSC|FIRMS|NOAA|JMA|GeoNet|Copernicus EMS Rapid Mapping/.test(source)) return { quality: "precise", accuracyKm: hazard === "wildfire" ? 1 : hazard === "cyclone" ? 10 : 5 };
  return { quality: "unknown", accuracyKm: 100 };
}

function sourceTrust(source: string) {
  if (isCmaSurfaceSource(source)) return 88;
  if (/中国气象数据网 CMA 预警/.test(source)) return 90;
  if (/中国地震台网/.test(source)) return 92;
  if (/应急管理部地质灾害快报/.test(source)) return 95;
  if (/USGS/.test(source)) return 91;
  if (/EMSC/.test(source)) return 90;
  if (/NVE Jordskredvarsling/.test(source)) return 90;
  if (/ECCC GeoMet/.test(source)) return 90;
  if (/Copernicus EMS Rapid Mapping/.test(source)) return 88;
  if (/NOAA|JMA|GeoNet/.test(source)) return 90;
  if (/FIRMS/.test(source)) return 89;
  if (/GDACS|EONET|WMO|Smithsonian|LHASA/.test(source)) return 78;
  if (/太湖流域管理局|江苏省水利厅/.test(source)) return 62;
  return 68;
}

function eventAuthority(event: DisasterEvent) {
  return sourceTrust(event.source) + locationRank(event.locationQuality) * 4 + Math.min(5, event.evidenceCount) - (isCmaSurfaceSource(event.source) ? 30 : 0);
}

function locationRank(quality: DisasterEvent["locationQuality"]) {
  return { precise: 4, estimated: 3, representative: 2, unknown: 1 }[quality];
}

function evidenceRole(source: string): "detection" | "warning" | "verification" | "driver" | "context" {
  if (isCmaSurfaceSource(source)) return "driver";
  if (/ReliefWeb|Smithsonian|Copernicus EMS|LHASA/.test(source)) return "context";
  if (/应急管理部地质灾害快报/.test(source)) return "detection";
  if (/EMSC|GeoNet/.test(source)) return "verification";
  if (/USGS Ground Failure|NVE Jordskredvarsling|WMO|NOAA|JMA|ECCC|CMA 预警/.test(source)) return "warning";
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
  let sanitized: DisasterEvent["geometry"];
  if (geometry.type === "Point") sanitized = { type: "Point", coordinates: pair(geometry.coordinates) };
  else if (geometry.type === "LineString") sanitized = { type: "LineString", coordinates: line(geometry.coordinates) };
  else if (geometry.type === "Polygon") {
    if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 100) throw new Error("多边形结构无效");
    sanitized = { type: "Polygon", coordinates: geometry.coordinates.map((ring) => line(ring, true)) };
  }
  else if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 100) throw new Error("复合多边形结构无效");
    sanitized = { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => {
      if (!Array.isArray(polygon) || !polygon.length || polygon.length > 100) throw new Error("复合多边形结构无效");
      return polygon.map((ring) => line(ring, true));
    }) };
  } else throw new Error("不支持的几何类型");
  const normalized = sanitized.type === "Polygon" || sanitized.type === "MultiPolygon"
    ? normalizeAntimeridianGeometry(sanitized)
    : sanitized;
  if (!normalized || !validateGeoGeometry(normalized, {
    maximumVertices: 10_000,
    maximumRingVertices: 2_000,
    maximumAreaKm2: 100_000_000,
    rejectUnsplitAntimeridian: normalized.type !== "LineString",
  }).ok) throw new Error("几何拓扑无效、自相交或面积超出安全范围");
  return normalized as DisasterEvent["geometry"];
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

function firmsDate(date: string, time: string): string | null {
  const compact = String(time ?? "").padStart(4, "0");
  const parsed = new Date(`${date}T${compact.slice(0, 2)}:${compact.slice(2)}:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
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

function isOperationalEventValid(event: DisasterEvent) {
  const dates = [event.occurredAt, event.updatedAt, event.activityAt, event.issuedAt];
  if (!event || !Object.hasOwn(hazardMeta, event.hazard) || !["red", "orange", "yellow", "blue"].includes(event.severity)) return false;
  if (!event.title?.trim() || event.title.length > 500 || !event.source?.trim() || event.source.length > 240) return false;
  if (!validCoordinates(event.latitude, event.longitude) || dates.some((value) => !Number.isFinite(Date.parse(value)))) return false;
  if (Date.parse(event.updatedAt) < Date.parse(event.occurredAt) - 366 * 86_400_000) return false;
  if (event.validFrom && !Number.isFinite(Date.parse(event.validFrom))) return false;
  if (event.validTo && (!Number.isFinite(Date.parse(event.validTo)) || (event.validFrom && Date.parse(event.validTo) <= Date.parse(event.validFrom)))) return false;
  if (!validateGeoGeometry(event.geometry, {
    maximumVertices: 10_000,
    maximumRingVertices: 2_000,
    maximumAreaKm2: 100_000_000,
    rejectUnsplitAntimeridian: event.geometry.type !== "LineString",
    allowOverlappingMultiPolygon: event.hazard === "cyclone",
  }).ok) return false;
  return !eventHasInvalidIdentity(event);
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
    const issuedAt = validIso(tag(document, "cap:sent") || tag(document, "sent") || tag(document, "updated") || tag(document, "pubDate"));
    if (!issuedAt) return [];
    const validFrom = validIso(tag(document, "cap:onset") || tag(document, "onset") || tag(document, "cap:effective") || tag(document, "effective")) ?? issuedAt;
    const linkValue = decodeXml(tag(document, "link"));
    const linkHref = document.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
    const identifier = tag(document, "cap:identifier") || tag(document, "identifier") || tag(document, "id") || String(index);
    return [baseEvent({
      id: capSourceEventId(source, identifier),
      title: eventName || `${hazardMeta[hazard].label}预警`,
      hazard,
      latitude: coordinates[1],
      longitude: coordinates[0],
      occurredAt: issuedAt,
      updatedAt: issuedAt,
      activityAt: issuedAt,
      issuedAt,
      validFrom,
      validTo: expiresAt ?? undefined,
      phenomenonStage: "warning",
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
    if (Number.isFinite(radiusKm) && radiusKm > 0 && radiusKm <= 2_000) {
      try { return sanitizeGeometry({ type: "Polygon", coordinates: [geodesicCircle(latitude, longitude, radiusKm)] }); } catch { return null; }
    }
    return { type: "Point", coordinates: [longitude, latitude] };
  }
  const polygon = tag(xml, "cap:polygon") || tag(xml, "polygon");
  const ring = [...polygon.matchAll(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)].map((match) => [Number(match[2]), Number(match[1])]);
  if (ring.length >= 3) {
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]]);
    try { return sanitizeGeometry({ type: "Polygon", coordinates: [ring] }); } catch { return null; }
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
  if (/flood|inundation|flash flood|洪水|山洪|内涝/.test(text)) return "flood";
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
