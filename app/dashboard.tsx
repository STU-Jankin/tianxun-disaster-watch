"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hazardMeta,
  hazardSubtypeLabels,
  isVisibleInScope,
  observationWindowPolicy,
  scopes,
  type DisasterEvent,
  type HazardType,
  type ScopeId,
} from "../lib/disasters";
import { allowedOperatorTaskStatuses, canTransitionTask, safeHttpUrl, validateSatelliteTask } from "../lib/task-contract";
import { buildTaskAoi, customAoiPartCount, normalizeCustomAoiGeoJson, type AoiPolygonCoordinates, type CustomAoiGeometry, type GeoGeometry } from "../lib/task-aoi";
import { aoiFingerprint, eventRevisionFingerprint, latestEventVersionsByMasterId } from "../lib/event-integrity";
import { cycloneTaskAoiSlices, cycloneUncertaintyGeometry, cycloneWindGeometry, type CycloneTaskAoiSlice } from "../lib/cyclone-forecast";
import { weatherImagingWindows, type WeatherForecastReady, type WeatherForecastResponse } from "../lib/qweather";
import { compactSatelliteTaskForSync } from "../lib/task-sync";
import { mergeTaskVersions, sameOperatorTaskContent } from "../lib/task-version-conflict";
import { antimeridianOutlineGeometry } from "../lib/geo-geometry";
import {
  defaultResponseEndpoints,
  planRoadResponseScenario,
  planResponseScenario,
  responseRouteStatusLabel,
  responseScenarioGeoJson,
  type ResponseCoordinate,
  type ResponseScenario,
} from "../lib/response-routing";
import { amapTravelModeLabels, type AmapRoadRoutingResponse, type AmapTravelMode } from "../lib/amap-routing";
import { isRoadDisruptionList, normalizeRoadDisruptionGeoJson, roadDisruptionFeatureCollection, roadDisruptionKindLabel, type RoadDisruption, type RoadDisruptionRegistryEntry } from "../lib/response-disruptions";
import { infrastructureKindLabel, isInfrastructureAssessment, type InfrastructureAssessment } from "../lib/osm-infrastructure";
import { deriveLandslideWorkflow, landslideSarTemplates, type LandslideSarTemplate, type LandslideTerrainResult, type LandslideTerrainScreening } from "../lib/landslide-planning";
import { sarImagingModeOptions, sarPayloadProfiles, type SarImagingModeId } from "../lib/satellite-payloads";
import { cycloneTrackingGeometry, cycloneTrackingSliceAt, nearestCycloneFrameIndex, type CycloneTrackingTarget } from "../lib/cyclone-tracking-target";
import type { MissionPlanningProblem, MissionPlanningSummary, PlanningConstraintAssessment } from "../lib/mission-planning";
import { emptySchedulingManualRules, schedulingOpportunityRef, type MultiTaskSchedule, type SchedulingComparison, type SchedulingManualRules } from "../lib/mission-scheduler";
import { planningScenarioMatchesProblems, planningScenarioSummary, type PlanningScenarioRecord, type PlanningScenarioSummary } from "../lib/planning-scenarios";
import { exposureFacilityKindLabel, type ExposureAssessment, type ExposureFacilityKind } from "../lib/exposure-assessment";
import { assessImpactRisk } from "../lib/impact-risk";
import type { MissionExecutionReceipt } from "../lib/mission-execution";
import type { ObservationProduct } from "../lib/stac-products";
import type { AoiWorkPackage, AoiWorkPackageAction } from "../lib/aoi-work-packages";

type ApiResponse = {
  events: DisasterEvent[];
  sourceStatus: SourceStatus[];
  hazardCounts: Array<{ hazard: string; count: number }>;
  fetchedAt: string;
  fallback: boolean;
  expiredCount: number;
  processedCount: number;
  retainedCount: number;
  selectionPolicy: { limit: number; reservedPerHazard: number; wildfireCap: number; perSourceCap: number };
  windowPolicyVersion: string;
  persistenceAvailable?: boolean;
  lastSuccessfulFetchAt?: string | null;
  producingSourceCount?: number;
  runtimeMode?: string;
  replay?: { readOnly: true; requestedAsOf: string; snapshotId: string; capturedAt: string; eventCount: number };
  replaySnapshotTruncated?: boolean;
};

const scopeOrder: ScopeId[] = ["wuxi", "jiangsu", "china", "global"];
const severityLabels = { red: "红色", orange: "橙色", yellow: "黄色", blue: "蓝色" };
const severityRanks = { blue: 1, yellow: 2, orange: 3, red: 4 };
const locationQualityLabels: Record<DisasterEvent["locationQuality"], string> = { precise: "精确点位", estimated: "估算点位", representative: "区域代表点", unknown: "位置待核验" };
const confidenceLabels: Record<DisasterEvent["confidenceLevel"], string> = { high: "高可信", medium: "中可信", low: "低可信" };
const phenomenonLabels: Record<DisasterEvent["phenomenonStage"], string> = { observed: "实况", forecast: "预报", warning: "预警", driver: "驱动因子", context: "背景资料" };
const observationPhaseLabels: Record<DisasterEvent["observationPhase"], string> = { forecast: "预报候选期", golden: "黄金观测期", followup: "后续观测期", archive: "已归档" };
const taskFieldLabels: Record<string, string> = {
  aoiType: "AOI 类型",
  aoiRadiusKm: "AOI 半径",
  aoiWidthKm: "AOI 宽度",
  aoiHeightKm: "AOI 高度",
  aoiLengthKm: "走廊长度",
  aoiBearingDeg: "走廊方位",
  customGeometry: "自绘 AOI",
  imagingStart: "最早成像时间",
  imagingEnd: "最晚成像时间",
  sensors: "载荷类型",
  sarImagingModes: "SAR 成像方式",
  minimumCoveragePercent: "最低覆盖率",
  maximumCloudPercent: "最大云量",
  spatialResolutionMeters: "目标分辨率",
  incidenceAngleMinDeg: "最小入射角",
  incidenceAngleMaxDeg: "最大入射角",
  revisitCount: "重访次数",
  deliveryDeadline: "最迟交付时间",
  orbitDirectionPreference: "轨向偏好",
  cycloneTrackingTarget: "台风跟踪目标",
  observationTargets: "观测目标",
  sarAnalysisMode: "SAR 分析模式",
  referenceAcquisitionRequired: "灾前参考影像要求",
  status: "规划状态",
};
type SortMode = "priority" | "occurred" | "updated";
type TimeWindow = "all" | "1h" | "6h" | "24h" | "7d";
type TimeBasis = "occurred" | "updated";
type PhaseFilter = "all" | DisasterEvent["observationPhase"];
type ExportFormat = "json" | "csv" | "geojson";
type SourceStatus = {
  sourceId: string;
  name: string;
  state: "online" | "offline" | "needs_config";
  online: boolean;
  producing: boolean;
  count: number;
  tier: "中国第一批" | "中国第二批" | "基础" | "第一优先级" | "第二优先级";
  role: "事件" | "预报" | "核验";
  message: string;
  setupUrl: string;
  authorityClass: "official" | "scientific" | "humanitarian" | "aggregator";
  pollIntervalMinutes: number;
  latencySloMinutes: number;
  updateSemantics: string;
  geometrySemantics: string;
  licenseNote: string;
  durationMs: number;
  attempts: number;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
};
type AoiType = "source" | "point" | "circle" | "rectangle" | "corridor" | "polygon" | "multi";
type ResponsePointPickTarget = "origin" | "destination";
type ResponsePickedPoint = { target: ResponsePointPickTarget; longitude: number; latitude: number; sequence: number };

type SatelliteTask = {
  taskId: string;
  eventId: string;
  masterEventId: string;
  entityKey: string;
  title: string;
  hazard: HazardType;
  priority: number;
  latitude: number;
  longitude: number;
  eventOccurredAt: string;
  eventUpdatedAt: string;
  eventIssuedAt: string;
  eventValidFrom?: string;
  eventValidTo?: string;
  phenomenonStage: DisasterEvent["phenomenonStage"];
  aoiType: AoiType;
  aoiRadiusKm: number;
  aoiWidthKm: number;
  aoiHeightKm: number;
  aoiLengthKm: number;
  aoiBearingDeg: number;
  sourceGeometry?: DisasterEvent["geometry"];
  customGeometry?: CustomAoiGeometry;
  cycloneForecast?: DisasterEvent["cycloneForecast"];
  timeIndexedAoi?: CycloneTaskAoiSlice[];
  forecastAdvisoryId?: string;
  forecastIssuedAt?: string;
  forecastValidUntil?: string;
  cycloneTrackingTarget?: CycloneTrackingTarget;
  trackingValidFrom?: string;
  trackingValidTo?: string;
  trackingLeadHours?: number;
  trackingCenterLatitude?: number;
  trackingCenterLongitude?: number;
  trackingCenterBasis?: CycloneTaskAoiSlice["centerBasis"];
  trackingThresholdKnots?: number;
  minimumCoveragePercent: number;
  maximumCloudPercent: number;
  spatialResolutionMeters: number;
  incidenceAngleMinDeg: number;
  incidenceAngleMaxDeg: number;
  revisitCount: number;
  deliveryDeadline: string;
  imagingStart: string;
  imagingEnd: string;
  sensors: string[];
  sarImagingModes: SarImagingModeId[];
  observationTargets: string[];
  observationPhase: DisasterEvent["observationPhase"];
  source: string;
  sourceUrl: string;
  locationQuality: DisasterEvent["locationQuality"];
  locationAccuracyKm: number;
  evidenceCount: number;
  aoiApproval: "source_verified" | "operator_confirmed" | "review_required";
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  status: "candidate" | "reviewed" | "scheduled" | "submitted" | "cancellation_requested" | "cancel_acknowledged" | "cancel_rejected" | "acquired" | "completed" | "failed" | "cancelled";
  revision: number;
  eventRevision: string;
  aoiHash: string;
  approvalReason?: string;
  satelliteId?: string;
  instrumentId?: string;
  imagingMode?: string;
  opportunityId?: string;
  orbitVersion?: string;
  visibilityComputedAt?: string;
  incidenceAngleDeg?: number;
  offNadirAngleDeg?: number;
  opportunityLookSide?: "left" | "right";
  opportunityCoveragePercent?: number;
  opportunitySpatialResolutionM?: number;
  opportunitySceneCrossTrackKm?: number;
  opportunitySceneAlongTrackKm?: number;
  sensorParameterStatus?: "user_provided" | "provisional_assumption";
  opportunityFootprint?: GeoGeometry;
  simulationLevel?: "orbit_only" | "assumed_sensor" | "sensor_model";
  satelliteNoradId?: number;
  closestApproachAt?: string;
  closestSubpointLatitude?: number;
  closestSubpointLongitude?: number;
  minimumGroundTrackDistanceKm?: number;
  orbitSearchRadiusKm?: number;
  opportunityOrbitDirection?: "ascending" | "descending";
  orbitDirectionPreference?: "ascending" | "descending" | "either";
  referenceAcquisitionRequired?: boolean;
  sarAnalysisMode?: "amplitude_change" | "insar_pair" | "amplitude_change_and_insar_pair";
};

type TaskSyncState = { state: "saving" | "synced" | "local" | "error"; message?: string };
type TaskStorageMode = "loading" | "operational-database" | "public-read-only" | "unavailable";

type VisibilityWindow = {
  opportunityId: string;
  satelliteId: string;
  instrumentId?: string;
  imagingMode?: string;
  orbitVersion?: string;
  computedAt?: string;
  start: string;
  end: string;
  coveragePercent?: number;
  incidenceAngleDeg?: number;
  offNadirAngleDeg?: number;
  lookSide?: "left" | "right";
  spatialResolutionM?: number;
  spatialResolutionLabel?: string;
  polarizations?: string[];
  productLevels?: Array<{ level: string; code: string; name: string }>;
  nominalSceneCrossTrackKm?: number;
  nominalSceneAlongTrackKm?: number;
  parameterStatus?: "user_provided" | "provisional_assumption";
  footprintGeometry?: GeoGeometry;
  orbitDirection?: "ascending" | "descending";
  simulationLevel?: "orbit_only" | "assumed_sensor" | "sensor_model";
  satelliteLabel?: string;
  satelliteNoradId?: number;
  closestApproachAt?: string;
  closestSubpoint?: { latitude: number; longitude: number };
  minimumGroundTrackDistanceKm?: number;
  altitudeKm?: number;
  searchRadiusKm?: number;
  aoiRadiusKm?: number;
  candidateThresholdKm?: number;
  constraintNotes?: string[];
  constraintAssessment?: PlanningConstraintAssessment;
  trackingMode?: "forecast_time_indexed";
  trackingTarget?: CycloneTrackingTarget;
  trackingValidFrom?: string;
  trackingValidTo?: string;
  trackingLeadHours?: number;
  trackingCenter?: { latitude: number; longitude: number };
  trackingCenterBasis?: CycloneTaskAoiSlice["centerBasis"];
  trackingThresholdKnots?: number;
  forecastAdvisoryId?: string;
};

type VisibilityState = {
  state: "idle" | "loading" | "ready" | "needs_config" | "error";
  mode?: "orbit_only" | "assumed_sensor" | "sensor_model";
  message?: string;
  windows: VisibilityWindow[];
  planningSummary?: MissionPlanningSummary;
  planningProblem?: MissionPlanningProblem;
};

type JointSchedulingState = {
  state: "idle" | "loading" | "ready" | "error";
  comparison?: SchedulingComparison & { engine?: { mode: "external" | "local_fallback" | "local"; engineId: string; fallbackReason?: string } };
  message?: string;
};

type PlanningScenarioLibraryState = {
  state: "loading" | "ready" | "saving" | "error";
  summaries: PlanningScenarioSummary[];
  active?: PlanningScenarioRecord;
  message?: string;
  comparison?: { left: PlanningScenarioRecord; right: PlanningScenarioRecord };
};

type SatelliteOrbitView = {
  noradId: number;
  interfaceName?: string;
  interfaceCode?: string;
  commonName: string;
  commonCode?: string;
  identityStatus: "configured" | "unverified";
  payloadProfile?: {
    id: string;
    payloadType: "CSAR" | "XSAR";
    frequencyBand: "C" | "X";
    lookSides: Array<"left" | "right">;
    incidenceAngleDeg: { min: number; max: number };
    polarizations: string[];
    productLevels: Array<{ level: string; code: string; name: string }>;
    imagingModes: Array<{ id: string; name: string; resolutionM: number; resolutionLabel: string; resolutionDimensionsM?: [number, number]; nominalSceneCrossTrackKm: number; nominalSceneAlongTrackKm: number }>;
    parameterStatus: "user_provided" | "provisional_assumption";
    parameterNote: string;
  };
  providerName?: string;
  epoch?: string;
  fetchedAt?: string;
  lastError?: string;
  elementAgeHours?: number;
  orbitStatus: "current" | "stale" | "unavailable";
  sourceUrl: string;
  tleLine1?: string;
  tleLine2?: string;
};

type SatelliteFleetState = {
  state: "loading" | "ready" | "partial" | "unavailable" | "error";
  satellites: SatelliteOrbitView[];
  current: number;
  message?: string;
};

type WeatherLoadState = {
  state: "idle" | "loading" | "ready" | "needs_config" | "error";
  message?: string;
  forecast?: WeatherForecastReady;
};

const taskStorageKey = "tianxun-satellite-task-candidates-v1";
const responseStorageKey = "tianxun-response-scenarios-v1";
const payloadOptions = ["光学", "SAR"];
const legacyOpticalPayloads = new Set(["光学", "高分辨率光学", "宽幅光学", "高分光学", "多光谱", "高光谱"]);
const sarModeChoices = sarImagingModeOptions.map((option) => {
  const csar = sarPayloadProfiles["ty-csar-v2"].imagingModes.find((mode) => mode.id === option.id)!;
  const xsar = sarPayloadProfiles["ty-xsar-v1"].imagingModes.find((mode) => mode.id === option.id)!;
  return {
    ...option,
    summary: `CSAR ${csar.resolutionLabel} / ${csar.nominalSceneCrossTrackKm}×${csar.nominalSceneAlongTrackKm} km · XSAR ${xsar.resolutionLabel} / ${xsar.nominalSceneCrossTrackKm}×${xsar.nominalSceneAlongTrackKm} km`,
  };
});
const aoiOptions: Array<{ id: AoiType; label: string }> = [
  { id: "source", label: "来源几何" },
  { id: "point", label: "点目标" },
  { id: "circle", label: "圆形面" },
  { id: "rectangle", label: "矩形面" },
  { id: "corridor", label: "线状走廊" },
  { id: "polygon", label: "自绘单面" },
  { id: "multi", label: "多块 AOI" },
];
const defaultAoiRadiusKm: Record<HazardType, number> = {
  earthquake: 50,
  tsunami: 100,
  wildfire: 25,
  flood: 40,
  cyclone: 200,
  volcano: 30,
  landslide: 10,
  drought: 100,
  dust: 300,
  ice: 100,
};

export function Dashboard({ currentUser, onLogout, logoutBusy = false }: { currentUser?: { username: string; role: "viewer" | "operator" | "admin" }; onLogout?: () => void; logoutBusy?: boolean }) {
  const storageOwner = encodeURIComponent(currentUser?.username ?? "local-developer");
  const userTaskStorageKey = `${taskStorageKey}:${storageOwner}`;
  const userResponseStorageKey = `${responseStorageKey}:${storageOwner}`;
  const userWorkspaceStorageKey = `tianxun-workspace-v1:${storageOwner}`;
  const [data, setData] = useState<ApiResponse | null>(null);
  const [scope, setScope] = useState<ScopeId>("global");
  const [hazard, setHazard] = useState<HazardType | "all">("all");
  const [selected, setSelected] = useState<DisasterEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastRefreshErrorAt, setLastRefreshErrorAt] = useState<string | null>(null);
  const replayModeRef = useRef(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");
  const [timeBasis, setTimeBasis] = useState<TimeBasis>("updated");
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>("all");
  const [listOpen, setListOpen] = useState(true);
  const [locationZh, setLocationZh] = useState<Record<string, string>>({});
  const [locationLoading, setLocationLoading] = useState<string | null>(null);
  const [locationState, setLocationState] = useState<Record<string, { state: "resolved" | "fallback" | "error"; source?: string }>>({});
  const [locationRetry, setLocationRetry] = useState(0);
  const [tasks, setTasks] = useState<SatelliteTask[]>([]);
  const [tasksHydrated, setTasksHydrated] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [responsePanelOpen, setResponsePanelOpen] = useState(false);
  const [responsePointPickTarget, setResponsePointPickTarget] = useState<ResponsePointPickTarget | null>(null);
  const [responsePickedPoint, setResponsePickedPoint] = useState<ResponsePickedPoint | null>(null);
  const [responseEventId, setResponseEventId] = useState<string | null>(null);
  const [responseScenarios, setResponseScenarios] = useState<ResponseScenario[]>([]);
  const [responseHydrated, setResponseHydrated] = useState(false);
  const [activeResponseScenarioId, setActiveResponseScenarioId] = useState<string | null>(null);
  const [confirmedAois, setConfirmedAois] = useState<Set<string>>(new Set());
  const [landslideTerrain, setLandslideTerrain] = useState<Record<string, LandslideTerrainScreening>>({});
  const [exposureAssessments, setExposureAssessments] = useState<Record<string, ExposureAssessment>>({});
  const [taskSync, setTaskSync] = useState<Record<string, TaskSyncState>>({});
  const [taskStorageMode, setTaskStorageMode] = useState<TaskStorageMode>("loading");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [compactViewport, setCompactViewport] = useState(false);
  const [fleet, setFleet] = useState<SatelliteFleetState>({ state: "loading", satellites: [], current: 0 });
  const [undoDraft, setUndoDraft] = useState<{ task: SatelliteTask; expiresAt: number } | null>(null);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [restoredSelectedMasterEventId, setRestoredSelectedMasterEventId] = useState<string | null>(null);
  const undoDraftTimer = useRef<number | null>(null);
  const taskTriggerRef = useRef<HTMLButtonElement>(null);
  const responseTriggerRef = useRef<HTMLButtonElement>(null);
  const previousTaskPanelOpen = useRef(false);
  const previousResponsePanelOpen = useRef(false);
  const taskSaveTimers = useRef(new Map<string, number>());
  const taskSaveControllers = useRef(new Map<string, AbortController>());
  const taskSubmittedWrites = useRef(new Map<string, SatelliteTask>());
  const taskSupersededWrites = useRef(new Map<string, SatelliteTask>());
  const taskMutationGeneration = useRef(new Map<string, number>());
  const opportunityResetNotices = useRef(new Map<string, string>());
  const taskServerSnapshots = useRef(new Map<string, SatelliteTask>());
  const tasksRef = useRef<SatelliteTask[]>([]);
  const closeTaskPanel = useCallback(() => { setTaskPanelOpen(false); }, []);
  const closeResponsePanel = useCallback(() => { setResponsePanelOpen(false); }, []);
  const selectEvent = useCallback((event: DisasterEvent) => {
    setActiveResponseScenarioId(null);
    setSelected(event);
    // At notebook/tablet widths the detail panel and 4D controls need the map
    // canvas. Keep a one-click event-list reopen affordance instead of
    // compressing all three surfaces into an unusable strip.
    if (window.matchMedia("(max-width: 1050px)").matches) setListOpen(false);
  }, []);
  const closeSelected = useCallback(() => {
    const eventId = selected?.id;
    setSelected(null);
    if (window.matchMedia("(max-width: 1050px)").matches) setListOpen(true);
    if (eventId) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`)?.focus(), 0);
  }, [selected]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/events", { cache: "no-store" });
      if (!response.ok) throw new Error("数据请求失败");
      const result = await response.json() as ApiResponse;
      replayModeRef.current = false;
      setData(result);
      setLastRefreshErrorAt(null);
    } catch {
      setError(true);
      setLastRefreshErrorAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReplay = useCallback(async (asOf: string) => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`/api/replay?asOf=${encodeURIComponent(asOf)}`, { cache: "no-store" });
      const result = await response.json() as ApiResponse & { error?: string };
      if (!response.ok) throw new Error(result.error || "历史快照读取失败");
      replayModeRef.current = true;
      setData(result);
      setSelected(null);
      setLastRefreshErrorAt(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/satellites", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { state?: SatelliteFleetState["state"]; satellites?: SatelliteOrbitView[]; summary?: { current?: number }; message?: string };
        if (!response.ok) throw new Error(result.message || "卫星轨道接口不可用");
        setFleet({ state: result.state ?? "unavailable", satellites: result.satellites ?? [], current: Number(result.summary?.current ?? 0), message: result.message });
      })
      .catch((orbitError) => { if (!controller.signal.aborted) setFleet({ state: "error", satellites: [], current: 0, message: orbitError instanceof Error ? orbitError.message : "卫星轨道接口不可用" }); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(() => { if (!replayModeRef.current) void refresh(); }, 5 * 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => () => {
    taskSaveTimers.current.forEach((timer) => window.clearTimeout(timer));
    taskSaveControllers.current.forEach((controller) => controller.abort());
    if (undoDraftTimer.current) window.clearTimeout(undoDraftTimer.current);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setCompactViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(userWorkspaceStorageKey);
      if (saved) {
        const workspace = JSON.parse(saved) as Partial<{ scope: ScopeId; hazard: HazardType | "all"; query: string; sortMode: SortMode; timeWindow: TimeWindow; timeBasis: TimeBasis; phaseFilter: PhaseFilter; selectedMasterEventId: string }>;
        if (scopeOrder.includes(workspace.scope as ScopeId)) setScope(workspace.scope as ScopeId);
        if (workspace.hazard === "all" || Object.hasOwn(hazardMeta, String(workspace.hazard))) setHazard(workspace.hazard as HazardType | "all");
        if (typeof workspace.query === "string") setQuery(workspace.query.slice(0, 160));
        if (["priority", "occurred", "updated"].includes(String(workspace.sortMode))) setSortMode(workspace.sortMode as SortMode);
        if (["all", "1h", "6h", "24h", "7d"].includes(String(workspace.timeWindow))) setTimeWindow(workspace.timeWindow as TimeWindow);
        if (["occurred", "updated"].includes(String(workspace.timeBasis))) setTimeBasis(workspace.timeBasis as TimeBasis);
        if (["all", "forecast", "golden", "followup", "archive"].includes(String(workspace.phaseFilter))) setPhaseFilter(workspace.phaseFilter as PhaseFilter);
        if (workspace.selectedMasterEventId) setRestoredSelectedMasterEventId(workspace.selectedMasterEventId);
      }
    } catch {
      window.sessionStorage.removeItem(userWorkspaceStorageKey);
    } finally {
      setWorkspaceHydrated(true);
    }
  }, [userWorkspaceStorageKey]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    window.sessionStorage.setItem(userWorkspaceStorageKey, JSON.stringify({ scope, hazard, query, sortMode, timeWindow, timeBasis, phaseFilter, selectedMasterEventId: selected?.masterEventId }));
  }, [hazard, phaseFilter, query, scope, selected?.masterEventId, sortMode, timeBasis, timeWindow, userWorkspaceStorageKey, workspaceHydrated]);

  useEffect(() => {
    if (previousTaskPanelOpen.current && !taskPanelOpen) taskTriggerRef.current?.focus();
    previousTaskPanelOpen.current = taskPanelOpen;
  }, [taskPanelOpen]);

  useEffect(() => {
    if (previousResponsePanelOpen.current && !responsePanelOpen) responseTriggerRef.current?.focus();
    previousResponsePanelOpen.current = responsePanelOpen;
  }, [responsePanelOpen]);

  useEffect(() => {
    const restore = window.setTimeout(async () => {
      let localTasks: SatelliteTask[] = [];
      try {
        const saved = window.localStorage.getItem(userTaskStorageKey) ?? window.localStorage.getItem(taskStorageKey);
        if (saved) localTasks = (JSON.parse(saved) as Array<Partial<SatelliteTask>>).map(migrateSatelliteTask);
        if (!window.localStorage.getItem(userTaskStorageKey) && window.localStorage.getItem(taskStorageKey)) {
          window.localStorage.setItem(userTaskStorageKey, saved ?? "[]");
          window.localStorage.removeItem(taskStorageKey);
        }
      } catch {
        // 本地缓存损坏时从空候选单重新开始，不影响实时事件监测。
      }
      try {
        const response = await fetch("/api/tasks", { cache: "no-store" });
        if (!response.ok) throw new Error("task database unavailable");
        const result = await response.json() as { tasks: Array<Partial<SatelliteTask>>; cancelledTaskIds?: string[]; storage?: string };
        const storageMode: TaskStorageMode = result.storage === "public-read-only" ? "public-read-only" : "operational-database";
        setTaskStorageMode(storageMode);
        const serverTasks = result.tasks.map(migrateSatelliteTask);
        taskServerSnapshots.current = new Map(serverTasks.map((task) => [task.taskId, task]));
        const cancelled = new Set(result.cancelledTaskIds ?? []);
        const merged = [...new Map([...localTasks.filter((task) => !cancelled.has(task.taskId)), ...serverTasks].map((task) => [task.taskId, task])).values()];
        tasksRef.current = merged;
        setTasks(merged);
        setTaskSync(Object.fromEntries(merged.map((task) => [task.taskId, {
          state: serverTasks.some((server) => server.taskId === task.taskId) ? "synced" : "local",
          message: storageMode === "public-read-only"
            ? task.revision > 0 ? "该任务曾同步；公网只读入口不能修改或取消" : "公网入口为只读模式；此任务仅保存在本机"
            : undefined,
        } as TaskSyncState])));
      } catch {
        setTaskStorageMode("unavailable");
        tasksRef.current = localTasks;
        setTasks(localTasks);
        setTaskSync(Object.fromEntries(localTasks.map((task) => [task.taskId, { state: "local", message: "任务服务不可用；仅保存在本机" } as TaskSyncState])));
      } finally {
        setTasksHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, [userTaskStorageKey]);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(userResponseStorageKey) ?? window.localStorage.getItem(responseStorageKey);
        if (saved) {
          const parsed = JSON.parse(saved) as ResponseScenario[];
          setResponseScenarios(parsed.filter(isResponseScenario).slice(0, 50));
        }
        if (!window.localStorage.getItem(userResponseStorageKey) && window.localStorage.getItem(responseStorageKey)) {
          window.localStorage.setItem(userResponseStorageKey, saved ?? "[]");
          window.localStorage.removeItem(responseStorageKey);
        }
      } catch {
        // 损坏的本机推演场景不能影响灾害监测和卫星任务主链。
      } finally {
        setResponseHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, [userResponseStorageKey]);

  useEffect(() => {
    if (!tasksHydrated) return;
    window.localStorage.setItem(userTaskStorageKey, JSON.stringify(tasks));
  }, [tasks, tasksHydrated, userTaskStorageKey]);

  useEffect(() => {
    if (!responseHydrated) return;
    window.localStorage.setItem(userResponseStorageKey, JSON.stringify(responseScenarios.slice(0, 50)));
  }, [responseHydrated, responseScenarios, userResponseStorageKey]);

  useEffect(() => {
    if (!tasksHydrated || !data?.events.length) return;
    setTasks((current) => {
      let changed = false;
      const next = current.map((task) => {
        if (task.revision !== 0) return task;
        const event = data.events.find((candidate) => taskMatchesEvent(task, candidate));
        if (!event || task.eventRevision === eventRevisionFingerprint(event)) return task;
        try {
          changed = true;
          return rebaseUnsyncedDraft(task, event);
        } catch {
          return task;
        }
      });
      return changed ? next : current;
    });
  }, [data, tasksHydrated]);

  const saveTask = useCallback(async (task: SatelliteTask): Promise<SatelliteTask | null> => {
    if (taskStorageMode === "public-read-only") {
      setTaskSync((current) => ({ ...current, [task.taskId]: { state: "local", message: "公网入口为只读模式；任务仅保存在本机" } }));
      return null;
    }
    const generation = taskMutationGeneration.current.get(task.taskId) ?? 0;
    const previousController = taskSaveControllers.current.get(task.taskId);
    const previousSubmission = taskSubmittedWrites.current.get(task.taskId);
    if (previousController && previousSubmission) taskSupersededWrites.current.set(task.taskId, previousSubmission);
    previousController?.abort();
    const controller = new AbortController();
    taskSaveControllers.current.set(task.taskId, controller);
    setTaskSync((current) => ({ ...current, [task.taskId]: { state: "saving" } }));
    try {
      let pendingTask = tasksRef.current.find((item) => item.taskId === task.taskId && item.revision >= task.revision) ?? task;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        taskSubmittedWrites.current.set(task.taskId, pendingTask);
        const taskForSave = compactSatelliteTaskForSync(pendingTask as unknown as Record<string, unknown>);
        const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(taskForSave), signal: controller.signal });
        const result = await response.json() as { task?: Partial<SatelliteTask>; error?: string; errors?: string[] };
        const message = result.errors?.join("；") || result.error || "保存失败";
        if (!response.ok) {
          if (attempt === 0 && response.status === 409 && /任务版本冲突|任务.*其他请求更新|revision/i.test(message)) {
            const latestResponse = await fetch(`/api/tasks?taskId=${encodeURIComponent(task.taskId)}`, { cache: "no-store", signal: controller.signal });
            const latestResult = await latestResponse.json() as { task?: Partial<SatelliteTask>; error?: string };
            if (!latestResponse.ok || !latestResult.task) throw new Error(latestResult.error || "无法读取任务最新版本");
            const remoteTask = migrateSatelliteTask(latestResult.task);
            const localTask = tasksRef.current.find((item) => item.taskId === task.taskId) ?? pendingTask;
            const baseTask = taskServerSnapshots.current.get(task.taskId);
            const supersededTask = taskSupersededWrites.current.get(task.taskId);
            const remoteIsOwnSupersededWrite = Boolean(supersededTask && sameOperatorTaskContent(
              supersededTask as unknown as Record<string, unknown>,
              remoteTask as unknown as Record<string, unknown>,
            ));
            const mergeBase = remoteIsOwnSupersededWrite ? remoteTask : baseTask;
            const mergeLocal = remoteIsOwnSupersededWrite ? { ...localTask, revision: remoteTask.revision } : localTask;
            const merge = mergeTaskVersions(
              mergeBase as unknown as Record<string, unknown> | undefined,
              mergeLocal as unknown as Record<string, unknown>,
              remoteTask as unknown as Record<string, unknown>,
            );
            if (remoteIsOwnSupersededWrite) taskSupersededWrites.current.delete(task.taskId);
            const mergedTask = migrateSatelliteTask(merge.merged as Partial<SatelliteTask>);
            taskServerSnapshots.current.set(task.taskId, remoteTask);
            tasksRef.current = tasksRef.current.map((item) => item.taskId === task.taskId ? mergedTask : item);
            setTasks((current) => current.map((item) => item.taskId === task.taskId ? mergedTask : item));
            if (merge.conflictingFields.length) {
              const labels = merge.conflictingFields.slice(0, 5).map((field) => taskFieldLabels[field] ?? field).join("、");
              const remainder = merge.conflictingFields.length > 5 ? `等 ${merge.conflictingFields.length} 项` : "";
              setTaskSync((current) => ({ ...current, [task.taskId]: {
                state: "error",
                message: `检测到另一个请求也修改了${labels}${remainder ? `（${remainder}）` : ""}。已保留当前页面值并更新到服务端 v${remoteTask.revision}，请核对后重试同步。`,
              } }));
              return null;
            }
            pendingTask = mergedTask;
            continue;
          }
          throw new Error(message);
        }
        if (!result.task) throw new Error("服务端未返回已保存任务");
        const serverTask = migrateSatelliteTask(result.task);
        taskSupersededWrites.current.delete(task.taskId);
        taskServerSnapshots.current.set(task.taskId, serverTask);
        const currentTask = tasksRef.current.find((item) => item.taskId === task.taskId);
        if (!currentTask) return null;
        const nextTask = currentTask.updatedAt === pendingTask.updatedAt
          ? serverTask
          : { ...currentTask, revision: serverTask.revision, eventRevision: serverTask.eventRevision, aoiHash: serverTask.aoiHash };
        tasksRef.current = tasksRef.current.map((item) => item.taskId === task.taskId ? nextTask : item);
        setTasks((current) => current.map((item) => item.taskId === task.taskId ? nextTask : item));
        if ((taskMutationGeneration.current.get(task.taskId) ?? 0) !== generation) return null;
        const resetNotice = opportunityResetNotices.current.get(task.taskId);
        opportunityResetNotices.current.delete(task.taskId);
        setTaskSync((current) => ({ ...current, [task.taskId]: { state: "synced", message: resetNotice } }));
        return serverTask;
      }
      return null;
    } catch (saveError) {
      if (controller.signal.aborted || (taskMutationGeneration.current.get(task.taskId) ?? 0) !== generation) return null;
      setTaskSync((current) => ({ ...current, [task.taskId]: { state: "error", message: saveError instanceof Error ? saveError.message : "保存失败" } }));
      return null;
    } finally {
      if (taskSaveControllers.current.get(task.taskId) === controller) {
        taskSaveControllers.current.delete(task.taskId);
        taskSubmittedWrites.current.delete(task.taskId);
      }
    }
  }, [taskStorageMode]);

  const addTask = useCallback((event: DisasterEvent, operatorConfirmed: boolean) => {
    const task = createSatelliteTask(event, operatorConfirmed);
    const existingTask = tasksRef.current.find((item) => taskMatchesEvent(item, event));
    if (existingTask) {
      setTaskPanelOpen(true);
      setListOpen(false);
      setActiveTaskId(existingTask.taskId);
      return;
    }
    tasksRef.current = [task, ...tasksRef.current];
    setTasks(tasksRef.current);
    void saveTask(task).then((ok) => {
      if (!ok) setTaskSync((current) => ({ ...current, [task.taskId]: current[task.taskId] ?? { state: "local", message: "仅保存在本机，可稍后重试同步" } }));
    });
    setTaskPanelOpen(true);
    setListOpen(false);
    setActiveTaskId(task.taskId);
  }, [saveTask]);

  const addLandslideSarTasks = useCallback((event: DisasterEvent, terrain: LandslideTerrainScreening) => {
    const generated = createLandslideSarTasks(event, terrain);
    const existingDirections = new Set(tasksRef.current.filter((task) => task.masterEventId === event.masterEventId).map((task) => task.orbitDirectionPreference));
    const additions = generated.filter((task) => !existingDirections.has(task.orbitDirectionPreference));
    if (!additions.length) {
      setTaskPanelOpen(true);
      return;
    }
    const next = [...additions, ...tasksRef.current];
    tasksRef.current = next;
    setTasks(next);
    additions.forEach((task) => void saveTask(task).then((ok) => {
      if (!ok) setTaskSync((current) => ({ ...current, [task.taskId]: current[task.taskId] ?? { state: "local", message: "仅保存在本机，可稍后重试同步" } }));
    }));
    setTaskPanelOpen(true);
    setListOpen(false);
    setActiveTaskId(additions[0].taskId);
  }, [saveTask]);

  const updateTask = useCallback((taskId: string, patch: Partial<SatelliteTask>) => {
    const aoiKeys = ["aoiType", "aoiRadiusKm", "aoiWidthKm", "aoiHeightKm", "aoiLengthKm", "aoiBearingDeg", "customGeometry"];
    const touchesAoi = Object.keys(patch).some((key) => aoiKeys.includes(key));
    const opportunityInputKeys = [...aoiKeys, "imagingStart", "imagingEnd", "sensors", "sarImagingModes", "minimumCoveragePercent", "maximumCloudPercent", "spatialResolutionMeters", "incidenceAngleMinDeg", "incidenceAngleMaxDeg", "orbitDirectionPreference", "cycloneTrackingTarget", "priority", "revisitCount", "deliveryDeadline"];
    const invalidatesOpportunity = Object.keys(patch).some((key) => opportunityInputKeys.includes(key));
    const taskBeforeUpdate = tasksRef.current.find((task) => task.taskId === taskId);
    if (invalidatesOpportunity && taskBeforeUpdate?.opportunityId) {
      opportunityResetNotices.current.set(taskId, "规划条件已修改，原成像机会已清除；请重新计算并选择卫星机会");
    }
    const opportunityReset: Partial<SatelliteTask> = invalidatesOpportunity ? {
      satelliteId: undefined, instrumentId: undefined, imagingMode: undefined, opportunityId: undefined,
      orbitVersion: undefined, visibilityComputedAt: undefined, incidenceAngleDeg: undefined, offNadirAngleDeg: undefined,
      opportunityLookSide: undefined, opportunityCoveragePercent: undefined, opportunitySpatialResolutionM: undefined,
      opportunitySceneCrossTrackKm: undefined, opportunitySceneAlongTrackKm: undefined, sensorParameterStatus: undefined, opportunityFootprint: undefined,
      simulationLevel: undefined, satelliteNoradId: undefined, closestApproachAt: undefined,
      closestSubpointLatitude: undefined, closestSubpointLongitude: undefined, minimumGroundTrackDistanceKm: undefined,
      orbitSearchRadiusKm: undefined, opportunityOrbitDirection: undefined,
      trackingValidFrom: undefined, trackingValidTo: undefined, trackingLeadHours: undefined,
      trackingCenterLatitude: undefined, trackingCenterLongitude: undefined, trackingCenterBasis: undefined, trackingThresholdKnots: undefined,
    } : {};
    taskMutationGeneration.current.set(taskId, (taskMutationGeneration.current.get(taskId) ?? 0) + 1);
    const inFlightSubmission = taskSubmittedWrites.current.get(taskId);
    if (inFlightSubmission) taskSupersededWrites.current.set(taskId, inFlightSubmission);
    taskSaveControllers.current.get(taskId)?.abort();
    setTasks((current) => current.map((task) => {
      if (task.taskId !== taskId) return task;
      return { ...task, ...opportunityReset, ...patch, ...(touchesAoi ? { aoiApproval: "review_required" as const, approvedAt: undefined, approvedBy: undefined, approvalReason: undefined } : {}), updatedAt: new Date().toISOString() };
    }));
    const priorTimer = taskSaveTimers.current.get(taskId);
    if (priorTimer) window.clearTimeout(priorTimer);
    taskSaveTimers.current.set(taskId, window.setTimeout(() => {
      taskSaveTimers.current.delete(taskId);
      const pending = tasksRef.current.find((task) => task.taskId === taskId);
      if (pending) void saveTask(pending);
    }, 700));
  }, [saveTask]);

  const removeTask = useCallback(async (taskId: string) => {
    const task = tasksRef.current.find((item) => item.taskId === taskId);
    if (!task) return;
    const priorTimer = taskSaveTimers.current.get(taskId);
    if (priorTimer) window.clearTimeout(priorTimer);
    taskSaveTimers.current.delete(taskId);
    taskMutationGeneration.current.set(taskId, (taskMutationGeneration.current.get(taskId) ?? 0) + 1);
    taskSaveControllers.current.get(taskId)?.abort();
    taskSaveControllers.current.delete(taskId);
    taskSubmittedWrites.current.delete(taskId);
    taskSupersededWrites.current.delete(taskId);
    const removeSyncState = () => setTaskSync((current) => { const next = { ...current }; delete next[taskId]; return next; });
    const localOnly = (taskStorageMode === "public-read-only" || taskStorageMode === "unavailable") && task.revision === 0;
    if (localOnly) {
      taskServerSnapshots.current.delete(taskId);
      tasksRef.current = tasksRef.current.filter((candidate) => candidate.taskId !== taskId);
      setTasks((current) => current.filter((candidate) => candidate.taskId !== taskId));
      if (activeTaskId === taskId) setActiveTaskId(null);
      removeSyncState();
      if (undoDraftTimer.current) window.clearTimeout(undoDraftTimer.current);
      setUndoDraft({ task, expiresAt: Date.now() + 8_000 });
      undoDraftTimer.current = window.setTimeout(() => { setUndoDraft(null); undoDraftTimer.current = null; }, 8_000);
      return;
    }
    if ((taskStorageMode === "public-read-only" || taskStorageMode === "unavailable") && task.revision > 0) {
      setTaskSync((current) => ({ ...current, [taskId]: {
        state: "error",
        message: taskStorageMode === "public-read-only"
          ? "该任务已同步到服务器；公网只读入口不能取消，请从受保护的任务入口操作"
          : "任务服务不可用，已同步任务不能只从本机删除",
      } }));
      return;
    }
    if (!window.confirm(`确认取消任务“${task.title}”（${task.taskId}）？\n此操作会写入业务审计记录，不能当作普通界面隐藏。`)) return;
    setTaskSync((current) => ({ ...current, [taskId]: { state: "saving", message: "正在写入取消审计记录" } }));
    try {
      const response = await fetch(`/api/tasks?taskId=${encodeURIComponent(taskId)}&revision=${Math.max(0, task.revision)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string; state?: string; revision?: number; task?: Partial<SatelliteTask> };
      if (!response.ok) throw new Error(result.error || `取消任务失败（HTTP ${response.status}）`);
      if (result.state === "cancellation_requested") {
        const cancelledTask = migrateSatelliteTask({ ...task, ...result.task, status: "cancellation_requested", revision: result.revision ?? task.revision });
        taskServerSnapshots.current.set(taskId, cancelledTask);
        tasksRef.current = tasksRef.current.map((candidate) => candidate.taskId === taskId ? cancelledTask : candidate);
        setTasks(tasksRef.current);
        setTaskSync((current) => ({ ...current, [taskId]: { state: "synced", message: "取消请求已记录，等待执行系统回执" } }));
      } else {
        taskServerSnapshots.current.delete(taskId);
        tasksRef.current = tasksRef.current.filter((candidate) => candidate.taskId !== taskId);
        setTasks((current) => current.filter((candidate) => candidate.taskId !== taskId));
        if (activeTaskId === taskId) setActiveTaskId(null);
        removeSyncState();
      }
    } catch (removeError) {
      setTaskSync((current) => ({ ...current, [taskId]: { state: "error", message: removeError instanceof Error ? removeError.message : "服务端取消失败，任务未改变" } }));
    }
  }, [activeTaskId, taskStorageMode]);

  const restoreDraft = useCallback(() => {
    if (!undoDraft) return;
    if (undoDraftTimer.current) window.clearTimeout(undoDraftTimer.current);
    undoDraftTimer.current = null;
    setTasks((current) => current.some((task) => task.taskId === undoDraft.task.taskId) ? current : [undoDraft.task, ...current]);
    setTaskSync((current) => ({ ...current, [undoDraft.task.taskId]: { state: "local", message: "已撤销删除；任务仍仅保存在本机" } }));
    setUndoDraft(null);
  }, [undoDraft]);

  useEffect(() => {
    if (!selected || ["resolved", "fallback", "error"].includes(locationState[selected.id]?.state ?? "")) return;
    const controller = new AbortController();
    const eventId = selected.id;
    const params = new URLSearchParams({
      lat: String(selected.latitude),
      lon: String(selected.longitude),
      fallback: selected.country || selected.title,
      retry: String(locationRetry),
    });
    const start = window.setTimeout(() => {
      setLocationLoading(eventId);
      fetch(`/api/location?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("location lookup failed")))
        .then((result: { locationZh: string; source?: string }) => {
          setLocationZh((current) => ({ ...current, [eventId]: result.locationZh }));
          setLocationState((current) => ({ ...current, [eventId]: { state: result.source === "fallback" ? "fallback" : "resolved", source: result.source } }));
        })
        .catch(() => setLocationState((current) => ({ ...current, [eventId]: { state: "error" } })))
        .finally(() => setLocationLoading((current) => current === eventId ? null : current));
    }, 0);
    return () => {
      window.clearTimeout(start);
      controller.abort();
    };
  }, [locationRetry, locationState, selected]);

  const deduplicatedEvents = useMemo(() => latestEventVersionsByMasterId(data?.events ?? []), [data]);

  useEffect(() => {
    if (!restoredSelectedMasterEventId || !deduplicatedEvents.length || selected) return;
    const restored = deduplicatedEvents.find((event) => event.masterEventId === restoredSelectedMasterEventId);
    if (restored) setSelected(restored);
    setRestoredSelectedMasterEventId(null);
  }, [deduplicatedEvents, restoredSelectedMasterEventId, selected]);

  useEffect(() => {
    if (!selected || !data) return;
    const current = deduplicatedEvents.find((event) => event.masterEventId === selected.masterEventId) ?? deduplicatedEvents.find((event) => event.id === selected.id);
    if (!current) setSelected(null);
    else if (current !== selected) setSelected(current);
  }, [data, deduplicatedEvents, selected]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-event-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const windowHours = { all: Number.POSITIVE_INFINITY, "1h": 1, "6h": 6, "24h": 24, "7d": 168 }[timeWindow];
    const cutoff = clock - windowHours * 3_600_000;
    return deduplicatedEvents
    .filter((event) =>
        isVisibleInScope(event.scope, scope) &&
        (hazard === "all" || event.hazard === hazard) &&
        (phaseFilter === "all" || event.observationPhase === phaseFilter) &&
        (timeWindow === "all" || Date.parse(timeBasis === "occurred" ? event.occurredAt : event.updatedAt) >= cutoff) &&
        (!needle || `${event.title} ${event.country ?? ""} ${event.source} ${locationZh[event.id] ?? ""}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => sortMode === "occurred"
        ? +new Date(b.occurredAt) - +new Date(a.occurredAt) || b.priority - a.priority
        : sortMode === "updated" ? +new Date(b.updatedAt) - +new Date(a.updatedAt) || b.priority - a.priority
        : b.priority - a.priority || +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [clock, deduplicatedEvents, hazard, locationZh, phaseFilter, query, scope, sortMode, timeBasis, timeWindow]);

  const selectedOutsideFilters = Boolean(selected && !filtered.some((event) => event.masterEventId === selected.masterEventId));
  const filtersActive = Boolean(query || hazard !== "all" || timeWindow !== "all" || phaseFilter !== "all" || sortMode !== "priority" || timeBasis !== "updated");
  const clearFilters = useCallback(() => {
    setQuery("");
    setHazard("all");
    setTimeWindow("all");
    setTimeBasis("updated");
    setPhaseFilter("all");
    setSortMode("priority");
  }, []);

  const scopedEvents = useMemo(() => deduplicatedEvents.filter((event) => isVisibleInScope(event.scope, scope)), [deduplicatedEvents, scope]);

  const scopeCounts = useMemo(() => Object.fromEntries(scopeOrder.map((id) => [
    id,
    deduplicatedEvents.filter((event) => isVisibleInScope(event.scope, id)).length,
  ])) as Record<ScopeId, number>, [deduplicatedEvents]);

  const severeCount = filtered.filter((e) => e.severity === "red" || e.severity === "orange").length;
  const highPriorityCount = filtered.filter((e) => e.priority >= 70).length;
  const producingSourceCount = data?.producingSourceCount ?? data?.sourceStatus.filter((source) => source.producing).length ?? 0;
  const runtimeMode = !data ? "正在连接" : data.replay ? "历史重演" : data.fallback && data.retainedCount > 0 ? "缓存模式" : data.fallback ? "演示模式" : producingSourceCount === 0 ? "无事件产出" : data.persistenceAvailable === false ? "数据库降级" : "实时监测中";
  const modeStale = runtimeMode !== "实时监测中" || Boolean(lastRefreshErrorAt);
  const activeTask = tasks.find((task) => task.taskId === activeTaskId) ?? null;
  const activeResponseScenario = responseScenarios.find((scenario) => scenario.scenarioId === activeResponseScenarioId) ?? null;
  const responsePlanningEvent = responseEventId ? deduplicatedEvents.find((event) => event.masterEventId === responseEventId || event.id === responseEventId) ?? null : null;
  const openResponsePlanner = useCallback((event?: DisasterEvent) => {
    document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((details) => { details.open = false; });
    setTaskPanelOpen(false);
    setActiveTaskId(null);
    setResponseEventId(event?.masterEventId ?? null);
    setResponsePanelOpen(true);
    setListOpen(false);
  }, []);
  const requestResponsePointPick = useCallback((target: ResponsePointPickTarget) => {
    setResponsePointPickTarget(target);
    setResponsePanelOpen(false);
    setListOpen(false);
  }, []);
  const acceptResponsePointPick = useCallback((target: ResponsePointPickTarget, longitude: number, latitude: number) => {
    setResponsePickedPoint({ target, longitude, latitude, sequence: Date.now() });
    setResponsePointPickTarget(null);
    setResponsePanelOpen(true);
  }, []);
  const saveResponseScenario = useCallback((scenario: ResponseScenario) => {
    setResponseScenarios((current) => [scenario, ...current.filter((item) => item.scenarioId !== scenario.scenarioId)].slice(0, 50));
    setActiveResponseScenarioId(scenario.scenarioId);
  }, []);
  const reviewResponseScenario = useCallback((scenarioId: string) => {
    const scenario = responseScenarios.find((item) => item.scenarioId === scenarioId);
    if (!scenario) return;
    const event = deduplicatedEvents.find((item) => item.masterEventId === scenario.masterEventId);
    setActiveTaskId(null);
    setActiveResponseScenarioId(scenarioId);
    setResponsePanelOpen(false);
    setSelected(event ?? null);
    if (window.matchMedia("(max-width: 1050px)").matches) setListOpen(false);
  }, [deduplicatedEvents, responseScenarios]);
  const removeResponseScenario = useCallback((scenarioId: string) => {
    const scenario = responseScenarios.find((item) => item.scenarioId === scenarioId);
    if (scenario && !window.confirm(`确认删除处置推演“${scenario.title}”？`)) return;
    setResponseScenarios((current) => current.filter((scenario) => scenario.scenarioId !== scenarioId));
    if (activeResponseScenarioId === scenarioId) setActiveResponseScenarioId(null);
  }, [activeResponseScenarioId, responseScenarios]);
  const selectResponseRoute = useCallback((scenarioId: string, routeId: string) => {
    setResponseScenarios((current) => current.map((scenario) => scenario.scenarioId === scenarioId ? { ...scenario, selectedRouteId: routeId, updatedAt: new Date().toISOString() } : scenario));
  }, []);
  const reviewTaskAoi = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    setActiveResponseScenarioId(null);
    setSelected(null);
    // Desktop users need the opportunity list and map preview at the same time.
    // Narrow screens temporarily hide the panel for map space, but TaskPanel
    // stays mounted so its computed windows and scheduling state survive.
    if (window.matchMedia("(max-width: 1050px)").matches) {
      setTaskPanelOpen(false);
      setListOpen(false);
    }
  }, []);
  const updateCustomAoi = useCallback((taskId: string, geometry?: CustomAoiGeometry) => {
    const requestedType = tasksRef.current.find((task) => task.taskId === taskId)?.aoiType;
    const normalized = geometry && requestedType === "multi" ? asMultiPolygon(geometry) : geometry;
    updateTask(taskId, {
      customGeometry: normalized,
      ...(normalized && requestedType !== "multi" ? { aoiType: normalized.type === "Polygon" ? "polygon" as const : "multi" as const } : {}),
    });
  }, [updateTask]);
  const modalPanelOpen = taskPanelOpen || responsePanelOpen;
  const mapObscured = modalPanelOpen || (compactViewport && (listOpen || Boolean(selected)));

  return (
    <main className="app-shell">
      <header className="topbar" inert={modalPanelOpen ? true : undefined} aria-hidden={modalPanelOpen || undefined}>
        <div className="brand">
          <span className="brand-logo-frame" aria-hidden="true" />
          <div className="brand-copy"><strong>星联体·天巡灾情实时预报系统</strong><small>SATELLITE UNION · TIANXUN DISASTER NOWCAST</small></div>
        </div>
        <div className="live-summary">
          <span className={`live-dot ${modeStale ? "stale" : ""}`} />
          <div><strong>{lastRefreshErrorAt ? "数据更新异常" : runtimeMode}</strong><small>{lastRefreshErrorAt ? `保留上次数据 · ${formatTimeWithYear(lastRefreshErrorAt)} 刷新失败` : data ? `${producingSourceCount} 个产出源 · ${data.events.length} 个事件` : "正在建立数据连接"}</small></div>
        </div>
        <div className="top-actions">
          <label className="search-box">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件或地区" aria-label="搜索事件或地区" />
          </label>
          <button className="icon-button" onClick={refresh} disabled={loading} title="立即刷新" aria-label="立即刷新">↻</button>
          <button ref={responseTriggerRef} className="response-queue-button" disabled={Boolean(data?.replay)} title={data?.replay ? "历史重演为只读模式" : undefined} onClick={() => openResponsePlanner()} aria-label={`打开处置推演场景，共${responseScenarios.length}项`}>
            处置推演 <b>{responseScenarios.length}</b>
          </button>
          <button ref={taskTriggerRef} className="task-queue-button" disabled={Boolean(data?.replay)} title={data?.replay ? "历史重演为只读模式" : undefined} onClick={() => { document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((details) => { details.open = false; }); setResponsePanelOpen(false); setActiveResponseScenarioId(null); setListOpen(false); setTaskPanelOpen(true); }} aria-label={`打开卫星任务候选单，共${tasks.length}项`}>
            任务候选 <b>{tasks.length}</b>
          </button>
          <div className="time-box"><strong>{chinaTime(clock)}</strong><small>UTC+08:00</small></div>
          {currentUser && onLogout ? <div className="session-control"><span><strong>{currentUser.username}</strong><small>{roleLabel(currentUser.role)}</small></span><button onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? "退出中…" : "安全退出"}</button></div> : null}
        </div>
      </header>

      <section className="control-strip" inert={modalPanelOpen ? true : undefined} aria-hidden={modalPanelOpen || undefined}>
        <div className="scope-tabs" role="group" aria-label="重点观测范围">
          <span className="strip-label">重点范围</span>
          {scopeOrder.map((id, index) => (
            <button key={id} onClick={() => setScope(id)} className={scope === id ? "active" : ""} aria-pressed={scope === id}>
              <i>{index + 1}</i><span>{scopes[id].label}</span><b>{scopeCounts[id] ?? 0}</b>
            </button>
          ))}
        </div>
        <SourceStatusPanel sources={data?.sourceStatus ?? []} forceClosed={modalPanelOpen} isAdmin={currentUser?.role === "admin"} replay={data?.replay} loading={loading} onReplay={loadReplay} onReturnLive={refresh} />
      </section>

      <section className={`workspace ${modalPanelOpen ? "tasks-open" : ""} ${responsePanelOpen ? "response-open" : ""}`}>
        <aside className={`event-panel ${listOpen ? "open" : "closed"}`} inert={!listOpen || modalPanelOpen ? true : undefined} aria-hidden={!listOpen || modalPanelOpen || undefined}>
          <div className="panel-heading">
            <div><p>{scopes[scope].label} · {runtimeMode}</p><h1>{filtered.length}<span> 个可观测事件</span></h1></div>
            <button onClick={() => setListOpen(false)} aria-label="收起列表">‹</button>
          </div>
          <div className="metrics-row">
            <div><span>高等级告警</span><strong>{severeCount}</strong><small>红 / 橙</small></div>
            <div><span>高优先事件</span><strong>{highPriorityCount}</strong><small>优先级 ≥ 70</small></div>
            <div><span>数据源</span><strong>{data?.sourceStatus.filter((s) => s.online).length ?? 0}</strong><small>在线连接</small></div>
            <div><span>时效剔除</span><strong>{data?.expiredCount ?? 0}</strong><small>已自动归档</small></div>
          </div>
          {data?.retainedCount ? <div className="retained-banner"><strong>{data.retainedCount}</strong> 个主事件当前未在短时源中复现，仍按既定观测期持续监测。</div> : null}
          {modeStale ? <div className="stale-banner" role="alert">{data?.replay ? "当前为历史重演，只能查看和筛选快照；任务、推演、告警和下发均已停用。" : `当前为${lastRefreshErrorAt ? "刷新失败后的保留结果" : runtimeMode}；可以保存候选草稿，但不能把本轮读取时间当作灾害观测时间，也不能计算、导出或进入下发复核。`}</div> : null}
          {data?.replay ? <div className="replay-banner" role="status"><strong>历史快照 · {formatTimeWithYear(data.replay.capturedAt)} UTC+08</strong><span>只读重演，不参与实时告警或任务下发。{data.replaySnapshotTruncated ? "该快照因存储上限仅保留高优先事件。" : ""}</span><button onClick={() => void refresh()}>返回实时</button></div> : null}
          <HazardFilters selected={hazard} onChange={setHazard} events={scopedEvents} />
          <SortControl selected={sortMode} onChange={setSortMode} />
          <TimeFilterControl windowValue={timeWindow} basis={timeBasis} phase={phaseFilter} onWindowChange={setTimeWindow} onBasisChange={setTimeBasis} onPhaseChange={setPhaseFilter} />
          {filtersActive ? <button className="clear-filters" onClick={clearFilters}>清除全部筛选</button> : null}
          {selectedOutsideFilters ? <div className="selection-outside-filter" role="status">当前详情不在筛选结果中，仍为你保留。<button onClick={clearFilters}>显示在列表中</button></div> : null}
          <ObservationPolicy />
          <div className="event-list">
            {loading && !data ? <LoadingList /> : null}
            {error && !data ? <EmptyState title="暂时无法连接数据源" detail="请检查网络后点击右上角刷新。" /> : null}
            {!loading && filtered.length === 0 ? <EmptyState title={`${scopes[scope].label}暂无匹配事件`} detail={query || hazard !== "all" || timeWindow !== "all" || phaseFilter !== "all" ? "当前搜索、时间、观测阶段或灾种筛选没有匹配结果，请调整筛选条件。" : modeStale ? "当前数据源未产出可用实时事件，请检查数据源状态。" : "当前范围没有满足条件的可观测事件。"} /> : null}
            {filtered.map((event) => (
              <EventCard key={event.masterEventId} event={event} active={selected?.masterEventId === event.masterEventId} onClick={() => selectEvent(event)} />
            ))}
          </div>
          <footer className="panel-footer">
            <span className={loading ? "syncing" : ""}>↻</span>
            {loading ? "正在同步…" : data ? `本轮读取 ${formatTimeWithYear(data.fetchedAt)} UTC+08 · 实时${data.processedCount}条 + 延续${data.retainedCount}条 · ${producingSourceCount}个来源产出` : "等待同步"}
          </footer>
        </aside>

        {!listOpen && <button className="reopen-panel" onClick={() => setListOpen(true)} inert={modalPanelOpen ? true : undefined} aria-hidden={modalPanelOpen || undefined}>事件列表 <b>{filtered.length}</b> ›</button>}

          <MapView scope={scope} events={filtered} selected={selected} exposureAssessment={selected ? exposureAssessments[selected.masterEventId] : undefined} terrainScreening={selected ? landslideTerrain[selected.masterEventId] : undefined} activeTask={activeTask} activeResponseScenario={activeResponseScenario} fleet={fleet} detailOpen={Boolean(selected) && !modalPanelOpen && !activeResponseScenario} layoutKey={`${modalPanelOpen}-${listOpen}-${activeResponseScenario?.scenarioId ?? "none"}`} obscured={mapObscured} responsePointPickTarget={responsePointPickTarget} onResponsePointPick={acceptResponsePointPick} onCancelResponsePointPick={() => { setResponsePointPickTarget(null); setResponsePanelOpen(true); }} onSelect={selectEvent} onCustomAoiChange={updateCustomAoi} onReturnToTask={() => setTaskPanelOpen(true)} onReturnToResponse={() => setResponsePanelOpen(true)} />

        <div className="map-legend" inert={modalPanelOpen ? true : undefined} aria-hidden={modalPanelOpen || undefined}>
          <span><i className="red" />红色</span><span><i className="orange" />橙色</span><span><i className="yellow" />黄色</span><span><i className="blue" />蓝色</span>
          <em />
          <span className="priority-ring">◎</span><span>重点范围加权</span>
          {selected?.cycloneForecast || activeTask?.cycloneForecast ? <><em /><span><i className="forecast-track-key" />官方路径</span><span><i className="forecast-impact-key" />风圈范围</span><span><i className="forecast-uncertainty-key" />路径不确定区</span></> : null}
          {selected && landslideTerrain[selected.masterEventId] ? <><em /><span><i className="landslide-terrain-key" />DEM 地形筛查 AOI</span></> : null}
          {selected && exposureAssessments[selected.masterEventId] ? <><em /><span><i className="exposure-aoi-key" />暴露度筛查 AOI</span><span><i className="exposure-facility-key" />OSM 关键设施</span></> : null}
          {activeResponseScenario ? <><em /><span><i className="response-route-clear-key" />未检出相交</span><span><i className="response-route-limited-key" />影响区内撤离</span><span><i className="response-route-blocked-key" />禁用/未核验</span>{activeResponseScenario.infrastructureFeatures?.length ? <span><i className="infrastructure-exposure-key" />OSM 设施暴露</span> : null}</> : null}
        </div>

        {selected && !activeResponseScenario && <DetailPanel key={`${selected.masterEventId}:${data?.replay?.snapshotId ?? "live"}`} event={selected} exposureAssessment={exposureAssessments[selected.masterEventId]} onExposureChange={(assessment) => setExposureAssessments((current) => { const next = { ...current }; if (assessment) next[selected.masterEventId] = assessment; else delete next[selected.masterEventId]; return next; })} currentUser={currentUser} nowMs={clock} compact={compactViewport} obscured={modalPanelOpen} dispatchBlocked={modeStale} historicalReadOnly={Boolean(data?.replay)} locationZh={locationZh[selected.id]} locationLoading={locationLoading === selected.id} locationState={locationState[selected.id]?.state} onRetryLocation={() => { setLocationState((current) => { const next = { ...current }; delete next[selected.id]; return next; }); setLocationRetry((value) => value + 1); }} taskAdded={tasks.some((task) => taskMatchesEvent(task, selected))} landslideTemplateCount={new Set(tasks.filter((task) => task.masterEventId === selected.masterEventId && ["ascending", "descending"].includes(String(task.orbitDirectionPreference))).map((task) => task.orbitDirectionPreference)).size} terrainScreening={landslideTerrain[selected.masterEventId]} onTerrainChange={(terrain) => setLandslideTerrain((current) => { const next = { ...current }; if (terrain) next[selected.masterEventId] = terrain; else delete next[selected.masterEventId]; return next; })} aoiConfirmed={confirmedAois.has(selected.masterEventId)} onConfirmAoi={(confirmed) => setConfirmedAois((current) => { const next = new Set(current); if (confirmed) next.add(selected.masterEventId); else next.delete(selected.masterEventId); return next; })} onAddTask={addTask} onAddLandslideTasks={addLandslideSarTasks} onResponsePlan={openResponsePlanner} onClose={closeSelected} />}
        <TaskPanel open={taskPanelOpen} tasks={tasks} syncState={taskSync} storageMode={taskStorageMode} fleet={fleet} activeTaskId={activeTaskId} onActivate={reviewTaskAoi} onUpdate={updateTask} onRemove={(taskId) => void removeTask(taskId)} onClose={closeTaskPanel} onRetry={saveTask} />
        <ResponsePlanPanel open={responsePanelOpen} event={responsePlanningEvent} events={deduplicatedEvents} scenarios={responseScenarios} activeScenarioId={activeResponseScenarioId} currentUserRole={currentUser?.role ?? "admin"} pickedPoint={responsePickedPoint} onRequestPointPick={requestResponsePointPick} onSave={saveResponseScenario} onActivate={reviewResponseScenario} onSelectRoute={selectResponseRoute} onRemove={removeResponseScenario} onChooseEvent={(event) => setResponseEventId(event.masterEventId)} onClose={closeResponsePanel} />
        {undoDraft ? <div className="task-undo-toast" role="status"><span>已删除本机草稿：{undoDraft.task.title}</span><button onClick={restoreDraft}>撤销</button></div> : null}
      </section>
    </main>
  );
}

function roleLabel(role: "viewer" | "operator" | "admin") {
  return role === "admin" ? "系统管理员" : role === "operator" ? "任务操作员" : "只读观察员";
}

function SourceStatusPanel({ sources, forceClosed, isAdmin, replay, loading, onReplay, onReturnLive }: { sources: SourceStatus[]; forceClosed: boolean; isAdmin: boolean; replay?: ApiResponse["replay"]; loading: boolean; onReplay: (asOf: string) => Promise<void>; onReturnLive: () => Promise<void> }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState(() => localDateTimeInput(new Date(Date.now() - 60 * 60_000)));
  const [replayError, setReplayError] = useState("");
  const [history, setHistory] = useState<Record<string, { loading?: boolean; error?: string; runs?: Array<Record<string, unknown>>; preview?: string }>>({});
  const effectiveOpen = open && !forceClosed;
  useEffect(() => {
    if (!effectiveOpen) return;
    const close = (event: MouseEvent | globalThis.KeyboardEvent) => {
      if (event instanceof globalThis.KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && detailsRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [effectiveOpen]);
  const online = sources.filter((source) => source.state === "online").length;
  const pending = sources.filter((source) => source.state === "needs_config").length;
  const loadSourceHistory = async (sourceId: string) => {
    setHistory((current) => ({ ...current, [sourceId]: { loading: true } }));
    try {
      const response = await fetch(`/api/sources?sourceId=${encodeURIComponent(sourceId)}`, { cache: "no-store" });
      const result = await response.json() as { runs?: Array<Record<string, unknown>>; error?: string };
      if (!response.ok) throw new Error(result.error || "抓取历史读取失败");
      setHistory((current) => ({ ...current, [sourceId]: { runs: result.runs ?? [] } }));
    } catch (historyError) {
      setHistory((current) => ({ ...current, [sourceId]: { error: historyError instanceof Error ? historyError.message : "抓取历史读取失败" } }));
    }
  };
  const loadPayloadPreview = async (sourceId: string, payloadSha256: string) => {
    setHistory((current) => ({ ...current, [sourceId]: { ...current[sourceId], loading: true, preview: undefined } }));
    try {
      const response = await fetch(`/api/sources?payload=${encodeURIComponent(payloadSha256)}`, { cache: "no-store" });
      const result = await response.json() as { payload?: { bodyText?: string; byteLength?: number; truncated?: number | boolean; contentType?: string }; error?: string };
      if (!response.ok || !result.payload) throw new Error(result.error || "响应预览读取失败");
      const metadata = `${result.payload.contentType || "未知格式"} · 原始 ${Number(result.payload.byteLength ?? 0)} 字节${result.payload.truncated ? " · 已限长" : ""}`;
      setHistory((current) => ({ ...current, [sourceId]: { ...current[sourceId], loading: false, preview: `${metadata}\n${result.payload?.bodyText ?? ""}` } }));
    } catch (previewError) {
      setHistory((current) => ({ ...current, [sourceId]: { ...current[sourceId], loading: false, error: previewError instanceof Error ? previewError.message : "响应预览读取失败" } }));
    }
  };
  return <details ref={detailsRef} className="source-status" open={effectiveOpen} onToggle={(event) => setOpen(!forceClosed && event.currentTarget.open)}>
    <summary><span><i className="online-dot" />{sources.length ? `数据源 ${online}/${sources.length}` : "数据源正在连接…"}</span>{pending ? <b>{pending} 待配置</b> : null}</summary>
    <div className="source-status-popover" role="dialog" aria-modal="false" aria-label="数据源运行状态">
      <div className="source-status-heading"><strong>数据源运行状态</strong><button type="button" onClick={() => setOpen(false)} aria-label="关闭数据源状态">×</button></div>
      <section className="replay-control">
        <h3>历史重演</h3>
        <p>读取最接近所选时刻的事件快照。历史模式只读，不触发告警、排程或下发。</p>
        <label>回看时刻（本机时间）<input type="datetime-local" value={asOf} max={localDateTimeInput(new Date())} onChange={(event) => setAsOf(event.target.value)} /></label>
        <div><button type="button" disabled={loading} onClick={async () => { setReplayError(""); try { await onReplay(new Date().toISOString()); } catch (loadError) { setReplayError(loadError instanceof Error ? loadError.message : "历史快照读取失败"); } }}>{loading ? "读取中…" : "最近快照"}</button><button type="button" disabled={loading || !asOf} onClick={async () => { setReplayError(""); try { const selectedMinute = new Date(asOf); selectedMinute.setSeconds(59, 999); await onReplay(selectedMinute.toISOString()); } catch (loadError) { setReplayError(loadError instanceof Error ? loadError.message : "历史快照读取失败"); } }}>按时刻载入</button>{replay ? <button type="button" disabled={loading} onClick={() => void onReturnLive()}>返回实时</button> : null}</div>
        {replayError ? <small role="alert">{replayError}</small> : null}
      </section>
      {(["中国第一批", "中国第二批", "基础", "第一优先级", "第二优先级"] as const).map((tier) => <section key={tier}>
        <h3>{tier}</h3>
        {sources.filter((source) => source.tier === tier).map((source) => <div key={source.name} className={`source-status-item ${source.state}`}>
          <i /><span><strong>{source.name}</strong><small>{source.role} · {sourceAuthorityLabel(source.authorityClass)} · {humanizeSourceStatus(source)}</small>{isAdmin ? <details className="source-governance"><summary>治理与技术详情</summary><dl><div><dt>轮询 / 延迟目标</dt><dd>{source.pollIntervalMinutes} 分钟 / {source.latencySloMinutes} 分钟</dd></div><div><dt>本轮耗时</dt><dd>{source.durationMs} ms · {source.attempts} 次尝试</dd></div><div><dt>更新语义</dt><dd>{source.updateSemantics}</dd></div><div><dt>几何语义</dt><dd>{source.geometrySemantics}</dd></div><div><dt>使用约束</dt><dd>{source.licenseNote}</dd></div></dl><code>{source.message}</code><button type="button" onClick={() => void loadSourceHistory(source.sourceId)}>查看最近抓取</button>{history[source.sourceId]?.loading ? <small>正在读取…</small> : history[source.sourceId]?.error ? <small role="alert">{history[source.sourceId].error}</small> : history[source.sourceId]?.runs ? <div className="source-run-list">{history[source.sourceId].runs?.length ? history[source.sourceId].runs?.slice(0, 8).map((run) => <p key={String(run.runId)}><time>{formatTimeWithYear(String(run.fetchedAt))}</time><b>{run.ok ? `HTTP ${run.httpStatus}` : "失败"}</b><span>{Number(run.durationMs)} ms</span>{run.payloadSha256 ? <button type="button" onClick={() => void loadPayloadPreview(source.sourceId, String(run.payloadSha256))}>响应预览</button> : null}</p>) : <small>保留期内暂无可关联的原始抓取记录。</small>}</div> : null}{history[source.sourceId]?.preview ? <pre className="source-payload-preview">{history[source.sourceId].preview}</pre> : null}</details> : null}</span><b>{source.state === "online" ? source.producing ? `${source.count} 条` : "连接正常" : source.state === "needs_config" ? "需配置" : "暂不可用"}</b><a href={safeHttpUrl(source.setupUrl)} target="_blank" rel="noreferrer">查看来源</a>
        </div>)}
      </section>)}
      <footer>区域通报只用于任务初筛；正式规划前仍需用权威矢量或实测数据复核范围。“核验”来源只补充证据，不生成任务坐标。</footer>
    </div>
  </details>;
}

function localDateTimeInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function sourceAuthorityLabel(value: SourceStatus["authorityClass"]) {
  return value === "official" ? "官方源" : value === "scientific" ? "科研机构" : value === "humanitarian" ? "人道信息" : "聚合源";
}

function humanizeSourceStatus(source: SourceStatus) {
  if (source.state === "online" && source.producing) return `本轮已接收 ${source.count} 条有效记录`;
  if (source.state === "online") return "连接正常，本轮暂无符合条件的新记录";
  if (source.state === "needs_config") return "尚未完成服务配置，请联系管理员";
  if (/timeout|timed out|fetch failed|ECONN|ENOTFOUND|HTTP\s*5/i.test(source.message)) return "上游服务暂时不可用，系统将保留上次有效结果";
  if (/key|token|credential|env|配置|认证/i.test(source.message)) return "服务凭据或访问配置需要管理员处理";
  return "本轮连接失败，系统将按既定观测期保留已有事件";
}

function SortControl({ selected, onChange }: { selected: SortMode; onChange: (value: SortMode) => void }) {
  return <div className="sort-control" role="group" aria-label="事件排序方式">
    <span>排序</span>
    <button aria-pressed={selected === "priority"} className={selected === "priority" ? "active" : ""} onClick={() => onChange("priority")}>综合优先</button>
    <button aria-pressed={selected === "occurred"} className={selected === "occurred" ? "active" : ""} onClick={() => onChange("occurred")}>最新发生</button>
    <button aria-pressed={selected === "updated"} className={selected === "updated" ? "active" : ""} onClick={() => onChange("updated")}>最新更新</button>
    <small>{selected === "priority" ? "实况与预报采用不同的时效曲线" : selected === "occurred" ? "按灾害发生/报文发布时间" : "按最新有效报次"}</small>
  </div>;
}

function TimeFilterControl({ windowValue, basis, phase, onWindowChange, onBasisChange, onPhaseChange }: { windowValue: TimeWindow; basis: TimeBasis; phase: PhaseFilter; onWindowChange: (value: TimeWindow) => void; onBasisChange: (value: TimeBasis) => void; onPhaseChange: (value: PhaseFilter) => void }) {
  const windows: Array<{ id: TimeWindow; label: string }> = [{ id: "all", label: "全部" }, { id: "1h", label: "1小时" }, { id: "6h", label: "6小时" }, { id: "24h", label: "24小时" }, { id: "7d", label: "7天" }];
  return <div className="time-filter-control" role="group" aria-label="事件时间与观测阶段筛选">
    <div><span>时间</span>{windows.map((item) => <button key={item.id} aria-pressed={windowValue === item.id} className={windowValue === item.id ? "active" : ""} onClick={() => onWindowChange(item.id)}>{item.label}</button>)}</div>
    <div><span>依据</span><button aria-pressed={basis === "updated"} className={basis === "updated" ? "active" : ""} onClick={() => onBasisChange("updated")}>最新更新</button><button aria-pressed={basis === "occurred"} className={basis === "occurred" ? "active" : ""} onClick={() => onBasisChange("occurred")}>发生时间</button></div>
    <label>观测阶段<select value={phase} onChange={(event) => onPhaseChange(event.target.value as PhaseFilter)}><option value="all">全部阶段</option><option value="forecast">预报候选期</option><option value="golden">黄金观测期</option><option value="followup">后续观测期</option><option value="archive">已归档</option></select></label>
  </div>;
}

function HazardFilters({ selected, onChange, events }: { selected: HazardType | "all"; onChange: (value: HazardType | "all") => void; events: DisasterEvent[] }) {
  const options: Array<HazardType | "all"> = ["all", "earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"];
  return <div className="hazard-filters" role="group" aria-label="灾害类型筛选">
    {options.map((id) => {
      const count = id === "all" ? events.length : events.filter((e) => e.hazard === id).length;
      return <button key={id} aria-pressed={selected === id} onClick={() => onChange(id)} className={selected === id ? "active" : ""}>
        {id === "all" ? "全部" : hazardMeta[id].label}<span>{count}</span>
      </button>;
    })}
  </div>;
}

function circularLongitude(values: number[]) {
  const sin = values.reduce((sum, value) => sum + Math.sin(value * Math.PI / 180), 0);
  const cos = values.reduce((sum, value) => sum + Math.cos(value * Math.PI / 180), 0);
  return Math.atan2(sin / values.length, cos / values.length) * 180 / Math.PI;
}

function EventCard({ event, active, onClick }: { event: DisasterEvent; active: boolean; onClick: () => void }) {
  const referenceTime = event.phenomenonStage === "observed" ? event.occurredAt : event.issuedAt;
  const cardTime = event.updateCount > 1 ? event.updatedAt : referenceTime;
  return <button data-event-id={event.id} className={`event-card ${event.severity} ${active ? "active" : ""}`} onClick={onClick}>
    <div className="hazard-icon">{hazardMeta[event.hazard].symbol}</div>
    <div className="event-copy">
      <div className="event-title-row"><h2>{event.title}</h2><span title={event.updateCount > 1 ? `首次 ${formatTimeWithYear(referenceTime)} · 最新 ${formatTimeWithYear(event.updatedAt)}` : `${formatTime(referenceTime)} · ${relativeTime(referenceTime)}`}>{event.updateCount > 1 ? "更新 " : ""}{formatCardTime(cardTime)}</span></div>
      <p>{event.country || `${event.latitude.toFixed(2)}°, ${event.longitude.toFixed(2)}°`}</p>
      <div className="event-tags">
        <span className="severity-tag">{severityLabels[event.severity]} · {phenomenonLabels[event.phenomenonStage]}</span>
        {event.hazardSubtype ? <span className="subtype-tag">{hazardSubtypeLabels[event.hazardSubtype]}</span> : null}
        {event.crossBorder ? <span className="cross-border-tag">跨境影响</span> : null}
        <span className={`phase-tag ${event.observationPhase}`}>{observationPhaseLabels[event.observationPhase]}</span>
        {event.sourcePresence === "retained" ? <span className="monitoring-tag">来源暂未复现</span> : null}
        {event.updateCount > 1 ? <span className="update-tag">{event.updateCount}期更新</span> : null}
        <span className={`confidence-tag ${event.confidenceLevel}`}>{confidenceLabels[event.confidenceLevel]} · {event.independentSourceCount ?? new Set(event.evidence.map((item) => item.source.split(" · ")[0])).size}源</span>
        <span className="time-weight-tag">时效 +{event.priorityBreakdown.time}</span>
        <span className={`impact-risk-tag ${event.impactRisk?.level ?? "undetermined"}`}>{event.impactRisk?.status === "assessed" ? `影响风险 ${impactRiskLabel(event.impactRisk.level)} ${event.impactRisk.score}` : `影响风险待评估 · 危险性 ${event.impactRisk?.hazardIndex ?? "—"}`}</span>
        <span>{event.observable === "direct" ? "直接可观测" : event.observable === "consequence" ? "灾后可观测" : "条件可观测"}</span>
      </div>
    </div>
    <div className="priority-score"><strong>{event.priority}</strong><small>优先级</small></div>
  </button>;
}

function MapView({ scope, events, selected, exposureAssessment, terrainScreening, activeTask, activeResponseScenario, fleet, detailOpen, layoutKey, obscured, responsePointPickTarget, onResponsePointPick, onCancelResponsePointPick, onSelect, onCustomAoiChange, onReturnToTask, onReturnToResponse }: { scope: ScopeId; events: DisasterEvent[]; selected: DisasterEvent | null; exposureAssessment?: ExposureAssessment; terrainScreening?: LandslideTerrainScreening; activeTask: SatelliteTask | null; activeResponseScenario: ResponseScenario | null; fleet: SatelliteFleetState; detailOpen: boolean; layoutKey: string; obscured: boolean; responsePointPickTarget: ResponsePointPickTarget | null; onResponsePointPick: (target: ResponsePointPickTarget, longitude: number, latitude: number) => void; onCancelResponsePointPick: () => void; onSelect: (event: DisasterEvent) => void; onCustomAoiChange: (taskId: string, geometry?: CustomAoiGeometry) => void; onReturnToTask: () => void; onReturnToResponse: () => void }) {
  const bbox = scopes[scope].bbox;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const selectedLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const taskForecastLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const aoiLayerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const opportunityLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const responseLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const exposureLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const drawPreviewLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const orbitLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const scopeRef = useRef(scope);
  const eventsRef = useRef(events);
  const onSelectRef = useRef(onSelect);
  const [mapReady, setMapReady] = useState(false);
  const [mapZoom, setMapZoom] = useState(2);
  const [mapError, setMapError] = useState("");
  const [viewLabel, setViewLabel] = useState("");
  const [forecastSelection, setForecastSelection] = useState<{ eventId: string; index: number }>({ eventId: "", index: 0 });
  const [drawing, setDrawing] = useState(false);
  const [drawingTaskId, setDrawingTaskId] = useState<string | null>(null);
  const [draftVertices, setDraftVertices] = useState<Array<[number, number]>>([]);
  const [drawingError, setDrawingError] = useState("");
  const [vertexLongitude, setVertexLongitude] = useState("");
  const [vertexLatitude, setVertexLatitude] = useState("");
  const [orbitsVisible, setOrbitsVisible] = useState(false);
  const [clusterSelection, setClusterSelection] = useState<DisasterEvent[]>([]);
  const activeTrackingSlice = useMemo(() => {
    if (activeTask?.hazard !== "cyclone" || !activeTask.closestApproachAt || !activeTask.timeIndexedAoi?.length) return undefined;
    return cycloneTrackingSliceAt(activeTask.timeIndexedAoi, activeTask.closestApproachAt);
  }, [activeTask]);
  const activeTrackingTarget = activeTask?.cycloneTrackingTarget ?? "center";
  const activeTrackingGeometry = useMemo(() => activeTrackingSlice
    ? cycloneTrackingGeometry(activeTrackingSlice, activeTrackingTarget)
    : null, [activeTrackingSlice, activeTrackingTarget]);
  const displayedCycloneForecast = activeTask?.hazard === "cyclone" ? activeTask.cycloneForecast : selected?.cycloneForecast;
  const forecastOwnerId = activeTask?.hazard === "cyclone" ? activeTask.taskId : selected?.id ?? "";
  const forecastFrames = displayedCycloneForecast?.impactField?.frames ?? [];
  const acquisitionForecastFrameIndex = nearestCycloneFrameIndex(forecastFrames, activeTask?.closestApproachAt);
  const forecastFrameIndex = forecastSelection.eventId === forecastOwnerId
    ? Math.min(forecastSelection.index, Math.max(0, forecastFrames.length - 1))
    : acquisitionForecastFrameIndex;
  const activeForecastFrame = forecastFrames[forecastFrameIndex];
  const browsingTaskForecast = Boolean(activeTask?.hazard === "cyclone" && activeForecastFrame && forecastFrameIndex !== acquisitionForecastFrameIndex);
  const detailOffset = useCallback(() => detailOpen && window.innerWidth > 720 ? Math.min(338, Math.max(0, (containerRef.current?.clientWidth ?? 0) - 180)) : 0, [detailOpen]);
  const fitWithOverlay = useCallback((map: import("leaflet").Map, bounds: import("leaflet").LatLngBoundsExpression, maxZoom: number) => {
    const overlay = detailOffset();
    map.fitBounds(bounds, { paddingTopLeft: [32, 32], paddingBottomRight: [32 + overlay, 32], maxZoom, animate: false });
  }, [detailOffset]);
  const centerWithOverlay = useCallback((map: import("leaflet").Map, latitude: number, longitude: number, zoom: number) => {
    map.setView([latitude, longitude], zoom, { animate: false });
    const overlay = detailOffset();
    if (overlay) map.panBy([overlay / 2, 0], { animate: false });
  }, [detailOffset]);

  useEffect(() => {
    scopeRef.current = scope;
    eventsRef.current = events;
    onSelectRef.current = onSelect;
  }, [events, onSelect, scope]);

  useEffect(() => {
    let disposed = false;
    let map: import("leaflet").Map | null = null;

    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      map = L.map(containerRef.current, {
        zoomControl: false,
        worldCopyJump: true,
        minZoom: 2,
        maxZoom: 16,
        attributionControl: true,
      });
      let tileFailures = 0;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).on("tileerror", () => {
        tileFailures += 1;
        if (tileFailures >= 3) setMapError("底图加载受限；灾害点和坐标数据仍可使用。");
      }).addTo(map);
      L.control.zoom({ position: "topright" }).addTo(map);
      markerLayerRef.current = L.layerGroup().addTo(map);
      selectedLayerRef.current = L.featureGroup().addTo(map);
      taskForecastLayerRef.current = L.featureGroup().addTo(map);
      opportunityLayerRef.current = L.featureGroup().addTo(map);
      responseLayerRef.current = L.featureGroup().addTo(map);
      exposureLayerRef.current = L.featureGroup().addTo(map);
      drawPreviewLayerRef.current = L.featureGroup().addTo(map);
      orbitLayerRef.current = L.featureGroup().addTo(map);
      mapRef.current = map;

      const updateView = () => {
        if (!map) return;
        const center = map.getCenter();
        setViewLabel(`${center.lat.toFixed(2)}° / ${center.lng.toFixed(2)}° · Z${map.getZoom()}`);
        setMapZoom(map.getZoom());
      };
      map.on("moveend zoomend", updateView);
      const currentBbox = scopes[scopeRef.current].bbox;
      map.fitBounds([[currentBbox[1], currentBbox[0]], [currentBbox[3], currentBbox[2]]], { padding: [24, 24], animate: false });
      updateView();
      setMapReady(true);
    }).catch(() => setMapError("地图组件初始化失败，请重试。"));

    return () => {
      disposed = true;
      if (map) map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      selectedLayerRef.current = null;
      taskForecastLayerRef.current = null;
      opportunityLayerRef.current = null;
      responseLayerRef.current = null;
      exposureLayerRef.current = null;
      drawPreviewLayerRef.current = null;
      orbitLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!mapReady || !map || !container) return;
    let frame = 0;
    const restoreView = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        map.invalidateSize({ pan: false });
        if (activeResponseScenario && responseLayerRef.current?.getBounds().isValid()) {
          fitWithOverlay(map, responseLayerRef.current.getBounds(), 11);
        } else if (activeTask) {
          const layer = aoiLayerRef.current;
          const bounds = layer?.getBounds();
          const opportunityBounds = opportunityLayerRef.current?.getBounds();
          if (bounds?.isValid()) {
            if (!activeTrackingSlice && opportunityBounds?.isValid()) bounds.extend(opportunityBounds);
            fitWithOverlay(map, bounds, activeTrackingSlice ? activeTrackingTarget === "center" ? 10 : 9 : activeTask.simulationLevel === "orbit_only" ? 7 : 11);
          }
        } else if (selected && (selected.cycloneForecast || terrainScreening) && selectedLayerRef.current?.getBounds().isValid()) {
          fitWithOverlay(map, selectedLayerRef.current.getBounds(), selected.cycloneForecast ? 7 : 11);
        } else if (selected) centerWithOverlay(map, selected.latitude, selected.longitude, Math.max(map.getZoom(), scope === "global" ? 4 : map.getZoom()));
        else map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [24, 24], animate: false });
        selectedLayerRef.current?.eachLayer((selectedLayer) => {
          if ("bringToFront" in selectedLayer && typeof selectedLayer.bringToFront === "function") selectedLayer.bringToFront();
        });
      }));
    };
    const observer = new ResizeObserver(restoreView);
    observer.observe(container);
    restoreView();
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [activeResponseScenario, activeTask, activeTrackingSlice, activeTrackingTarget, bbox, centerWithOverlay, fitWithOverlay, layoutKey, mapReady, scope, selected, terrainScreening]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [24, 24], animate: true, duration: 0.45 });
  }, [bbox, mapReady, scope]);

  const activeDrawing = drawing && drawingTaskId === activeTask?.taskId;
  const activeDraftVertices = useMemo(() => drawingTaskId === activeTask?.taskId ? draftVertices : [], [activeTask?.taskId, draftVertices, drawingTaskId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !activeDrawing || !activeTask || !["polygon", "multi"].includes(activeTask.aoiType)) return;
    const onMapClick = (event: import("leaflet").LeafletMouseEvent) => {
      setDrawingError("");
      setDraftVertices((current) => current.length >= 2000 ? current : [...current, [Number(event.latlng.lng.toFixed(7)), Number(event.latlng.lat.toFixed(7))]]);
    };
    map.getContainer().classList.add("aoi-drawing-cursor");
    map.on("click", onMapClick);
    return () => {
      map.getContainer().classList.remove("aoi-drawing-cursor");
      map.off("click", onMapClick);
    };
  }, [activeDrawing, activeTask, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !responsePointPickTarget || activeDrawing) return;
    const target = responsePointPickTarget;
    const onMapClick = (event: import("leaflet").LeafletMouseEvent) => onResponsePointPick(target, Number(event.latlng.lng.toFixed(7)), Number(event.latlng.lat.toFixed(7)));
    map.getContainer().classList.add("response-point-pick-cursor");
    map.on("click", onMapClick);
    return () => {
      map.getContainer().classList.remove("response-point-pick-cursor");
      map.off("click", onMapClick);
    };
  }, [activeDrawing, mapReady, onResponsePointPick, responsePointPickTarget]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = drawPreviewLayerRef.current;
    if (!mapReady || !map || !layer) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      layer.clearLayers();
      if (!activeDraftVertices.length) return;
      L.polyline(activeDraftVertices.map(([longitude, latitude]) => [latitude, longitude]), { color: "#005a87", weight: 3, dashArray: "5 4" }).addTo(layer);
      activeDraftVertices.forEach(([longitude, latitude], index) => L.circleMarker([latitude, longitude], { radius: index === 0 ? 5 : 3, color: "#005a87", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(layer));
      if (activeDraftVertices.length >= 3) L.polygon(activeDraftVertices.map(([longitude, latitude]) => [latitude, longitude]), { color: "#005a87", weight: 1, fillColor: "#54a8c6", fillOpacity: 0.14 }).addTo(layer);
    });
    return () => { cancelled = true; };
  }, [activeDraftVertices, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!mapReady || !map || !layer) return;
    let cancelled = false;

    void import("leaflet").then((L) => {
      if (cancelled) return;
      layer.clearLayers();
      const groups = new Map<string, DisasterEvent[]>();
      eventsRef.current.forEach((event) => {
        const projected = map.project([event.latitude, event.longitude], map.getZoom());
        const grid = map.getZoom() >= 9 ? 26 : 48;
        const key = `${Math.floor(projected.x / grid)}:${Math.floor(projected.y / grid)}`;
        groups.set(key, [...(groups.get(key) ?? []), event]);
      });
      groups.forEach((group) => {
        if (group.length > 1) {
          const orderedGroup = [...group].sort((left, right) => severityRanks[right.severity] - severityRanks[left.severity] || right.priority - left.priority);
          const dominantSeverity = orderedGroup[0].severity;
          const latitude = group.reduce((sum, event) => sum + event.latitude, 0) / group.length;
          const longitude = circularLongitude(group.map((event) => event.longitude));
          const cluster = L.marker([latitude, longitude], {
            icon: L.divIcon({ className: "event-div-icon", html: `<span class="geo-cluster ${dominantSeverity}"><b>${group.length}</b></span>`, iconSize: [38, 38], iconAnchor: [19, 19] }),
            title: `${group.length} 个邻近灾害事件`, keyboard: true,
          });
          cluster.bindTooltip(`${group.length} 个共址/邻近事件：${orderedGroup.slice(0, 4).map((event) => event.title).join("；")}${group.length > 4 ? "…" : ""}`, { direction: "top", offset: [0, -17] });
          cluster.on("click", () => map.getZoom() >= 12 ? setClusterSelection(orderedGroup) : map.setView([latitude, longitude], Math.min(12, map.getZoom() + 3), { animate: true }));
          cluster.addTo(layer);
          return;
        }
        const event = group[0];
        const isPrioritized = event.scope !== "global";
        const icon = L.divIcon({
          className: "event-div-icon",
          html: `<span class="geo-marker ${event.severity}${isPrioritized ? " prioritized" : ""}"><b>${hazardMeta[event.hazard].symbol}</b></span>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
        const marker = L.marker([event.latitude, event.longitude], {
          icon,
          title: event.title,
          riseOnHover: true,
          keyboard: true,
        });
        const tooltip = document.createElement("span");
        tooltip.textContent = event.title;
        marker.bindTooltip(tooltip, { direction: "top", offset: [0, -15], opacity: 0.94 });
        marker.on("click", () => onSelectRef.current(event));
        marker.addTo(layer);
      });
    });

    return () => { cancelled = true; };
  }, [events, mapReady, mapZoom]);

  useEffect(() => {
    const layer = orbitLayerRef.current;
    if (!mapReady || !layer) return;
    layer.clearLayers();
    if (!orbitsVisible) return;
    const drawable = fleet.satellites.filter((satellite) => satellite.orbitStatus === "current" && satellite.tleLine1 && satellite.tleLine2);
    if (!drawable.length) return;
    let cancelled = false;
    let positionTimer = 0;
    let trackTimer = 0;
    void Promise.all([import("leaflet"), import("../lib/orbit-simulation")]).then(([L, orbit]) => {
      if (cancelled) return;
      const markers = new Map<number, import("leaflet").Marker>();
      const colors = ["#087bd3", "#00a6c7", "#6558d3", "#1f8f70", "#d27316", "#b83f76"];
      const labelOf = (satellite: SatelliteOrbitView) => satellite.commonCode || satellite.interfaceName || satellite.commonName;
      const updateTooltip = (marker: import("leaflet").Marker, satellite: SatelliteOrbitView, position: NonNullable<ReturnType<typeof orbit.propagateTle>>) => {
        const tooltip = document.createElement("span");
        tooltip.textContent = `${labelOf(satellite)} · NORAD ${satellite.noradId} · ${position.direction === "ascending" ? "升轨" : "降轨"} · 高度 ${Math.round(position.altitudeKm)} km · ${formatTimeWithYear(position.at)} UTC+08`;
        marker.setTooltipContent(tooltip);
      };
      const buildLayers = () => {
        layer.clearLayers();
        markers.clear();
        const now = new Date();
        drawable.forEach((satellite, index) => {
          const line1 = satellite.tleLine1!;
          const line2 = satellite.tleLine2!;
          const position = orbit.propagateTle(line1, line2, now);
          if (!position) return;
          const color = colors[index % colors.length];
          const track = orbit.buildGroundTrack(line1, line2, now);
          track.past.forEach((segment) => L.polyline(segment, { pane: "overlayPane", color, weight: 1.5, opacity: 0.48, dashArray: "4 5", interactive: false }).addTo(layer));
          track.future.forEach((segment) => L.polyline(segment, { pane: "overlayPane", color, weight: 2.2, opacity: 0.86, interactive: false }).addTo(layer));
          const marker = L.marker([position.latitude, position.longitude], {
            icon: L.divIcon({ className: "satellite-div-icon", html: `<span class="satellite-live-marker satellite-color-${index % colors.length}">✦</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
            title: `${labelOf(satellite)} TLE外推位置`,
            keyboard: true,
            zIndexOffset: 900,
          });
          marker.bindTooltip("", { direction: "top", offset: [0, -13], opacity: 0.96 });
          updateTooltip(marker, satellite, position);
          marker.addTo(layer);
          markers.set(satellite.noradId, marker);
        });
      };
      const updatePositions = () => {
        const now = new Date();
        drawable.forEach((satellite) => {
          const marker = markers.get(satellite.noradId);
          if (!marker || !satellite.tleLine1 || !satellite.tleLine2) return;
          const position = orbit.propagateTle(satellite.tleLine1, satellite.tleLine2, now);
          if (!position) return;
          marker.setLatLng([position.latitude, position.longitude]);
          updateTooltip(marker, satellite, position);
        });
      };
      buildLayers();
      positionTimer = window.setInterval(updatePositions, 1_000);
      trackTimer = window.setInterval(buildLayers, 60_000);
    }).catch(() => setMapError("卫星轨道外推组件加载失败；灾害地图仍可使用。"));
    return () => {
      cancelled = true;
      window.clearInterval(positionTimer);
      window.clearInterval(trackTimer);
      layer.clearLayers();
    };
  }, [fleet.satellites, mapReady, orbitsVisible]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = selectedLayerRef.current;
    if (!mapReady || !map || !layer) return;
    layer.clearLayers();
    if (!selected) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      const forecast = selected.cycloneForecast;
      const impactFrame = forecast?.impactField?.frames[Math.min(forecastFrameIndex, Math.max(0, forecast.impactField.frames.length - 1))];
      const addCycloneArea = (
        geometry: DisasterEvent["geometry"],
        referenceLongitude: number,
        style: L.PathOptions,
      ) => {
        const unwrapped = unwrapForecastGeometry(geometry, referenceLongitude) as GeoJSON.GeoJsonObject;
        const outline = antimeridianOutlineGeometry(geometry, referenceLongitude);
        if (!outline) {
          L.geoJSON(unwrapped, { style, interactive: false }).addTo(layer);
          return;
        }
        L.geoJSON(unwrapped, { style: { ...style, stroke: false }, interactive: false }).addTo(layer);
        L.geoJSON(outline as GeoJSON.GeoJsonObject, { style: { ...style, fill: false }, interactive: false }).addTo(layer);
      };
      if (selected.geometry && selected.geometry.type !== "Point") {
        L.geoJSON(unwrapForecastGeometry(selected.geometry, selected.longitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#087bd3", weight: 3, fillColor: "#4ba9e8", fillOpacity: 0.12, dashArray: "4 3", className: "selected-source-geometry" },
          interactive: false,
        }).addTo(layer);
      }
      if (terrainScreening) {
        const terrainLayer = L.geoJSON(terrainScreening.geometry as GeoJSON.GeoJsonObject, {
          style: { color: "#9a5a10", weight: 1.5, fillColor: "#f2b84b", fillOpacity: 0.22, dashArray: "3 3", className: "landslide-terrain-screening" },
          interactive: true,
        });
        terrainLayer.bindTooltip(`DEM 地形筛查 AOI · ${terrainScreening.selectedCellCount} 个格网 · 最大近似坡度 ${terrainScreening.maximumSlopeDeg}°`, { sticky: true });
        terrainLayer.addTo(layer);
      }
      if (forecast?.impactGeometry && !forecast.impactField) {
        addCycloneArea(forecast.impactGeometry, selected.longitude, {
          color: "#c15624", weight: 1.5, fillColor: "#e58a42", fillOpacity: 0.16, className: "cyclone-impact-area",
        });
      }
      if (forecast?.uncertaintyGeometry) {
        addCycloneArea(forecast.uncertaintyGeometry, selected.longitude, {
          color: "#6b5aa6", weight: 1.5, fillColor: "#8c79bd", fillOpacity: 0.10, dashArray: "5 4", className: "cyclone-uncertainty-area",
        });
      }
      if (impactFrame) {
        const frameUncertainty = cycloneUncertaintyGeometry(impactFrame);
        if (frameUncertainty) {
          addCycloneArea(frameUncertainty, impactFrame.longitude, {
            color: "#6b5aa6", weight: 2, fillColor: "#8c79bd", fillOpacity: 0.16, dashArray: "4 3", className: "cyclone-frame-uncertainty",
          });
        }
        [...impactFrame.windFields].sort((left, right) => left.thresholdKnots - right.thresholdKnots).forEach((field) => {
          const color = field.thresholdKnots >= 64 ? "#a72222" : field.thresholdKnots >= 50 ? "#cf552f" : "#e58a42";
          addCycloneArea(cycloneWindGeometry(impactFrame, field), impactFrame.longitude, {
            color, weight: 1.8, fillColor: color, fillOpacity: field.thresholdKnots >= 64 ? 0.22 : 0.12, className: `cyclone-wind-${field.thresholdKnots}`,
          });
        });
        const frameCenter = L.circleMarker([impactFrame.latitude, unwrapLongitudeNear(impactFrame.longitude, selected.longitude)], {
          radius: impactFrame.centerBasis === "official_node" ? 7 : 5,
          color: impactFrame.centerBasis === "official_node" ? "#075fa8" : "#4b87b5",
          weight: 2,
          fillColor: impactFrame.centerBasis === "official_node" ? "#fff" : "#dcebf4",
          fillOpacity: 1,
          className: "cyclone-impact-frame-center",
        });
        frameCenter.bindTooltip(`${impactFrame.centerBasis === "official_node" ? "官方节点" : "官方节点间逐时插值"} · +${impactFrame.leadHours}小时 · ${formatTimeWithYear(impactFrame.forecastAt)} UTC+08`, { direction: "top" });
        frameCenter.addTo(layer);
      }
      if (forecast) {
        L.geoJSON(unwrapForecastGeometry(forecast.trackGeometry, selected.longitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#075fa8", weight: 3, opacity: 0.9, dashArray: "8 5", className: "cyclone-forecast-track" },
          interactive: false,
        }).addTo(layer);
        forecast.track.forEach((point) => {
          const marker = L.circleMarker([point.latitude, unwrapLongitudeNear(point.longitude, selected.longitude)], {
            radius: point.leadHours === 0 ? 6 : 4,
            color: "#075fa8",
            weight: 2,
            fillColor: "#fffdf8",
            fillOpacity: 1,
            interactive: true,
            className: "cyclone-forecast-point",
          });
          marker.bindTooltip(`${point.leadHours === 0 ? "实况" : `+${point.leadHours}小时`} · ${formatTimeWithYear(point.forecastAt)} UTC+08${point.windSpeedKnots !== undefined ? ` · ${point.windSpeedKnots} kt` : ""}`, { direction: "top" });
          marker.addTo(layer);
        });
      }
      L.circleMarker([selected.latitude, selected.longitude], { radius: 20, color: "#087bd3", weight: 3, fill: false, interactive: false, className: "selected-event-ring" }).addTo(layer);
      if (!activeTask && layer.getBounds().isValid() && (forecast || terrainScreening || (selected.geometry && selected.geometry.type !== "Point"))) fitWithOverlay(map, layer.getBounds(), forecast ? 7 : terrainScreening ? 11 : 9);
    });
    return () => { cancelled = true; };
  }, [activeTask, fitWithOverlay, forecastFrameIndex, mapReady, selected, terrainScreening]);

  useEffect(() => {
    if (!mapReady || !selected || selected.cycloneForecast || terrainScreening || (selected.geometry && selected.geometry.type !== "Point") || !mapRef.current) return;
    const map = mapRef.current;
    const targetZoom = Math.max(map.getZoom(), scope === "global" ? 4 : map.getZoom());
    if (detailOpen) centerWithOverlay(map, selected.latitude, selected.longitude, targetZoom);
    else map.flyTo([selected.latitude, selected.longitude], targetZoom, { animate: true, duration: 0.45 });
  }, [centerWithOverlay, detailOpen, mapReady, scope, selected, terrainScreening]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = taskForecastLayerRef.current;
    if (!mapReady || !map || !layer) return;
    layer.clearLayers();
    if (activeTask?.hazard !== "cyclone" || !displayedCycloneForecast || !activeForecastFrame) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      const referenceLongitude = activeForecastFrame.longitude;
      const focusBounds = L.latLngBounds([]);
      const addArea = (geometry: DisasterEvent["geometry"], style: L.PathOptions) => {
        const unwrapped = unwrapForecastGeometry(geometry, referenceLongitude) as GeoJSON.GeoJsonObject;
        const outline = antimeridianOutlineGeometry(geometry, referenceLongitude);
        const areaLayer = L.geoJSON(unwrapped, { style: outline ? { ...style, stroke: false } : style, interactive: true });
        areaLayer.bindTooltip(`任务 4D 预报片 · +${activeForecastFrame.leadHours}小时 · ${formatTimeWithYear(activeForecastFrame.forecastAt)} UTC+08`, { sticky: true });
        areaLayer.addTo(layer);
        if (outline) L.geoJSON(outline as GeoJSON.GeoJsonObject, { style: { ...style, fill: false }, interactive: false }).addTo(layer);
        const bounds = areaLayer.getBounds();
        if (bounds.isValid()) focusBounds.extend(bounds);
      };
      if (displayedCycloneForecast.uncertaintyGeometry) {
        L.geoJSON(unwrapForecastGeometry(displayedCycloneForecast.uncertaintyGeometry, referenceLongitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#7565aa", weight: 1, fillColor: "#9587bd", fillOpacity: 0.05, dashArray: "7 6", className: "task-cyclone-advisory-uncertainty" },
          interactive: false,
        }).addTo(layer);
      }
      const frameUncertainty = cycloneUncertaintyGeometry(activeForecastFrame);
      if (frameUncertainty) addArea(frameUncertainty, { color: "#6b5aa6", weight: 2, fillColor: "#8c79bd", fillOpacity: 0.16, dashArray: "4 3", className: "task-cyclone-frame-uncertainty" });
      [...activeForecastFrame.windFields].sort((left, right) => left.thresholdKnots - right.thresholdKnots).forEach((field) => {
        const color = field.thresholdKnots >= 64 ? "#a72222" : field.thresholdKnots >= 50 ? "#cf552f" : "#e58a42";
        addArea(cycloneWindGeometry(activeForecastFrame, field), { color, weight: 1.8, fillColor: color, fillOpacity: field.thresholdKnots >= 64 ? 0.22 : 0.12, className: `task-cyclone-wind-${field.thresholdKnots}` });
      });
      L.geoJSON(unwrapForecastGeometry(displayedCycloneForecast.trackGeometry, referenceLongitude) as GeoJSON.GeoJsonObject, {
        style: { color: "#075fa8", weight: 3, opacity: 0.9, dashArray: "8 5", className: "task-cyclone-forecast-track" },
        interactive: false,
      }).addTo(layer);
      displayedCycloneForecast.track.forEach((point) => {
        const marker = L.circleMarker([point.latitude, unwrapLongitudeNear(point.longitude, referenceLongitude)], {
          radius: point.leadHours === 0 ? 6 : 4,
          color: "#075fa8",
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
          className: "task-cyclone-forecast-point",
        });
        marker.bindTooltip(`${point.leadHours === 0 ? "实况" : `+${point.leadHours}小时`} · ${formatTimeWithYear(point.forecastAt)} UTC+08`, { direction: "top" });
        marker.addTo(layer);
      });
      const frameCenter = L.circleMarker([activeForecastFrame.latitude, unwrapLongitudeNear(activeForecastFrame.longitude, referenceLongitude)], {
        radius: 7,
        color: browsingTaskForecast ? "#c15624" : "#075fa8",
        weight: 3,
        fillColor: "#ffffff",
        fillOpacity: 1,
        className: browsingTaskForecast ? "task-cyclone-browsed-center" : "task-cyclone-acquisition-frame",
      });
      frameCenter.bindTooltip(`${browsingTaskForecast ? "正在浏览预测片" : "拍摄时刻最近预测片"} · +${activeForecastFrame.leadHours}小时 · ${formatTimeWithYear(activeForecastFrame.forecastAt)} UTC+08`, { direction: "top" });
      frameCenter.addTo(layer);
      focusBounds.extend(frameCenter.getLatLng());
      if (focusBounds.isValid()) fitWithOverlay(map, focusBounds, activeForecastFrame.windFields.length || frameUncertainty ? 8 : 9);
    }).catch(() => setMapError("任务 4D 台风路径无法绘制；已选卫星机会仍可继续使用。"));
    return () => { cancelled = true; layer.clearLayers(); };
  }, [activeForecastFrame, activeTask, browsingTaskForecast, displayedCycloneForecast, fitWithOverlay, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      if (aoiLayerRef.current) aoiLayerRef.current.removeFrom(map);
      aoiLayerRef.current = null;
      if (!activeTask) return;
      const geometry = activeTrackingGeometry ?? buildTaskAoi(activeTask as unknown as Record<string, unknown>);
      if (!geometry) return;
      const referenceLongitude = activeTrackingSlice?.center[0] ?? activeTask.longitude;
      const layer = L.geoJSON(unwrapForecastGeometry(geometry as DisasterEvent["geometry"], referenceLongitude) as GeoJSON.GeoJsonObject, {
        style: { color: activeTrackingSlice ? "#0076c9" : "#006d63", weight: 3, fillColor: activeTrackingSlice ? "#49a9e8" : "#46a795", fillOpacity: 0.2, dashArray: "6 4" },
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          radius: activeTrackingSlice ? 10 : 7,
          color: activeTrackingSlice ? "#005da6" : "#006d63",
          weight: 3,
          fillColor: "#ffffff",
          fillOpacity: 1,
          className: activeTrackingSlice ? "cyclone-opportunity-target" : "task-point-aoi",
        }),
      }).addTo(map);
      if (activeTrackingSlice) {
        const targetLabel = activeTrackingTarget === "center" ? "预测中心" : activeTrackingTarget === "wind_field" ? `${activeTrackingSlice.thresholdKnots ?? "最低阈值"} kt 风圈` : "路径不确定区";
        layer.bindTooltip(`拍摄时刻台风${targetLabel} · +${activeTrackingSlice.leadHours}小时 · ${formatTimeWithYear(activeTask.closestApproachAt!)} UTC+08 · 中心 ${activeTrackingSlice.center[1].toFixed(3)}°, ${activeTrackingSlice.center[0].toFixed(3)}°`, { sticky: true });
      }
      aoiLayerRef.current = layer;
      const bounds = layer.getBounds();
      if (bounds.isValid() && (activeTrackingSlice || activeTask.simulationLevel !== "orbit_only")) fitWithOverlay(map, bounds, activeTrackingTarget === "center" ? 10 : 9);
    });
    return () => { cancelled = true; };
  }, [activeTask, activeTrackingGeometry, activeTrackingSlice, activeTrackingTarget, fitWithOverlay, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = opportunityLayerRef.current;
    if (!mapReady || !map || !layer) return;
    layer.clearLayers();
    if (!activeTask || !["orbit_only", "assumed_sensor"].includes(String(activeTask.simulationLevel)) || !activeTask.closestApproachAt || !activeTask.satelliteNoradId) return;
    const satellite = fleet.satellites.find((candidate) => candidate.noradId === activeTask.satelliteNoradId && candidate.orbitStatus === "current" && candidate.tleLine1 && candidate.tleLine2);
    if (!satellite) return;
    let cancelled = false;
    void Promise.all([import("leaflet"), import("../lib/orbit-simulation")]).then(([L, orbit]) => {
      if (cancelled) return;
      const at = new Date(activeTask.closestApproachAt!);
      const position = orbit.propagateTle(satellite.tleLine1!, satellite.tleLine2!, at);
      if (!position) return;
      const targetLatitude = activeTrackingSlice?.center[1] ?? activeTask.latitude;
      const targetLongitude = activeTrackingSlice?.center[0] ?? activeTask.longitude;
      const displaySubpointLongitude = unwrapLongitudeNear(position.longitude, targetLongitude);
      // Keep the review overlay close to the actual coarse-screening interval;
      // a full orbital arc would dwarf the AOI and falsely resemble a swath.
      const assumedSensor = activeTask.simulationLevel === "assumed_sensor";
      const track = orbit.buildGroundTrack(satellite.tleLine1!, satellite.tleLine2!, at, assumedSensor ? 0.25 : 2, assumedSensor ? 0.25 : 2, assumedSensor ? 5 : 15);
      [...track.past, ...track.future].forEach((segment) => L.polyline(segment.map(([latitude, longitude]) => [latitude, unwrapLongitudeNear(longitude, targetLongitude)]), { color: "#6546b3", weight: 3, opacity: 0.92, dashArray: "8 4", interactive: false, className: "selected-opportunity-track" }).addTo(layer));
      const radiusKm = activeTask.orbitSearchRadiusKm ?? 350;
      let searchCircle: import("leaflet").Circle | null = null;
      if (activeTask.simulationLevel === "orbit_only") {
        searchCircle = L.circle([position.latitude, displaySubpointLongitude], { radius: radiusKm * 1_000, color: "#6546b3", weight: 2, fillColor: "#8d78cf", fillOpacity: 0.08, dashArray: "6 5", className: "selected-opportunity-search-circle" });
        searchCircle.bindTooltip(`TLE 轨道粗筛搜索圈 · 半径 ${radiusKm} km（不是 SAR 幅宽）`, { sticky: true });
        searchCircle.addTo(layer);
      } else {
        const lookLine = L.polyline([[position.latitude, displaySubpointLongitude], [targetLatitude, targetLongitude]], { color: "#6546b3", weight: 2, opacity: 0.8, dashArray: "5 4", interactive: true });
        lookLine.bindTooltip(`假设传感器侧视关系 · 地面轨迹距拍摄时刻 AOI 中心约 ${activeTask.minimumGroundTrackDistanceKm ?? "--"} km`, { sticky: true });
        lookLine.addTo(layer);
      }
      const closestMarker = L.circleMarker([position.latitude, displaySubpointLongitude], { radius: 7, color: "#6546b3", weight: 3, fillColor: "#fff", fillOpacity: 1, className: "selected-opportunity-subpoint" });
      closestMarker.bindTooltip(`${satellite.interfaceName || satellite.commonName} · 最近子星点 · ${formatTimeWithYear(position.at)} UTC+08 · ${position.direction === "ascending" ? "升轨" : "降轨"} · 距拍摄时刻 AOI 中心约 ${activeTask.minimumGroundTrackDistanceKm ?? "--"} km`, { direction: "top" });
      closestMarker.addTo(layer);
      const aoiBounds = aoiLayerRef.current?.getBounds();
      if (assumedSensor && activeTask.opportunityFootprint) {
        const footprintLayer = L.geoJSON(unwrapForecastGeometry(activeTask.opportunityFootprint as DisasterEvent["geometry"], targetLongitude) as GeoJSON.GeoJsonObject, { style: { color: "#006dc7", weight: 3, fillColor: "#2c8ee0", fillOpacity: 0.18, dashArray: "7 4", className: "selected-opportunity-footprint" } }).addTo(layer);
        footprintLayer.bindTooltip(`${activeTask.imagingMode ?? "成像模式"} · 标称场景 ${activeTask.opportunitySceneCrossTrackKm ?? "--"}×${activeTask.opportunitySceneAlongTrackKm ?? "--"} km · 预计覆盖 ${activeTask.opportunityCoveragePercent ?? "--"}%`, { sticky: true });
        const focusBounds = footprintLayer.getBounds();
        if (aoiBounds?.isValid()) focusBounds.extend(aoiBounds);
        if (focusBounds.isValid()) fitWithOverlay(map, focusBounds, 12);
      } else {
        const focusBounds = L.latLngBounds([[position.latitude, displaySubpointLongitude], [targetLatitude, targetLongitude]]);
        if (searchCircle) focusBounds.extend(searchCircle.getBounds());
        if (aoiBounds?.isValid()) focusBounds.extend(aoiBounds);
        if (focusBounds.isValid()) fitWithOverlay(map, focusBounds, activeTrackingSlice ? 9 : 7);
      }
    }).catch(() => setMapError("已选 TLE 轨道机会无法绘制；AOI 和任务字段仍可使用。"));
    return () => { cancelled = true; layer.clearLayers(); };
  }, [activeTask, activeTrackingSlice, fitWithOverlay, fleet.satellites, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = exposureLayerRef.current;
    if (!mapReady || !map || !layer) return;
    layer.clearLayers();
    if (!selected || !exposureAssessment || exposureAssessment.masterEventId !== selected.masterEventId) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      const aoiLayer = L.geoJSON(unwrapForecastGeometry(exposureAssessment.aoi.geometry, selected.longitude) as GeoJSON.GeoJsonObject, {
        style: { color: "#087bd3", weight: 2, fillColor: "#35a5e8", fillOpacity: 0.09, dashArray: exposureAssessment.aoi.basis === "derived_screening_buffer" ? "6 5" : undefined, className: "exposure-assessment-aoi" },
        interactive: true,
      });
      aoiLayer.bindTooltip(`暴露度 AOI · ${exposureAssessment.aoi.label} · ${Math.round(exposureAssessment.aoi.areaKm2).toLocaleString()} km²`, { sticky: true });
      aoiLayer.addTo(layer);
      aoiLayer.bringToBack();
      exposureAssessment.osm.facilities.forEach((facility) => {
        const color = exposureFacilityColor(facility.kind);
        const marker = L.circleMarker([facility.latitude, facility.longitude], { radius: 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95, className: `exposure-facility ${facility.kind}` });
        marker.bindTooltip(`${exposureFacilityKindLabel(facility.kind)} · ${facility.name} · OSM 已映射点位`, { direction: "top" });
        marker.addTo(layer);
      });
      if (!activeTask && !activeResponseScenario && layer.getBounds().isValid()) fitWithOverlay(map, layer.getBounds(), 11);
    }).catch(() => setMapError("暴露度 AOI 或关键设施图层无法绘制；统计结果仍可查看。"));
    return () => { cancelled = true; layer.clearLayers(); };
  }, [activeResponseScenario, activeTask, exposureAssessment, fitWithOverlay, mapReady, selected]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = responseLayerRef.current;
    if (!mapReady || !map || !layer) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      layer.clearLayers();
      if (!activeResponseScenario) return;
      const referenceLongitude = activeResponseScenario.origin[0];
      activeResponseScenario.routes.forEach((route) => {
        const color = route.status === "clear" ? "#14825f" : route.status === "limited" ? "#d18119" : route.status === "blocked" ? "#c43d35" : "#7869a8";
        const selectedRoute = route.routeId === activeResponseScenario.selectedRouteId;
        const routeLayer = L.geoJSON(unwrapForecastGeometry(route.geometry, referenceLongitude) as GeoJSON.GeoJsonObject, {
          style: { color, weight: selectedRoute ? 6 : 3, opacity: selectedRoute ? 0.95 : 0.55, dashArray: route.status === "unverified" ? "7 5" : route.status === "blocked" ? "4 5" : undefined, className: `response-route ${route.status}${selectedRoute ? " selected" : ""}` },
          interactive: true,
        });
        routeLayer.bindTooltip(`${route.label} · ${responseRouteStatusLabel(route.status)} · ${route.distanceKm.toFixed(1)} km`, { sticky: true });
        routeLayer.addTo(layer);
      });
      (activeResponseScenario.roadDisruptions ?? []).forEach((disruption) => {
        const verified = disruption.verification === "verified";
        const color = disruption.impact === "blocked" ? "#a72222" : "#c78327";
        const disruptionLayer = L.geoJSON(unwrapForecastGeometry(disruption.geometry as DisasterEvent["geometry"], referenceLongitude) as GeoJSON.GeoJsonObject, {
          style: { color, weight: verified ? 4 : 3, opacity: verified ? 0.95 : 0.7, fillColor: color, fillOpacity: 0.2, dashArray: verified ? undefined : "6 5", className: `road-disruption ${disruption.impact} ${disruption.verification}` },
          pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: Math.max(6, Math.min(16, disruption.radiusMeters / 25)), color, weight: verified ? 4 : 3, fillColor: color, fillOpacity: 0.35, dashArray: verified ? undefined : "5 4", className: `road-disruption ${disruption.impact} ${disruption.verification}` }),
          interactive: true,
        });
        disruptionLayer.bindTooltip(`${roadDisruptionKindLabel(disruption.kind)} · ${disruption.label} · ${verified ? "已核验" : "上报待核验"}`, { sticky: true });
        disruptionLayer.addTo(layer);
      });
      (activeResponseScenario.infrastructureFeatures ?? []).forEach((feature) => {
        const color = feature.kind === "bridge" ? "#6847a6" : feature.kind === "tunnel" ? "#334b73" : "#087fa1";
        const infrastructureLayer = L.geoJSON(unwrapForecastGeometry(feature.geometry as DisasterEvent["geometry"], referenceLongitude) as GeoJSON.GeoJsonObject, {
          style: { color, weight: 5, opacity: 0.9, dashArray: feature.kind === "tunnel" ? "7 4" : undefined, className: `infrastructure-exposure ${feature.kind}` },
          pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95, className: `infrastructure-exposure ${feature.kind}` }),
          interactive: true,
        });
        infrastructureLayer.bindTooltip(`${infrastructureKindLabel(feature.kind)} · ${feature.label.replace(/^.*? · /, "")} · OSM 标注，结构状态未知`, { sticky: true });
        infrastructureLayer.addTo(layer);
      });
      const marker = (coordinate: ResponseCoordinate, label: string, color: string) => L.circleMarker([coordinate[1], coordinate[0]], { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1, className: "response-endpoint" }).bindTooltip(label, { direction: "top" }).addTo(layer);
      marker(activeResponseScenario.origin, "撤离起点", "#075fa8");
      marker(activeResponseScenario.destination, "参考目的地", "#14825f");
      const bounds = layer.getBounds();
      if (bounds.isValid()) fitWithOverlay(map, bounds, 11);
    });
    return () => { cancelled = true; };
  }, [activeResponseScenario, fitWithOverlay, mapReady]);

  const finishCustomPolygon = useCallback(() => {
    if (!activeTask || activeDraftVertices.length < 3) {
      setDrawingError("至少点击 3 个不同顶点后才能完成多边形");
      return;
    }
    const ring = [...activeDraftVertices, [...activeDraftVertices[0]] as [number, number]];
    const existing = activeTask.aoiType === "multi" ? customAoiPolygonParts(activeTask.customGeometry) : [];
    const polygons = [...existing, [ring]];
    const geometry: CustomAoiGeometry = activeTask.aoiType !== "multi" && polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
    const normalized = normalizeCustomAoiGeoJson(geometry);
    if (!normalized) {
      setDrawingError("当前边界存在自相交、重叠、面积越界或日期变更线问题，请撤销顶点后重画");
      return;
    }
    onCustomAoiChange(activeTask.taskId, normalized);
    setDraftVertices([]);
    setDrawing(false);
    setDrawingError("");
  }, [activeDraftVertices, activeTask, onCustomAoiChange]);

  const addVertexByCoordinates = () => {
    const longitude = Number(vertexLongitude);
    const latitude = Number(vertexLatitude);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setDrawingError("请输入有效经纬度：经度 -180～180，纬度 -90～90");
      return;
    }
    setDraftVertices((current) => current.length >= 2000 ? current : [...current, [longitude, latitude]]);
    setVertexLongitude("");
    setVertexLatitude("");
    setDrawingError("");
  };

  const activeResponseRoute = activeResponseScenario?.routes.find((route) => route.routeId === activeResponseScenario.selectedRouteId) ?? activeResponseScenario?.routes[0];

  return <div className="map-stage" role="region" aria-label="灾害与任务地图" inert={obscured ? true : undefined} aria-hidden={obscured || undefined}>
    <div ref={containerRef} className="leaflet-map" aria-label={`${scopes[scope].label}灾害事件地图`} />
    <div className="map-shade" />
    <div className="map-title"><span>观测视图</span><strong>{scopes[scope].label}</strong><small>{events.length} 个事件 · 行政范围为快速筛选近似边界</small><button className="orbit-toggle" aria-pressed={orbitsVisible} disabled={!fleet.current} onClick={() => setOrbitsVisible((visible) => !visible)}><i />{orbitsVisible ? "隐藏卫星轨道" : "显示卫星轨道"}<b>{fleet.state === "loading" ? "…" : fleet.current}</b></button>{orbitsVisible ? <small className="orbit-disclaimer">TLE/SGP4 外推 · 非星上遥测</small> : null}</div>
    <div className="coordinates">WGS 84 · {viewLabel || "地图初始化中"}</div>
    {responsePointPickTarget ? <div className="response-point-pick-toolbar" role="status"><strong>点击地图设置{responsePointPickTarget === "origin" ? "起点" : "目的地"}</strong><span>所选位置会写回处置推演表单（WGS 84）</span><button onClick={onCancelResponsePointPick}>取消取点</button></div> : null}
    {clusterSelection.length ? <aside className="cluster-selection" aria-label="选择邻近灾害事件">
      <div><strong>此处有 {clusterSelection.length} 个事件</strong><button onClick={() => setClusterSelection([])} aria-label="关闭邻近事件列表">×</button></div>
      {clusterSelection.map((event) => <button key={event.masterEventId} className={event.severity} onClick={() => { setClusterSelection([]); onSelect(event); }}><span>{hazardMeta[event.hazard].symbol}</span><b>{event.title}</b><small>{severityLabels[event.severity]} · 优先级 {event.priority}</small></button>)}
    </aside> : null}
    {forecastFrames.length > 0 && activeForecastFrame ? <div className="cyclone-timeline" role="group" aria-label="台风四维影响场时间轴">
      <div><strong>{activeTask?.hazard === "cyclone" ? "任务 4D 预测路径" : "4D 影响场"}</strong><span>{browsingTaskForecast ? "浏览模式" : activeTask?.hazard === "cyclone" ? "拍摄时刻" : activeForecastFrame.centerBasis === "official_node" ? "官方节点" : "逐时插值"} · +{activeForecastFrame.leadHours}h</span></div>
      <div className="cyclone-timeline-meta"><time>{formatTimeWithYear(activeForecastFrame.forecastAt)} UTC+08</time>{activeTask?.hazard === "cyclone" && activeTask.closestApproachAt ? <button disabled={!browsingTaskForecast} onClick={() => setForecastSelection({ eventId: forecastOwnerId, index: acquisitionForecastFrameIndex })}>回到拍摄时刻</button> : null}</div>
      <input type="range" min="0" max={forecastFrames.length - 1} value={Math.min(forecastFrameIndex, forecastFrames.length - 1)} onChange={(event) => setForecastSelection({ eventId: forecastOwnerId, index: Number(event.target.value) })} aria-label="选择台风预报小时" />
      <small>{activeForecastFrame.windFields.length ? activeForecastFrame.windFields.map((field) => `≥${field.thresholdKnots} kt 象限风圈`).join(" · ") : "本时次无可用官方风圈"} · {activeForecastFrame.uncertaintyRadiusKm || activeForecastFrame.uncertaintyGeometry ? "含分时不确定区" : displayedCycloneForecast?.uncertaintyGeometry ? "显示本报次总体不确定区" : "无不确定区数据"}{activeTask?.hazard === "cyclone" ? " · 拖动仅浏览预测，不改变已选卫星机会" : ""}</small>
    </div> : null}
    {activeTask ? <div className="map-review-toolbar" role="group" aria-label="任务AOI地图复核">
      <div><strong>{activeTask.title}</strong><span>{activeTrackingSlice ? `拍摄时刻台风${activeTrackingTarget === "center" ? "预测中心" : activeTrackingTarget === "wind_field" ? "风圈" : "路径不确定区"} · +${activeTrackingSlice.leadHours}h · ${formatTimeWithYear(activeTask.closestApproachAt!)} UTC+08 · ${activeTrackingSlice.center[1].toFixed(3)}°, ${activeTrackingSlice.center[0].toFixed(3)}°` : ["polygon", "multi"].includes(activeTask.aoiType) ? `${customAoiPartCount(activeTask.customGeometry)} 块自定义 AOI` : "正在显示任务 AOI"}{activeTask.simulationLevel === "orbit_only" ? ` · TLE 轨道粗筛 · 最近约 ${activeTask.minimumGroundTrackDistanceKm ?? "--"} km` : activeTask.simulationLevel === "assumed_sensor" ? ` · 假设传感器试算 · ${activeTask.imagingMode ?? "模式待选"}` : ""}</span></div>
      {["polygon", "multi"].includes(activeTask.aoiType) ? <>
        <button onClick={() => { setDrawingTaskId(activeTask.taskId); setDrawing(true); setDraftVertices([]); setDrawingError(""); }}>{activeTask.aoiType === "multi" && activeTask.customGeometry ? "添加子区" : "开始绘制"}</button>
        <button onClick={() => setDraftVertices((current) => current.slice(0, -1))} disabled={!activeDrawing || !activeDraftVertices.length}>撤销顶点</button>
        <button onClick={finishCustomPolygon} disabled={!activeDrawing}>完成当前面</button>
        <button onClick={() => { onCustomAoiChange(activeTask.taskId, undefined); setDraftVertices([]); setDrawing(false); }} disabled={!activeTask.customGeometry && !activeDraftVertices.length}>清空</button>
      </> : null}
      <button onClick={onReturnToTask}>返回任务单</button>
      {activeTrackingSlice ? <small>蓝色目标为所选卫星机会对应的未来预测位置，不是台风当前实况中心；官方新报次到达后需重新计算。</small> : null}
      {activeDrawing ? <small>在地图依次点击边界顶点，完成后点击“完成当前面”。{activeDraftVertices.length} 个顶点。</small> : null}
      {activeDrawing ? <div className="aoi-keyboard-vertex"><label>经度<input type="number" min="-180" max="180" step="0.000001" value={vertexLongitude} onChange={(event) => setVertexLongitude(event.target.value)} /></label><label>纬度<input type="number" min="-90" max="90" step="0.000001" value={vertexLatitude} onChange={(event) => setVertexLatitude(event.target.value)} /></label><button onClick={addVertexByCoordinates} disabled={!vertexLongitude || !vertexLatitude}>添加坐标点</button><span aria-live="polite">已添加 {activeDraftVertices.length} 个顶点</span></div> : null}
      {drawingError ? <small className="drawing-error" role="alert">{drawingError}</small> : null}
    </div> : null}
    {!activeTask && activeResponseScenario && activeResponseRoute ? <div className="map-review-toolbar response-review-toolbar" role="group" aria-label="处置推演路线复核">
      <div><strong>{activeResponseScenario.title}</strong><span>{amapTravelModeLabels[activeResponseScenario.travelMode ?? "driving"]} · {activeResponseRoute.label} · {responseRouteStatusLabel(activeResponseRoute.status)} · {activeResponseRoute.distanceKm.toFixed(1)} km / 约 {activeResponseRoute.estimatedMinutes} 分钟{activeResponseRoute.disruptionConflicts?.length ? ` · 中断冲突 ${activeResponseRoute.disruptionConflicts.length}` : ""}{activeResponseRoute.infrastructureCrossings?.length ? ` · 设施穿越 ${activeResponseRoute.infrastructureCrossings.length}` : ""}</span></div>
      <button onClick={onReturnToResponse}>返回推演场景</button>
      <small>{activeResponseScenario.disclaimer}</small>
    </div> : null}
    {mapError ? <div className="map-error" role="alert">{mapError}<button onClick={() => window.location.reload()}>重试</button></div> : null}
  </div>;
}

function DetailPanel({ event, exposureAssessment, onExposureChange, currentUser, nowMs, compact, obscured, dispatchBlocked, historicalReadOnly, locationZh, locationLoading, locationState, onRetryLocation, taskAdded, landslideTemplateCount, terrainScreening, onTerrainChange, aoiConfirmed, onConfirmAoi, onAddTask, onAddLandslideTasks, onResponsePlan, onClose }: { event: DisasterEvent; exposureAssessment?: ExposureAssessment; onExposureChange: (assessment?: ExposureAssessment) => void; currentUser?: { username: string; role: "viewer" | "operator" | "admin" }; nowMs: number; compact: boolean; obscured: boolean; dispatchBlocked: boolean; historicalReadOnly: boolean; locationZh?: string; locationLoading: boolean; locationState?: "resolved" | "fallback" | "error"; onRetryLocation: () => void; taskAdded: boolean; landslideTemplateCount: number; terrainScreening?: LandslideTerrainScreening; onTerrainChange: (terrain?: LandslideTerrainScreening) => void; aoiConfirmed: boolean; onConfirmAoi: (confirmed: boolean) => void; onAddTask: (event: DisasterEvent, operatorConfirmed: boolean) => void; onAddLandslideTasks: (event: DisasterEvent, terrain: LandslideTerrainScreening) => void; onResponsePlan: (event: DisasterEvent) => void; onClose: () => void }) {
  const isDemo = event.source === "演示数据";
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!compact) return;
    closeRef.current?.focus();
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") onClose();
      if (keyboardEvent.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyboardEvent.shiftKey && document.activeElement === first) { keyboardEvent.preventDefault(); last.focus(); }
      else if (!keyboardEvent.shiftKey && document.activeElement === last) { keyboardEvent.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [compact, event.id, onClose]);
  const taskWindowValid = Date.parse(event.observationExpiresAt) > nowMs + 3_600_000;
  const cycloneForecastUsable = !event.cycloneForecast || Date.parse(event.cycloneForecast.forecastValidUntil) > nowMs + 3_600_000;
  const needsAoiReview = event.aoiApprovalRequired || !cycloneForecastUsable;
  const canSaveCandidate = !historicalReadOnly && !isDemo && taskWindowValid && event.lifecycleStatus !== "resolved" && event.lifecycleStatus !== "archived";
  const canEnterDispatchReview = !dispatchBlocked && canSaveCandidate && (!needsAoiReview || aoiConfirmed);
  const canBuildTerrainTask = !historicalReadOnly && !isDemo && taskWindowValid && event.dispatchEligibility !== "blocked" && event.lifecycleStatus !== "resolved" && event.lifecycleStatus !== "archived";
  const effectiveImpactRisk = assessImpactRisk({
    ...event,
    exposure: exposureAssessment?.riskInput ?? undefined,
  });
  return <aside ref={panelRef} className="detail-panel" role={compact ? "dialog" : "region"} aria-modal={compact ? "true" : undefined} aria-labelledby={`detail-title-${event.id}`} inert={obscured ? true : undefined} aria-hidden={obscured || undefined}>
    <button ref={closeRef} className="detail-close" onClick={onClose} aria-label="关闭详情">×</button>
    <div className={`detail-kicker ${event.severity}`}><span>{hazardMeta[event.hazard].symbol}</span>{event.hazardSubtype ? hazardSubtypeLabels[event.hazardSubtype] : hazardMeta[event.hazard].label} · {severityLabels[event.severity]} · {phenomenonLabels[event.phenomenonStage]}{event.crossBorder ? " · 跨境影响" : ""}</div>
    <h2 id={`detail-title-${event.id}`}>{event.title}</h2>
    <div className="detail-location">
      <span>⌖ 中文地点</span>
      <strong className={locationLoading ? "location-loading" : ""}>{locationLoading ? "正在解析中文地点…" : locationZh || "暂无中文地点"}</strong>
      {locationState === "fallback" ? <small>在线地名解析暂不可用，当前为来源文本/坐标回退结果。<button onClick={onRetryLocation}>重试解析</button></small> : null}
      {locationState === "error" ? <small role="alert">中文地点解析失败。<button onClick={onRetryLocation}>重试</button></small> : null}
      <small>来源原文：{event.country || event.title}</small>
    </div>
    <div className="classification-grid" aria-label="事件分级与任务排序">
      <div className={`official-severity ${event.severity}`}><span>来源/官方告警等级</span><strong>{severityLabels[event.severity]}</strong><small>来源原始表述：{event.sourceSeverity}</small></div>
      <div className={`impact-risk ${effectiveImpactRisk?.level ?? "undetermined"}`}><span>影响风险</span><strong>{effectiveImpactRisk?.status === "assessed" ? `${impactRiskLabel(effectiveImpactRisk.level)} · ${effectiveImpactRisk.score}${effectiveImpactRisk.scoreRange ? `（${effectiveImpactRisk.scoreRange.min}–${effectiveImpactRisk.scoreRange.max}）` : ""}` : "待评估"}</strong><small>{effectiveImpactRisk?.status === "assessed" ? `${effectiveImpactRisk.hazardModel.quantitative ? "分灾种强度" : "官方等级代理"}、暴露度和脆弱性初筛` : `危险性 ${effectiveImpactRisk?.hazardIndex ?? "—"}/100；待补 ${effectiveImpactRisk?.missingInputs.join("、") || "必要输入"}`}</small></div>
      <div className="satellite-priority"><span>卫星观测优先级</span><strong>{event.priority}</strong><small>用于候选任务排序，不等于灾害影响风险</small></div>
    </div>
    <details className="priority-method"><summary>查看卫星优先级构成</summary><p>官方等级 {event.priorityBreakdown.severity} · 重点区域 {event.priorityBreakdown.scope} · 遥感可观测性 {event.priorityBreakdown.observability} · 时效 {event.priorityBreakdown.time} · 数据可信度 {event.priorityBreakdown.confidence ?? 0}</p></details>
    {effectiveImpactRisk ? <section className="impact-risk-method"><h3>影响风险说明</h3><p>{effectiveImpactRisk.limitations}</p><small>模型：{effectiveImpactRisk.hazardModel.modelId} · 强度依据：{effectiveImpactRisk.hazardModel.intensityProxy} · 危险性区间 {effectiveImpactRisk.uncertainty.hazardIndexMin}–{effectiveImpactRisk.uncertainty.hazardIndexMax}</small>{effectiveImpactRisk.missingInputs.length ? <small>待补数据：{effectiveImpactRisk.missingInputs.join("、")}</small> : null}</section> : null}
    <ExposureAssessmentCard event={event} assessment={exposureAssessment} currentUser={currentUser} historicalReadOnly={historicalReadOnly} onChange={onExposureChange} />
    <div className={`event-integrity ${event.dispatchEligibility}`}>
      <div><strong>{confidenceLabels[event.confidenceLevel]} {event.confidenceScore}</strong><span>{event.independentSourceCount ?? new Set(event.evidence.map((item) => item.source.split(" · ")[0])).size} 个独立来源 · {event.bulletinCount ?? event.updateCount} 期公告</span></div>
      {event.peakSeverity && event.peakSeverity !== event.severity ? <p><b>当前{severityLabels[event.severity]}</b> · 历史峰值{severityLabels[event.peakSeverity]}</p> : null}
      <p><b>{locationQualityLabels[event.locationQuality]}</b> · 估计误差约 {event.locationAccuracyKm} km</p>
      {event.crossBorder ? <p><b>跨境影响事件</b> · 起源地 {event.originCountry || "待核验"} · 受影响 {event.affectedCountries?.join("、") || "待核验"}</p> : null}
      <small>主事件ID：{event.masterEventId}</small>
      {event.sourcePresence === "retained" ? <em>当前短时数据源未再次报告该事件；未据此判定灾害已结束，仍保留至观测期届满或权威撤销。</em> : null}
    </div>
    <div className="observation-deadline"><span>{observationDeadlineLabel(event)}</span><strong>{remainingObservationTime(observationDeadline(event))}</strong><small>{event.observationRationale} 复核点 {formatTimeWithYear(event.observationReviewAt)}；有效期/归档点 {formatTimeWithYear(event.observationExpiresAt)} UTC+08。</small></div>
    <WeatherForecastCard latitude={event.latitude} longitude={event.longitude} maximumCloudPercent={30} />
    {event.hazard === "landslide" ? <LandslidePlanningCard key={event.masterEventId} event={event} terrain={terrainScreening} templateCount={landslideTemplateCount} taskAllowed={canBuildTerrainTask} onTerrainChange={onTerrainChange} onAddTasks={(screening) => onAddLandslideTasks(event, screening)} /> : null}
    {event.cycloneForecast ? <section className="cyclone-forecast-card">
      <h3>官方台风预报 · {event.cycloneForecast.source}</h3>
      <div className="forecast-validity"><span>发布 {formatTimeWithYear(event.cycloneForecast.issuedAt)} UTC+08</span><span>有效至 {formatTimeWithYear(event.cycloneForecast.forecastValidUntil)} UTC+08</span></div>
      <div className="forecast-layer-notes">
        <span><i className="track" />中心预报路径</span>
        <span><i className="impact" />{event.cycloneForecast.impactBasis === "forecast_wind_radii" ? event.cycloneForecast.impactThreshold || "预报风圈" : event.cycloneForecast.impactBasis === "current_wind_extent" ? event.cycloneForecast.impactThreshold || "当前强风范围" : "本报次无官方风圈"}</span>
        {event.cycloneForecast.uncertaintyGeometry ? <span><i className="uncertainty" />{event.cycloneForecast.uncertaintyLabel || "路径不确定区"}</span> : null}
        {event.cycloneForecast.impactField ? <span><i className="impact" />{event.cycloneForecast.impactField.frames.length} 个逐时时间片</span> : null}
      </div>
      <div className="forecast-points" aria-label="台风中心预报节点">
        {event.cycloneForecast.track.map((point) => <div key={`${point.leadHours}-${point.forecastAt}`}><b>{point.leadHours === 0 ? "实况" : `+${point.leadHours}h`}</b><time>{formatTime(point.forecastAt)}</time><small>{point.latitude.toFixed(2)}°, {point.longitude.toFixed(2)}°{point.windSpeedKnots !== undefined ? ` · ${point.windSpeedKnots} kt` : ""}</small></div>)}
      </div>
      <p className="forecast-disclaimer">{event.cycloneForecast.note}</p>
      {event.cycloneForecast.impactField ? <p className="forecast-disclaimer">{event.cycloneForecast.impactField.note}</p> : null}
      <a href={safeHttpUrl(event.cycloneForecast.sourceUrl)} target="_blank" rel="noreferrer">查看本报次官方预报 ↗</a>
    </section> : null}
    <section><h3>观测目标</h3><div className="target-list">{event.observationTargets.map((target) => <span key={target}>{target}</span>)}</div></section>
    <section><h3>可选载荷</h3><div className="target-list">{payloadOptions.map((payload) => <span key={payload}>{payload}</span>)}</div></section>
    <section><h3>事件摘要</h3><p>{event.description || "暂无详细描述。"}</p></section>
    <section className="evidence-chain"><h3>证据链</h3>{event.evidence.map((item, index) => <a key={`${item.source}-${item.sourceEventId}-${item.role}-${index}`} href={safeHttpUrl(item.sourceUrl)} target="_blank" rel="noreferrer"><span>{item.source}</span><small>{evidenceRoleLabel(item.role)} · {formatTime(item.observedAt)}</small></a>)}</section>
    {event.updateCount > 1 ? <section className="update-history"><h3>过程更新 · 共 {event.updateCount} 期</h3>{event.updateHistory.slice(0, 8).map((item, index) => <a key={`${item.source}-${item.sourceEventId}`} href={safeHttpUrl(item.sourceUrl)} target="_blank" rel="noreferrer"><i>{index === 0 ? "最新" : String(event.updateCount - index).padStart(2, "0")}</i><span><strong>{item.title}</strong><small>{item.source} · {formatTimeWithYear(item.observedAt)}</small></span></a>)}</section> : null}
    <dl>
      <div><dt>{event.phenomenonStage === "observed" ? "发生时间" : "发布时间"}</dt><dd>{formatTimeWithYear(event.phenomenonStage === "observed" ? event.occurredAt : event.issuedAt)} UTC+08</dd></div>
      {event.validFrom ? <div><dt>生效时间</dt><dd>{formatTimeWithYear(event.validFrom)} UTC+08</dd></div> : null}
      {event.validTo ? <div><dt>权威有效至</dt><dd>{formatTimeWithYear(event.validTo)} UTC+08</dd></div> : null}
      <div><dt>最新更新</dt><dd>{formatTimeWithYear(event.updatedAt)} UTC+08</dd></div>
      {event.hazardSubtype ? <div><dt>灾害子类型</dt><dd>{hazardSubtypeLabels[event.hazardSubtype]}</dd></div> : null}
      {event.originCountry ? <div><dt>起源国家/地区</dt><dd>{event.originCountry}</dd></div> : null}
      {event.affectedCountries?.length ? <div><dt>受影响国家/地区</dt><dd>{event.affectedCountries.join("、")}</dd></div> : null}
      <div><dt>来源等级</dt><dd>{event.sourceSeverity}</dd></div>
      <div><dt>坐标</dt><dd>{event.latitude.toFixed(3)}°, {event.longitude.toFixed(3)}°</dd></div>
      <div><dt>数据来源</dt><dd>{event.source}</dd></div>
    </dl>
    <a className="source-link" href={safeHttpUrl(event.sourceUrl)} target="_blank" rel="noreferrer">查看权威来源 ↗</a>
    <button className="response-plan-button" disabled={historicalReadOnly} onClick={() => onResponsePlan(event)}>{historicalReadOnly ? "历史重演不可建立推演" : "建立处置推演场景"}</button>
    {needsAoiReview ? <div className="aoi-approval"><input id={`aoi-confirm-${event.id}`} type="checkbox" checked={aoiConfirmed} disabled={historicalReadOnly} onChange={(change) => onConfirmAoi(change.target.checked)} /><label htmlFor={`aoi-confirm-${event.id}`}><strong>人工核对 AOI</strong><small>{historicalReadOnly ? "历史重演为只读；返回实时后再确认任务 AOI。" : !cycloneForecastUsable ? "官方台风报次已不足一小时，不再作为预测 AOI；如需灾后复核，请在地图重新圈定实况 AOI。" : "地图已用绿色虚线显示完整来源几何；确认前请核对目标类型、范围和代表点误差。"}</small></label></div> : null}
    <button className="task-button" onClick={() => onAddTask(event, aoiConfirmed)} disabled={taskAdded || !canSaveCandidate}>{historicalReadOnly ? "历史重演不可建立任务" : taskAdded ? "已加入卫星任务候选" : isDemo ? "演示事件不能建立任务" : !taskWindowValid ? "观测期不足一小时，不能建立任务" : canEnterDispatchReview ? "加入卫星任务候选" : "保存为候选草稿"}</button>
    {!canEnterDispatchReview && canSaveCandidate ? <small className="task-candidate-note">当前可先保存候选草稿；完成 AOI 复核且数据恢复实时后，才能计算、导出或进入下发复核。</small> : null}
  </aside>;
}

function ExposureAssessmentCard({ event, assessment, currentUser, historicalReadOnly, onChange }: {
  event: DisasterEvent;
  assessment?: ExposureAssessment;
  currentUser?: { username: string; role: "viewer" | "operator" | "admin" };
  historicalReadOnly: boolean;
  onChange: (assessment?: ExposureAssessment) => void;
}) {
  const [loading, setLoading] = useState(!historicalReadOnly);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (historicalReadOnly) return;
    const controller = new AbortController();
    void fetch(`/api/exposure?masterEventId=${encodeURIComponent(event.masterEventId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as { assessment?: ExposureAssessment | null; stale?: boolean; error?: string };
        if (!response.ok) throw new Error(result.error || `暴露度记录读取失败（HTTP ${response.status}）`);
        const versionMismatch = Boolean(result.assessment && result.assessment.eventRevision !== eventRevisionFingerprint(event));
        setStale(Boolean(result.stale) || versionMismatch);
        onChangeRef.current(versionMismatch ? undefined : result.assessment ?? undefined);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "暴露度记录读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [event, historicalReadOnly]);

  const compute = async () => {
    if (historicalReadOnly || computing) return;
    setComputing(true);
    setError("");
    try {
      const response = await fetch("/api/exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterEventId: event.masterEventId, force: Boolean(assessment && assessment.status !== "pending") }),
      });
      const result = await response.json().catch(() => ({})) as { assessment?: ExposureAssessment; error?: string };
      if (!response.ok || !result.assessment) throw new Error(result.error || `暴露度计算失败（HTTP ${response.status}）`);
      if (result.assessment.eventRevision !== eventRevisionFingerprint(event)) {
        setStale(true);
        onChangeRef.current(undefined);
        throw new Error("事件在计算期间已更新，请刷新事件后重新计算");
      }
      setStale(false);
      onChangeRef.current(result.assessment);
    } catch (computeError) {
      setError(computeError instanceof Error ? computeError.message : "暴露度计算失败");
    } finally {
      setComputing(false);
    }
  };

  const canCompute = !historicalReadOnly && (currentUser?.role === "operator" || currentUser?.role === "admin");
  const population = assessment?.population;
  const osm = assessment?.osm;
  return <section className="exposure-card" aria-labelledby={`exposure-title-${event.id}`}>
    <div className="exposure-heading">
      <div><h3 id={`exposure-title-${event.id}`}>人口与承灾体暴露</h3><small>WorldPop 人口模型 · OpenStreetMap 已映射要素（非实时设施状态）</small></div>
      <span className={`exposure-status ${assessment?.status ?? "unavailable"}`}>{loading ? "读取中" : exposureStatusLabel(assessment?.status)}</span>
    </div>
    {historicalReadOnly ? <p className="exposure-notice">历史重演不读取当前暴露度数据；只有随快照保存的结果才能用于历史复盘。</p> : null}
    {stale ? <p className="exposure-warning">事件范围或版本已更新，旧暴露度结果已隐藏，请重新计算。</p> : null}
    {assessment ? <>
      <div className="exposure-metrics">
        <div><span>模型人口</span><strong>{population?.state === "ready" && population.totalPopulation !== undefined ? Math.round(population.totalPopulation).toLocaleString() : "—"}</strong><small>{population?.state === "ready" ? `${population.year} 年 · ${population.resolution} · ${Math.round(population.populationDensityPerKm2 ?? 0).toLocaleString()} 人/km²` : population?.message}</small></div>
        <div><span>已映射建筑</span><strong>{osm?.state === "ready" ? osm.mappedBuildingCount?.toLocaleString() : "—"}</strong><small>OSM building 轮廓数，不是受损建筑数</small></div>
        <div><span>已映射道路</span><strong>{osm?.state === "ready" ? osm.mappedRoadWayCount?.toLocaleString() : "—"}</strong><small>OSM highway way 数，不代表里程或通行状态</small></div>
        <div><span>关键设施</span><strong>{osm?.state === "ready" ? osm.mappedKeyFacilityCount?.toLocaleString() : "—"}</strong><small>{osm?.facilitiesTruncated ? `地图仅显示前 ${osm.facilities.length} 个` : "地图显示可定位设施"}</small></div>
      </div>
      {osm?.state === "ready" && Object.keys(osm.facilityCounts).length ? <div className="exposure-facility-summary">{(Object.entries(osm.facilityCounts) as Array<[ExposureFacilityKind, number]>).map(([kind, count]) => <span key={kind}><i style={{ background: exposureFacilityColor(kind) }} />{exposureFacilityKindLabel(kind)} {count}</span>)}</div> : null}
      <dl className="exposure-provenance">
        <div><dt>筛查范围</dt><dd>{assessment.aoi.label} · {Math.round(assessment.aoi.areaKm2).toLocaleString()} km²</dd></div>
        <div><dt>自动指数</dt><dd>{assessment.riskInput ? `${assessment.riskInput.index}/100（仅用于演示初筛）` : "未生成"}</dd></div>
        <div><dt>计算时间</dt><dd>{formatTimeWithYear(assessment.computedAt)} UTC+08</dd></div>
        {osm?.osmBaseTimestamp ? <div><dt>OSM 数据时点</dt><dd>{formatTimeWithYear(osm.osmBaseTimestamp)} UTC+08</dd></div> : null}
        {osm?.dataProfile ? <div><dt>OSM 更新方式</dt><dd>{osm.dataProfile === "china_daily" ? "中国日更镜像（非实时）" : "公共 Overpass 上游"}</dd></div> : null}
        {osm?.state === "ready" && osm.fetchedAt ? <div><dt>OSM 查询缓存</dt><dd>{overpassCacheStatusLabel(osm.cacheStatus)} · 查询于 {formatTimeWithYear(osm.fetchedAt)} UTC+08</dd></div> : null}
      </dl>
      {assessment.riskInput ? <p className="exposure-risk-basis"><strong>自动指数依据：</strong>{assessment.riskInput.basis}</p> : null}
      {population ? <p className={`exposure-source-state ${population.state}`}>WorldPop：{population.message}</p> : null}
      {osm ? <p className={`exposure-source-state ${osm.state}`}>OSM：{osm.message}</p> : null}
      {osm?.state === "skipped" ? <p className="exposure-source-guidance">当前范围超过已配置 OSM 服务的单次安全阈值。可缩小 AOI；中国日更镜像接通后能扩大筛查范围，但仍不应把全国建筑和道路作为一次查询。高德 POI 只能补充设施位置，不能替代建筑和道路存量统计。</p> : null}
      <details className="exposure-limitations"><summary>查看口径与限制</summary>{assessment.limitations.map((item) => <p key={item}>{item}</p>)}<p>自动暴露度只参与初筛排序；没有脆弱性模型时，系统仍不会生成综合影响风险分数。</p></details>
      <div className="exposure-links"><a href="https://api.worldpop.org/v2/" target="_blank" rel="noreferrer">WorldPop API ↗</a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors ↗</a></div>
    </> : !loading && !historicalReadOnly ? <p className="exposure-empty">尚未计算。系统会按事件范围查询人口模型，并筛查已映射的建筑、道路和关键设施。</p> : null}
    {canCompute ? <button className="exposure-compute" disabled={computing} onClick={() => void compute()}>{computing ? "正在查询外部数据…" : assessment?.status === "pending" ? "继续查询人口任务" : assessment ? "重新计算暴露度" : "计算暴露度并叠加地图"}</button> : !historicalReadOnly ? <small className="exposure-readonly">当前账号可查看已有结果；计算需要操作员权限。</small> : null}
    {error ? <p className="exposure-error" role="alert">{error}</p> : null}
  </section>;
}

function exposureStatusLabel(status: ExposureAssessment["status"] | undefined) {
  return status === "complete" ? "完整" : status === "partial" ? "部分可用" : status === "pending" ? "计算中" : status === "unavailable" ? "不可用" : "未计算";
}

function overpassCacheStatusLabel(status: "refreshed" | "fresh" | "stale" | undefined) {
  return status === "fresh" ? "本地缓存命中" : status === "stale" ? "过期缓存降级" : "已向数据服务刷新";
}

function exposureFacilityColor(kind: ExposureFacilityKind) {
  return { health: "#d5414a", emergency: "#ee7d22", shelter: "#16866c", education: "#6f57b5", power: "#d2a100", water: "#087fa1" }[kind];
}

function impactRiskLabel(level: NonNullable<DisasterEvent["impactRisk"]>["level"]) {
  return level === "very_high" ? "极高" : level === "high" ? "高" : level === "moderate" ? "中" : level === "low" ? "低" : "待评估";
}

function LandslidePlanningCard({ event, terrain, templateCount, taskAllowed, onTerrainChange, onAddTasks }: { event: DisasterEvent; terrain?: LandslideTerrainScreening; templateCount: number; taskAllowed: boolean; onTerrainChange: (terrain?: LandslideTerrainScreening) => void; onAddTasks: (terrain: LandslideTerrainScreening) => void }) {
  const workflow = deriveLandslideWorkflow(event);
  const [radiusKm, setRadiusKm] = useState(() => Math.min(20, Math.max(3, Number.isFinite(event.locationAccuracyKm) ? Math.ceil(event.locationAccuracyKm) : 10)));
  const [load, setLoad] = useState<{ state: "idle" | "loading" | "error" | "flat"; message?: string }>({ state: "idle" });
  const [terrainReviewed, setTerrainReviewed] = useState(false);

  const requestTerrain = async () => {
    setLoad({ state: "loading" });
    setTerrainReviewed(false);
    try {
      const response = await fetch("/api/landslide-terrain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: event.latitude, longitude: event.longitude, radiusKm }),
      });
      const result = await response.json() as LandslideTerrainResult;
      if (!response.ok || result.state === "unavailable" || result.state === "unsupported") throw new Error("message" in result ? result.message : `地形请求失败（HTTP ${response.status}）`);
      if (result.state === "flat") {
        onTerrainChange(undefined);
        setLoad({ state: "flat", message: result.message });
        return;
      }
      if (result.state !== "ready") throw new Error("地形服务返回了无法识别的状态");
      onTerrainChange(result);
      setLoad({ state: "idle" });
    } catch (error) {
      onTerrainChange(undefined);
      setLoad({ state: "error", message: error instanceof Error ? error.message : "地形筛查失败" });
    }
  };

  if (!workflow) return null;
  return <section className="landslide-planning-card">
    <div className="landslide-stage"><span>{event.hazardSubtype ? hazardSubtypeLabels[event.hazardSubtype] : "滑坡"}证据状态</span><strong>{workflow.label}</strong></div>
    <p>{workflow.evidenceMeaning}</p>
    <small>{workflow.dispatchRule}</small>
    <div className="terrain-request">
      <label>DEM 筛查半径（公里）<input type="number" min="1" max="20" value={radiusKm} onChange={(change) => setRadiusKm(clampNumber(change.target.value, 1, 20))} /></label>
      <button onClick={() => void requestTerrain()} disabled={load.state === "loading"}>{load.state === "loading" ? "正在采样…" : terrain ? "重新生成地形 AOI" : "生成地形约束 AOI"}</button>
    </div>
    {load.message ? <p className={load.state === "error" ? "terrain-error" : "terrain-flat"} role={load.state === "error" ? "alert" : "status"}>{load.message}</p> : null}
    {terrain ? <div className="terrain-result">
      <div><strong>{terrain.selectedCellCount}</strong><span>候选格网</span></div><div><strong>{terrain.maximumSlopeDeg}°</strong><span>最大近似坡度</span></div><div><strong>≥{terrain.screeningThresholdDeg}°</strong><span>本轮筛查阈值</span></div>
      <p>{terrain.note}</p>
      <a href={safeHttpUrl(terrain.sourceUrl)} target="_blank" rel="noreferrer">{terrain.attribution} ↗</a>
      <label className="terrain-confirm" htmlFor="landslide-terrain-confirm" aria-label="人工核对地形 AOI"><input id="landslide-terrain-confirm" type="checkbox" checked={terrainReviewed} onChange={(change) => setTerrainReviewed(change.target.checked)} /><span><b>人工核对地形 AOI</b><small>我已在地图核对代表点、范围和格网；知道该结果不是滑坡或泥石流实况边界。</small></span></label>
      <button className="landslide-template-button" disabled={!taskAllowed || !terrainReviewed || templateCount >= 2} onClick={() => onAddTasks(terrain)}>{templateCount >= 2 ? "升降轨 SAR 模板已建立" : !taskAllowed ? "当前数据状态禁止建立任务" : !terrainReviewed ? "核对后建立双向 SAR 任务" : "建立升轨 + 降轨 SAR 任务"}</button>
      <small className="sar-template-note">两个候选均要求灾前参考影像、3 次重访和幅度变化 + InSAR 对比；最终轨向、入射角、阴影/叠掩仍由仿真窗口验证。</small>
    </div> : null}
  </section>;
}

function WeatherForecastCard({ latitude, longitude, maximumCloudPercent, compact = false, enabled = true, onRequest }: { latitude: number; longitude: number; maximumCloudPercent: number; compact?: boolean; enabled?: boolean; onRequest?: () => void }) {
  const [load, setLoad] = useState<WeatherLoadState>({ state: enabled ? "loading" : "idle" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const start = window.setTimeout(() => {
      setLoad({ state: "loading" });
      const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), hours: "72" });
      fetch(`/api/weather?${params}`, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => ({ response, result: await response.json() as WeatherForecastResponse }))
        .then(({ response, result }) => {
          if (result.state === "ready") setLoad({ state: "ready", forecast: result });
          else setLoad({ state: result.state === "needs_config" ? "needs_config" : "error", message: result.message || `天气请求失败（HTTP ${response.status}）` });
        })
        .catch((error) => { if (!controller.signal.aborted) setLoad({ state: "error", message: error instanceof Error ? error.message : "天气请求失败" }); });
    }, 0);
    return () => { window.clearTimeout(start); controller.abort(); };
  }, [enabled, latitude, longitude, retry]);

  if (!enabled) return <section className={`weather-card ${compact ? "compact" : ""}`}><div className="weather-heading"><h3>逐小时天气 · 全球预报</h3><span>按需查询</span></div><p>默认使用免密钥全球预报；已配置和风天气时优先使用其中文城市/区域逐小时预报并自动降级。</p><button className="weather-load" onClick={onRequest}>加载该 AOI 天气</button></section>;
  const forecast = load.forecast;
  const windows = forecast ? weatherImagingWindows(forecast.hourly, maximumCloudPercent) : [];
  const sample = forecast?.hourly.filter((_, index) => index % 3 === 0).slice(0, compact ? 4 : 8) ?? [];
  return <section className={`weather-card ${compact ? "compact" : ""}`} aria-live="polite">
    <div className="weather-heading"><h3>逐小时天气 · 全球预报</h3><span>{load.state === "ready" && forecast ? `${forecast.provider} · ${forecast.resolution}` : load.state === "loading" ? "连接中" : load.state === "needs_config" ? "待配置" : "不可用"}</span></div>
    {load.state === "loading" ? <div className="weather-loading">正在获取未来72小时预报…</div> : null}
    {load.state === "needs_config" ? <div className="weather-message"><strong>尚未配置免费天气接口</strong><p>{load.message}</p><a href="https://console.qweather.com/" target="_blank" rel="noreferrer">前往和风天气控制台 ↗</a></div> : null}
    {load.state === "error" ? <div className="weather-message error" role="alert"><strong>天气预报暂不可用</strong><p>{load.message}</p><button onClick={() => setRetry((value) => value + 1)}>重试</button></div> : null}
    {forecast ? <>
      <div className="weather-validity"><span>模式更新 {formatTimeWithYear(forecast.issuedAt)} UTC+08</span><span>查询 {forecast.latitude.toFixed(2)}°, {forecast.longitude.toFixed(2)}°</span></div>
      <div className="weather-hours">{sample.map((hour) => <div key={hour.validAt} className={hour.opticalSuitability}>
        <time>{formatTime(hour.validAt)}</time><strong>{hour.condition} · {hour.temperatureC}℃</strong><span>云 {hour.cloudPercent == null ? "--" : `${hour.cloudPercent}%`} · 雨 {hour.precipitationMm} mm</span><small>{hour.windDirection} {hour.windSpeedKmh} km/h</small>
      </div>)}</div>
      <div className="weather-windows"><strong>光学气象窗口 · 云量≤{maximumCloudPercent}%</strong>{windows.length ? windows.map((window) => <div key={window.start}><time>{formatTimeWithYear(window.start)} — {formatTimeWithYear(window.end)}</time><small>云量 {window.minimumCloudPercent}–{window.maximumCloudPercent}% · 最大降水 {window.maximumPrecipitationMm} mm</small></div>) : <p>未来72小时暂无连续2小时满足条件的窗口；SAR不受云层遮挡，可继续结合降水与风场人工评估。</p>}</div>
      <p className="weather-note">{forecast.note}</p>
      <a className="weather-source" href={safeHttpUrl(forecast.sourceUrl)} target="_blank" rel="noreferrer">数据：{forecast.provider} · 查看来源 ↗</a>
    </> : null}
  </section>;
}

function ResponsePlanPanel({ open, event, events, scenarios, activeScenarioId, currentUserRole, pickedPoint, onRequestPointPick, onSave, onActivate, onSelectRoute, onRemove, onChooseEvent, onClose }: {
  open: boolean;
  event: DisasterEvent | null;
  events: DisasterEvent[];
  scenarios: ResponseScenario[];
  activeScenarioId: string | null;
  currentUserRole: "viewer" | "operator" | "admin";
  pickedPoint: ResponsePickedPoint | null;
  onRequestPointPick: (target: ResponsePointPickTarget) => void;
  onSave: (scenario: ResponseScenario) => void;
  onActivate: (scenarioId: string) => void;
  onSelectRoute: (scenarioId: string, routeId: string) => void;
  onRemove: (scenarioId: string) => void;
  onChooseEvent: (event: DisasterEvent) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [originLongitude, setOriginLongitude] = useState("");
  const [originLatitude, setOriginLatitude] = useState("");
  const [destinationLongitude, setDestinationLongitude] = useState("");
  const [destinationLatitude, setDestinationLatitude] = useState("");
  const [departureAt, setDepartureAt] = useState(() => toLocalInput(new Date(Math.ceil(Date.now() / 60_000) * 60_000).toISOString()));
  const [fallbackSpeed, setFallbackSpeed] = useState("35");
  const [travelMode, setTravelMode] = useState<AmapTravelMode>("driving");
  const [roadDisruptions, setRoadDisruptions] = useState<RoadDisruption[]>([]);
  const [registryDisruptions, setRegistryDisruptions] = useState<RoadDisruptionRegistryEntry[]>([]);
  const [registryState, setRegistryState] = useState<"loading" | "operational-database" | "public-read-only" | "unavailable">("loading");
  const [registryBusyId, setRegistryBusyId] = useState<string | null>(null);
  const [disruptionError, setDisruptionError] = useState("");
  const [planError, setPlanError] = useState("");
  const [roadRoutingState, setRoadRoutingState] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [infrastructureQueryState, setInfrastructureQueryState] = useState<"idle" | InfrastructureAssessment["state"]>("idle");
  const [eventQuery, setEventQuery] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const matchingEvents = useMemo(() => {
    const needle = eventQuery.trim().toLowerCase();
    return events.filter((candidate) => !needle || `${candidate.title} ${candidate.country ?? ""} ${hazardMeta[candidate.hazard].label}`.toLowerCase().includes(needle)).slice(0, 80);
  }, [eventQuery, events]);
  const effectiveRoadDisruptions = useMemo(() => {
    const combined = new Map<string, RoadDisruption>();
    for (const disruption of [...registryDisruptions, ...roadDisruptions]) combined.set(disruption.disruptionId, disruption);
    return [...combined.values()];
  }, [registryDisruptions, roadDisruptions]);

  const refreshRoadRegistry = useCallback(async () => {
    setRegistryState("loading");
    try {
      const response = await fetch("/api/road-disruptions", { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as { disruptions?: unknown; storage?: string; error?: string };
      if (!response.ok) throw new Error(result.error || `道路中断台账读取失败（HTTP ${response.status}）`);
      const disruptions = Array.isArray(result.disruptions) && isRoadDisruptionList(result.disruptions, 500) ? result.disruptions as RoadDisruptionRegistryEntry[] : [];
      setRegistryDisruptions(disruptions.filter((item) => item.lifecycleStatus === "active"));
      setRegistryState(result.storage === "public-read-only" ? "public-read-only" : "operational-database");
    } catch (error) {
      setRegistryDisruptions([]);
      setRegistryState("unavailable");
      setDisruptionError(error instanceof Error ? error.message : "道路中断台账读取失败");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") onClose();
      if (keyboardEvent.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyboardEvent.shiftKey && document.activeElement === first) { keyboardEvent.preventDefault(); last.focus(); }
      else if (!keyboardEvent.shiftKey && document.activeElement === last) { keyboardEvent.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const start = window.setTimeout(() => { void refreshRoadRegistry(); }, 0);
    return () => window.clearTimeout(start);
  }, [refreshRoadRegistry]);

  useEffect(() => {
    if (!event) return;
    const reset = window.setTimeout(() => {
      const nextDeparture = new Date(Math.ceil(Date.now() / 60_000) * 60_000).toISOString();
      const endpoints = defaultResponseEndpoints(event, nextDeparture);
      setOriginLongitude(endpoints.origin[0].toFixed(6));
      setOriginLatitude(endpoints.origin[1].toFixed(6));
      setDestinationLongitude(endpoints.destination[0].toFixed(6));
      setDestinationLatitude(endpoints.destination[1].toFixed(6));
      setDepartureAt(toLocalInput(nextDeparture));
      setPlanError("");
      setRoadRoutingState("idle");
      setInfrastructureQueryState("idle");
      setRoadDisruptions([]);
      setDisruptionError("");
    }, 0);
    return () => window.clearTimeout(reset);
  }, [event]);

  useEffect(() => {
    if (!pickedPoint) return;
    const timer = window.setTimeout(() => {
      const longitude = pickedPoint.longitude.toFixed(6);
      const latitude = pickedPoint.latitude.toFixed(6);
      if (pickedPoint.target === "origin") {
        setOriginLongitude(longitude);
        setOriginLatitude(latitude);
      } else {
        setDestinationLongitude(longitude);
        setDestinationLatitude(latitude);
      }
      setPlanError("");
      setRoadRoutingState("idle");
      setActionNotice(`已从地图设置${pickedPoint.target === "origin" ? "起点" : "目的地"}：${latitude}, ${longitude}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pickedPoint]);

  const routeInputs = () => ({
    origin: [Number(originLongitude), Number(originLatitude)] as ResponseCoordinate,
    destination: [Number(destinationLongitude), Number(destinationLatitude)] as ResponseCoordinate,
    departureAt: fromLocalInput(departureAt),
  });

  const generateGeometric = () => {
    if (!event) return;
    setPlanError("");
    try {
      const inputs = routeInputs();
      const scenario = planResponseScenario(event, {
        eventRevision: eventRevisionFingerprint(event),
        ...inputs,
        travelSpeedKph: Number(fallbackSpeed),
        travelMode,
      });
      onSave(scenario);
      setRoadRoutingState("fallback");
      setActionNotice(`已生成并保存 ${scenario.routes.length} 条直线敏感性估算；请在下方逐条查看影响区相交情况。`);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "推演参数无效");
    }
  };

  const generateRoad = async () => {
    if (!event || roadRoutingState === "loading") return;
    setPlanError("");
    setRoadRoutingState("loading");
    setInfrastructureQueryState("idle");
    try {
      const inputs = routeInputs();
      const response = await fetch("/api/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: inputs.origin, destination: inputs.destination, mode: travelMode }),
      });
      const result = await response.json().catch(() => ({ state: "error", provider: "高德地图", message: `真实道路请求失败（HTTP ${response.status}）` })) as AmapRoadRoutingResponse;
      if (!response.ok || result.state !== "ready") throw new Error(result.state === "ready" ? `真实道路请求失败（HTTP ${response.status}）` : result.message);
      let infrastructure: InfrastructureAssessment;
      try {
        const infrastructureResponse = await fetch("/api/infrastructure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routes: result.routes.map((route) => ({ routeId: route.routeId, mode: route.mode, coordinates: route.coordinates })) }),
        });
        const infrastructurePayload = await infrastructureResponse.json().catch(() => null);
        infrastructure = isInfrastructureAssessment(infrastructurePayload)
          ? infrastructurePayload
          : { state: "unavailable", provider: "OpenStreetMap · Overpass", message: `基础设施响应无效（HTTP ${infrastructureResponse.status}）` };
      } catch (infrastructureError) {
        infrastructure = { state: "unavailable", provider: "OpenStreetMap · Overpass", message: infrastructureError instanceof Error ? infrastructureError.message : "基础设施查询失败" };
      }
      const scenario = planRoadResponseScenario(event, {
        eventRevision: eventRevisionFingerprint(event),
        ...inputs,
        roadRouting: result,
        roadDisruptions: effectiveRoadDisruptions,
        infrastructure,
      });
      onSave(scenario);
      setInfrastructureQueryState(infrastructure.state);
      setRoadRoutingState("ready");
      setActionNotice(`已生成并保存 ${scenario.routes.length} 条真实道路候选；请在下方选择路线并打开地图复核。`);
    } catch (error) {
      setRoadRoutingState("idle");
      setInfrastructureQueryState("idle");
      setPlanError(`${error instanceof Error ? error.message : "真实道路请求失败"}；真实路网暂不可用时，可展开下方“直线敏感性估算”。`);
    }
  };

  const importRoadDisruptions = async (file: File | undefined) => {
    if (!file) return;
    setDisruptionError("");
    try {
      if (file.size > 512 * 1024) throw new Error("道路中断文件不能超过 512 KB");
      const disruptions = normalizeRoadDisruptionGeoJson(JSON.parse(await file.text()));
      setRoadDisruptions(disruptions);
      setRoadRoutingState("idle");
    } catch (error) {
      setRoadDisruptions([]);
      setDisruptionError(error instanceof Error ? error.message : "道路中断 GeoJSON 无效");
    }
  };

  const saveRoadReports = async () => {
    if (!roadDisruptions.length || registryBusyId) return;
    setRegistryBusyId("new");
    setDisruptionError("");
    try {
      const response = await fetch("/api/road-disruptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roadDisruptionFeatureCollection(roadDisruptions)),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || `道路中断上报失败（HTTP ${response.status}）`);
      setRoadDisruptions([]);
      await refreshRoadRegistry();
      setRoadRoutingState("idle");
    } catch (error) {
      setDisruptionError(error instanceof Error ? error.message : "道路中断上报失败");
    } finally {
      setRegistryBusyId(null);
    }
  };

  const reviewRoadReport = async (entry: RoadDisruptionRegistryEntry, action: "verify" | "resolve" | "reject") => {
    if (registryBusyId) return;
    if (currentUserRole !== "admin") return;
    const actionLabel = action === "verify" ? "核验并作为路线阻断依据" : action === "resolve" ? "解除这条道路中断" : "驳回这条现场上报";
    if (!window.confirm(`确认${actionLabel}“${entry.label}”？完成后现有路线需要重新计算。`)) return;
    setRegistryBusyId(entry.disruptionId);
    setDisruptionError("");
    try {
      const response = await fetch("/api/road-disruptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disruptionId: entry.disruptionId, revision: entry.revision, action }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || `道路中断核验失败（HTTP ${response.status}）`);
      await refreshRoadRegistry();
      setRoadRoutingState("idle");
      setActionNotice(`道路中断已${action === "verify" ? "核验" : action === "resolve" ? "解除" : "驳回"}；请重新生成路线候选。`);
    } catch (error) {
      setDisruptionError(error instanceof Error ? error.message : "道路中断核验失败");
    } finally {
      setRegistryBusyId(null);
    }
  };

  const exportScenario = (scenario: ResponseScenario) => {
    const blob = new Blob([JSON.stringify(responseScenarioGeoJson(scenario), null, 2)], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tianxun-response-${scenario.scenarioId.replace(/[^a-zA-Z0-9_-]/g, "-")}.geojson`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <aside ref={panelRef} className="task-panel response-panel" role="dialog" aria-modal={open ? "true" : undefined} aria-labelledby="response-panel-title" hidden={!open} inert={!open ? true : undefined}>
    <div className="task-panel-heading response-panel-heading">
      <div><span>处置支持</span><h2 id="response-panel-title">处置推演 <b>{scenarios.length}</b></h2><p>真实路网 + 中断台账 + 设施暴露 · WGS 84</p></div>
      <button ref={closeRef} onClick={onClose} aria-label="关闭处置推演">×</button>
    </div>
    <div className="response-panel-body">
      <section className="response-method-note">
        <strong>真实路网、道路中断与基础设施复核</strong>
        <p>中国境内支持高德驾车、步行、骑行和电动自行车规划，并用灾害影响场、核验台账及 OSM/Overpass 桥梁、隧道、涉水点三次筛查。OSM 是社区维护的基础设施底图，更新频率以结果中的数据时点为准，不证明设施当前完好；燃油摩托车没有可靠专用接口，暂不冒充驾车路线。</p>
      </section>
      <section className="response-create">
        <h3>建立推演场景</h3>
        <label>搜索灾害事件<input type="search" value={eventQuery} onChange={(change) => setEventQuery(change.target.value)} placeholder="输入灾种、地点或事件名称" /></label>
        <label>灾害主事件
          <select value={event?.masterEventId ?? ""} onChange={(change) => { const selectedEvent = events.find((candidate) => candidate.masterEventId === change.target.value); if (selectedEvent) onChooseEvent(selectedEvent); }}>
            <option value="">请选择事件</option>
            {matchingEvents.map((candidate) => <option key={candidate.masterEventId} value={candidate.masterEventId}>{hazardMeta[candidate.hazard].label} · {candidate.title}</option>)}
          </select>
        </label>
        {event ? <>
          <div className={`response-source-quality ${event.dispatchEligibility}`}><strong>{event.dispatchEligibility === "ready" ? "事件来源已核验" : "事件需要人工复核"}</strong><span>{event.cycloneForecast?.impactField ? `${event.cycloneForecast.impactField.frames.length} 个台风逐时影响场时间片` : `${event.geometry.type} 来源几何`} · 更新 {formatTimeWithYear(event.updatedAt)} UTC+08</span></div>
          <div className="response-fields">
            <label>出行方式<select value={travelMode} onChange={(change) => { const mode = change.target.value as AmapTravelMode; setTravelMode(mode); setFallbackSpeed(mode === "walking" ? "5" : mode === "bicycling" ? "15" : mode === "electrobike" ? "25" : "35"); setRoadRoutingState("idle"); }}>{Object.entries(amapTravelModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>起点经度<input inputMode="decimal" value={originLongitude} aria-describedby={planError ? "response-plan-error" : undefined} onChange={(change) => setOriginLongitude(change.target.value)} /></label>
            <label>起点纬度<input inputMode="decimal" value={originLatitude} aria-describedby={planError ? "response-plan-error" : undefined} onChange={(change) => setOriginLatitude(change.target.value)} /></label>
            <label>目的地经度<input inputMode="decimal" value={destinationLongitude} aria-describedby={planError ? "response-plan-error" : undefined} onChange={(change) => setDestinationLongitude(change.target.value)} /></label>
            <label>目的地纬度<input inputMode="decimal" value={destinationLatitude} aria-describedby={planError ? "response-plan-error" : undefined} onChange={(change) => setDestinationLatitude(change.target.value)} /></label>
            <label>出发时间（UTC+08）<input type="datetime-local" value={departureAt} onChange={(change) => setDepartureAt(change.target.value)} /></label>
          </div>
          <div className="response-point-actions" role="group" aria-label="设置推演起终点"><button type="button" onClick={() => onRequestPointPick("origin")}>在地图选起点</button><button type="button" onClick={() => onRequestPointPick("destination")}>在地图选目的地</button><button type="button" onClick={() => { setOriginLongitude(event.longitude.toFixed(6)); setOriginLatitude(event.latitude.toFixed(6)); setRoadRoutingState("idle"); }}>起点使用灾害中心</button><button type="button" onClick={() => { const nextOriginLongitude = destinationLongitude; const nextOriginLatitude = destinationLatitude; setDestinationLongitude(originLongitude); setDestinationLatitude(originLatitude); setOriginLongitude(nextOriginLongitude); setOriginLatitude(nextOriginLatitude); setRoadRoutingState("idle"); }}>交换起终点</button></div>
          <div className="response-disruption-import">
            <div><strong>道路毁损与封闭</strong><span>{registryState === "loading" ? "正在读取中断台账…" : registryState === "public-read-only" ? "公网只读入口不展示内部现场上报" : registryState === "unavailable" ? "台账不可用；本次只能使用临时导入" : `有效台账 ${registryDisruptions.length} 条 · 本次临时导入 ${roadDisruptions.length} 条`}</span></div>
            <label>上传 GeoJSON<input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(change) => { const file = change.target.files?.[0]; void importRoadDisruptions(file); change.target.value = ""; }} /></label>
            <button type="button" onClick={() => { setRoadDisruptions([]); setDisruptionError(""); setRoadRoutingState("idle"); }} disabled={!roadDisruptions.length}>清空</button>
            <button type="button" onClick={() => void saveRoadReports()} disabled={!roadDisruptions.length || registryState !== "operational-database" || Boolean(registryBusyId)}>{registryBusyId === "new" ? "上报中…" : "保存为台账上报"}</button>
            <small>支持道路冲毁、桥梁故障、积水、滑坡、封路和限制通行。所有新入库记录都会被强制降为“待核验”；缺少 validTo 时按 24 小时自动失效，只有管理员核验后才构成硬阻断。</small>
          </div>
          {registryDisruptions.length ? <div className="response-disruption-registry" aria-label="有效道路中断台账">
            {registryDisruptions.slice(0, 12).map((entry) => <article key={entry.disruptionId} className={entry.verification}>
              <div><strong>{roadDisruptionKindLabel(entry.kind)} · {entry.label}</strong><span>{entry.verification === "verified" ? "已核验" : "现场上报待核验"} · {entry.impact === "blocked" ? "完全阻断" : "限制通行"} · v{entry.revision}</span><small>{entry.source || "未提供外部来源"} · 有效至 {entry.validTo ? `${formatTimeWithYear(entry.validTo)} UTC+08` : "未设置"}</small></div>
              <div>{currentUserRole === "admin" ? <>{entry.verification === "reported" ? <><button disabled={registryBusyId === entry.disruptionId} onClick={() => void reviewRoadReport(entry, "verify")}>核验</button><button disabled={registryBusyId === entry.disruptionId} onClick={() => void reviewRoadReport(entry, "reject")}>驳回</button></> : null}<button disabled={registryBusyId === entry.disruptionId} onClick={() => void reviewRoadReport(entry, "resolve")}>解除</button></> : <small>仅管理员可核验或解除</small>}</div>
            </article>)}
            {registryDisruptions.length > 12 ? <p>另有 {registryDisruptions.length - 12} 条有效记录参与计算；为控制面板长度未全部展开。</p> : null}
          </div> : null}
          {disruptionError ? <div className="response-plan-error" role="alert">{disruptionError}</div> : null}
          {planError ? <div id="response-plan-error" className="response-plan-error" role="alert">{planError}</div> : null}
          {actionNotice ? <div className="response-action-notice" role="status">{actionNotice}</div> : null}
          <div className="response-generate-actions">
            <button className="response-generate" onClick={() => void generateRoad()} disabled={roadRoutingState === "loading"}>{roadRoutingState === "loading" ? "正在连接路网与基础设施…" : "生成真实道路候选"}</button>
          </div>
          <details className="response-fallback-options">
            <summary>真实路网不可用时：直线敏感性估算</summary>
            <p>这不是道路规划。假设速度只用于估算沿直线移动的到达时刻，以检查路线与灾害 4D 影响场的时间相交；不使用高德路况，也不能判断道路、桥梁或隧道可通行。</p>
            <div><label>假设平均速度（km/h）<input type="number" min="5" max="160" value={fallbackSpeed} onChange={(change) => setFallbackSpeed(change.target.value)} /></label><button className="response-generate-fallback" onClick={generateGeometric}>生成直线估算</button></div>
          </details>
          {roadRoutingState === "ready" ? <div className={`response-routing-ready ${infrastructureQueryState === "ready" ? "" : "partial"}`} role="status">高德{amapTravelModeLabels[travelMode]}路线已接通；耗时采用高德返回值，不读取直线估算速度。已完成灾害与 {effectiveRoadDisruptions.length} 条有效/临时道路中断复核。{infrastructureQueryState === "ready" ? "OSM 基础设施暴露查询已完成，设施结构状态仍须核验。" : infrastructureQueryState === "too_large" ? "路线范围超过当前 OSM 服务的单次安全阈值，基础设施覆盖未知。" : infrastructureQueryState === "unsupported" ? "当前路线不支持 OSM 包围盒查询，基础设施覆盖未知。" : "Overpass 暂不可用，路线仍已保存但基础设施覆盖未知。"}</div> : roadRoutingState === "fallback" ? <div className="response-routing-fallback" role="status">当前保存的是{amapTravelModeLabels[travelMode]}直线敏感性估算，不代表真实道路可通行。</div> : null}
        </> : <p className="response-select-hint">从当前监测事件中选择一个主事件，或在灾害详情中点击“建立处置推演场景”。</p>}
      </section>
      <section className="response-scenarios">
        <h3>已保存场景</h3>
        {!scenarios.length ? <div className="task-empty"><strong>暂无处置推演</strong><p>选择灾害事件并设置起点、目的地与出发时间。</p></div> : null}
        {scenarios.map((scenario) => {
          const currentEvent = events.find((candidate) => candidate.masterEventId === scenario.masterEventId);
          const stale = !currentEvent || eventRevisionFingerprint(currentEvent) !== scenario.eventRevision;
          const selectedRoute = scenario.routes.find((route) => route.routeId === scenario.selectedRouteId) ?? scenario.routes[0];
          return <article key={scenario.scenarioId} className={`response-scenario ${activeScenarioId === scenario.scenarioId ? "active" : ""}`}>
            <div className="response-scenario-title"><div><span>{hazardMeta[scenario.hazard]?.label ?? scenario.hazard} · {amapTravelModeLabels[scenario.travelMode ?? "driving"]}</span><strong>{scenario.title}</strong><small>出发 {formatTimeWithYear(scenario.departureAt)} UTC+08 · {scenario.router === "geometric_preview_v1" ? "直线敏感性估算 v1" : "高德多方式真实道路 v1"}</small></div><button onClick={() => onRemove(scenario.scenarioId)} aria-label={`删除处置推演 ${scenario.title}`}>删除</button></div>
            {stale ? <div className="response-stale" role="status">事件版本已变化；旧路线仅供回放，必须按当前影响场重新生成。</div> : null}
            <div className="response-route-options" role="group" aria-label="候选路线">
              {scenario.routes.map((route) => <button key={route.routeId} className={`${route.status} ${route.routeId === scenario.selectedRouteId ? "active" : ""}`} onClick={() => onSelectRoute(scenario.scenarioId, route.routeId)} aria-pressed={route.routeId === scenario.selectedRouteId}>
                <strong>{route.label}</strong><span>{responseRouteStatusLabel(route.status)}</span><small>{route.distanceKm.toFixed(1)} km · 约 {route.estimatedMinutes} 分钟{route.exposureKm > 0 ? ` · 影响区内 ${route.exposureKm.toFixed(1)} km` : ""}{route.roadProvider ? ` · ${route.roadProvider}` : ""}{route.restriction ? " · 存在限行" : ""}{route.disruptionConflicts?.length ? ` · 中断冲突 ${route.disruptionConflicts.length}` : ""}{route.infrastructureCrossings?.length ? ` · 设施穿越 ${route.infrastructureCrossings.length}` : ""}</small>
              </button>)}
            </div>
            {selectedRoute.roadProvider ? <div className="response-road-evidence">
              {(scenario.travelMode ?? "driving") === "driving" ? <><span>拥堵/严重拥堵 {(selectedRoute.traffic?.congestedKm ?? 0) + (selectedRoute.traffic?.severeCongestionKm ?? 0)} km</span><span>红绿灯 {selectedRoute.trafficLights ?? 0}</span><span>收费 ¥{selectedRoute.tollsYuan ?? 0}</span></> : <span>{amapTravelModeLabels[scenario.travelMode ?? "driving"]}上游预计耗时</span>}
              <span>道路吸附 起点 {selectedRoute.originSnapKm ?? 0} / 终点 {selectedRoute.destinationSnapKm ?? 0} km</span>
              <small>{selectedRoute.roadNames?.length ? `主要道路：${selectedRoute.roadNames.slice(0, 5).join("、")}` : "高德未返回可识别道路名称"}</small>
              <b className="unknown">设施结构状态：未核验</b>
              <b className={scenario.infrastructureData?.state === "ready" ? "checked" : "unknown"}>OSM 设施暴露：{scenario.infrastructureData?.state === "ready" ? `已核对 ${scenario.infrastructureCheckCount ?? 0} 个要素 · 本路线穿越 ${selectedRoute.infrastructureCrossings?.length ?? 0} 处` : "覆盖未知"}</b>
              <b className={(scenario.roadDisruptionCheckCount ?? scenario.roadDisruptions?.length ?? 0) > 0 ? "checked" : "unknown"}>道路毁损数据：{(scenario.roadDisruptionCheckCount ?? scenario.roadDisruptions?.length ?? 0) > 0 ? `已核对 ${scenario.roadDisruptionCheckCount ?? scenario.roadDisruptions?.length ?? 0} 条 · 保存 ${scenario.roadDisruptions?.length ?? 0} 条相交证据` : "未提供"}</b>
              {selectedRoute.infrastructureCrossings?.length ? <small className="infrastructure-crossings">设施存在不等于安全：{selectedRoute.infrastructureCrossings.slice(0, 8).map((crossing, index) => <span key={crossing.infrastructureId}>{index ? "；" : ""}<a href={safeHttpUrl(crossing.sourceUrl)} target="_blank" rel="noreferrer">{infrastructureKindLabel(crossing.kind)}·{crossing.label.replace(/^.*? · /, "")}</a></span>)}{selectedRoute.infrastructureCrossings.length > 8 ? `；另 ${selectedRoute.infrastructureCrossings.length - 8} 处` : ""}</small> : null}
              {scenario.infrastructureData?.state === "ready" ? <small className="infrastructure-source"><a href={safeHttpUrl(scenario.infrastructureData.sourceUrl)} target="_blank" rel="noreferrer">{scenario.infrastructureData.attribution} · 查看许可与来源 ↗</a><br />{scenario.infrastructureData.dataProfile === "china_daily" ? "中国日更镜像（非实时）" : "公共 Overpass 上游"} · {overpassCacheStatusLabel(scenario.infrastructureData.cacheStatus)}{scenario.infrastructureData.osmBaseTimestamp ? ` · 数据时点 ${formatTimeWithYear(scenario.infrastructureData.osmBaseTimestamp)} UTC+08` : " · 数据时点未返回"}<br />查询时间 {formatTimeWithYear(scenario.infrastructureData.fetchedAt!)} UTC+08 · 包围盒约 {scenario.infrastructureData.queryAreaKm2?.toFixed(1)} km²</small> : scenario.infrastructureData ? <small className="infrastructure-warning">{scenario.infrastructureData.note}</small> : null}
              {selectedRoute.disruptionConflicts?.length ? <small className="disruption-conflicts">冲突：{selectedRoute.disruptionConflicts.map((conflict) => `${roadDisruptionKindLabel(conflict.kind)}·${conflict.label}${conflict.verification === "verified" ? "（已核验）" : "（上报待核验）"}`).join("；")}</small> : null}
            </div> : null}
            <p className={`response-route-note ${selectedRoute.status}`}>{selectedRoute.note}</p>
            <div className="response-actions"><button onClick={() => onActivate(scenario.scenarioId)}>在地图查看</button><button onClick={() => exportScenario(scenario)}>导出 GeoJSON</button>{currentEvent ? <button onClick={() => onChooseEvent(currentEvent)}>载入当前事件重算</button> : null}</div>
          </article>;
        })}
      </section>
    </div>
    <footer>处置推演为决策支持功能，不输出“安全路线”结论；穿越影响区、事件未核验或超出预报时效的候选均会被显式限制。</footer>
  </aside>;
}

function TaskPanel({ open, tasks, syncState, storageMode, fleet, activeTaskId, onActivate, onUpdate, onRemove, onClose, onRetry }: { open: boolean; tasks: SatelliteTask[]; syncState: Record<string, TaskSyncState>; storageMode: TaskStorageMode; fleet: SatelliteFleetState; activeTaskId: string | null; onActivate: (taskId: string) => void; onUpdate: (taskId: string, patch: Partial<SatelliteTask>) => void; onRemove: (taskId: string) => void; onClose: () => void; onRetry: (task: SatelliteTask) => Promise<SatelliteTask | null> }) {
  const [visibility, setVisibility] = useState<Record<string, VisibilityState>>({});
  const [scheduling, setScheduling] = useState<JointSchedulingState>({ state: "idle" });
  const [manualRules, setManualRules] = useState<SchedulingManualRules>(() => emptySchedulingManualRules());
  const [scenarioName, setScenarioName] = useState("联合试排方案");
  const [scenarioLibrary, setScenarioLibrary] = useState<PlanningScenarioLibraryState>({ state: "loading", summaries: [] });
  const [compareLeftId, setCompareLeftId] = useState("");
  const [compareRightId, setCompareRightId] = useState("");
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");
  const [exportScope, setExportScope] = useState<"eligible" | "scheduled" | "selected">("eligible");
  const [selectedExportTaskIds, setSelectedExportTaskIds] = useState<Set<string>>(new Set());
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [aoiImportError, setAoiImportError] = useState<Record<string, string>>({});
  const [weatherTaskId, setWeatherTaskId] = useState<string | null>(activeTaskId);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const visibilityRequestGeneration = useRef(new Map<string, number>());
  const visibilityInputKeys = useMemo(() => Object.fromEntries(tasks.map((task) => [task.taskId, aoiFingerprint({
    eventRevision: task.eventRevision,
    aoiType: task.aoiType,
    aoiRadiusKm: task.aoiRadiusKm,
    aoiWidthKm: task.aoiWidthKm,
    aoiHeightKm: task.aoiHeightKm,
    aoiLengthKm: task.aoiLengthKm,
    aoiBearingDeg: task.aoiBearingDeg,
    geometry: task.aoiType === "source" ? task.sourceGeometry : task.customGeometry,
    imagingStart: task.imagingStart,
    imagingEnd: task.imagingEnd,
    sensors: task.sensors,
    sarImagingModes: task.sarImagingModes,
    minimumCoveragePercent: task.minimumCoveragePercent,
    spatialResolutionMeters: task.spatialResolutionMeters,
    incidenceAngleMinDeg: task.incidenceAngleMinDeg,
    incidenceAngleMaxDeg: task.incidenceAngleMaxDeg,
    orbitDirectionPreference: task.orbitDirectionPreference,
    cycloneTrackingTarget: task.cycloneTrackingTarget,
    priority: task.priority,
    revisitCount: task.revisitCount,
    deliveryDeadline: task.deliveryDeadline,
  })])), [tasks]);
  const previousVisibilityInputKeys = useRef(visibilityInputKeys);
  useEffect(() => {
    const previous = previousVisibilityInputKeys.current;
    const changed = new Set(Object.keys(visibilityInputKeys).filter((taskId) => previous[taskId] && previous[taskId] !== visibilityInputKeys[taskId]));
    const removed = new Set(Object.keys(previous).filter((taskId) => !(taskId in visibilityInputKeys)));
    if (changed.size || removed.size) {
      changed.forEach((taskId) => visibilityRequestGeneration.current.set(taskId, (visibilityRequestGeneration.current.get(taskId) ?? 0) + 1));
      setVisibility((current) => Object.fromEntries(Object.entries(current).filter(([taskId]) => taskId in visibilityInputKeys && !changed.has(taskId))));
      const invalidTaskIds = new Set([...changed, ...removed]);
      if (invalidTaskIds.size) {
        setScheduling((current) => scheduleReferencesAnyTask(current, invalidTaskIds) ? { state: "idle" } : current);
        setManualRules((current) => removeTaskRules(current, invalidTaskIds));
        setScenarioLibrary((current) => current.active && planningScenarioReferencesAnyTask(current.active, invalidTaskIds)
          ? { ...current, active: undefined, comparison: undefined, message: "相关任务条件已变化，旧排程已移出当前工作区；其他任务的机会仍保留。" }
          : current);
      }
    }
    previousVisibilityInputKeys.current = visibilityInputKeys;
  }, [visibilityInputKeys]);
  useEffect(() => {
    let stopped = false;
    void fetch("/api/planning/scenarios", { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as { scenarios?: PlanningScenarioSummary[]; error?: string };
      if (!response.ok) throw new Error(result.error || `方案库读取失败（HTTP ${response.status}）`);
      if (!stopped) setScenarioLibrary({ state: "ready", summaries: result.scenarios ?? [] });
    }).catch((error) => {
      if (!stopped) setScenarioLibrary({ state: "error", summaries: [], message: error instanceof Error ? error.message : "方案库暂不可用" });
    });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);
  const planningProblems = useMemo(() => tasks
    .map((task) => visibility[task.taskId]?.planningProblem)
    .filter((problem): problem is MissionPlanningProblem => Boolean(problem)), [tasks, visibility]);
  const recommendedSchedule = scheduling.comparison?.recommendedAlgorithm === "priority_greedy_v1" ? scheduling.comparison.greedy : scheduling.comparison?.optimized;
  const eligibleExportTasks = tasks.filter((task) => validateSatelliteTask(task as unknown as Record<string, unknown>, { requireApproved: true, requirePayload: true, requireProvenance: true }).ok && syncState[task.taskId]?.state === "synced" && ["candidate", "reviewed"].includes(task.status));
  const scheduledTaskIds = new Set(recommendedSchedule?.assignments.map((assignment) => assignment.taskId) ?? []);
  const exportableTasks = eligibleExportTasks.filter((task) => exportScope === "eligible" || (exportScope === "scheduled" ? scheduledTaskIds.has(task.taskId) : selectedExportTaskIds.has(task.taskId)));
  const manualRuleCount = manualRules.lockedOpportunityRefs.length + manualRules.excludedOpportunityRefs.length + Object.keys(manualRules.forcedSatelliteByTask).length + Object.keys(manualRules.forcedImagingModeByTask).length;
  const exportableCount = exportableTasks.length;
  const exportable = exportableCount > 0;
  const exportValidated = async (format: ExportFormat) => {
    setExportError("");
    try {
      const response = await fetch("/api/tasks/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          tasks: exportableTasks.map((task) => ({ taskId: task.taskId, revision: task.revision, eventRevision: task.eventRevision, aoiHash: task.aoiHash })),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || `服务端复核失败（HTTP ${response.status}）`);
      }
      downloadTaskArtifact(await response.blob(), response.headers.get("content-disposition"), format);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出前复核失败");
    }
  };
  const calculateVisibility = async (task: SatelliteTask) => {
    const requestGeneration = (visibilityRequestGeneration.current.get(task.taskId) ?? 0) + 1;
    visibilityRequestGeneration.current.set(task.taskId, requestGeneration);
    setVisibility((current) => ({ ...current, [task.taskId]: { state: "loading", windows: [] } }));
    try {
      let calculationTask = task;
      if (storageMode === "operational-database" && syncState[task.taskId]?.state !== "synced") {
        const synchronized = await onRetry(task);
        if (!synchronized) {
          if (visibilityRequestGeneration.current.get(task.taskId) !== requestGeneration) return;
          setVisibility((current) => ({ ...current, [task.taskId]: { state: "error", message: "任务尚未完成同步，请先处理上方同步提示后再计算", windows: [] } }));
          return;
        }
        calculationTask = synchronized;
      }
      const requestVisibility = async (candidate: SatelliteTask) => {
        const requestBody = storageMode === "public-read-only"
          ? compactSatelliteTaskForSync(candidate as unknown as Record<string, unknown>)
          : { taskId: candidate.taskId, revision: candidate.revision };
        const response = await fetch("/api/visibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
        const result = await response.json() as { state?: VisibilityState["state"]; mode?: VisibilityState["mode"]; message?: string; windows?: VisibilityWindow[]; orbitVersion?: string; computedAt?: string; planningSummary?: MissionPlanningSummary; planningProblem?: MissionPlanningProblem };
        return { response, result };
      };
      let { response, result } = await requestVisibility(calculationTask);
      if (storageMode === "operational-database" && response.status === 409 && /任务已有新版本/.test(result.message ?? "")) {
        const synchronized = await onRetry(calculationTask);
        if (synchronized) ({ response, result } = await requestVisibility(synchronized));
      }
      const windows = (result.windows ?? []).map((window) => ({ ...window, orbitVersion: window.orbitVersion ?? result.orbitVersion, computedAt: window.computedAt ?? result.computedAt }));
      if (visibilityRequestGeneration.current.get(task.taskId) !== requestGeneration) return;
      setVisibility((current) => ({ ...current, [task.taskId]: { state: result.state ?? (response.ok ? "ready" : "error"), mode: result.mode, message: result.message, windows, planningSummary: result.planningSummary, planningProblem: result.planningProblem } }));
    } catch {
      if (visibilityRequestGeneration.current.get(task.taskId) !== requestGeneration) return;
      setVisibility((current) => ({ ...current, [task.taskId]: { state: "error", message: "无法连接可见性计算接口", windows: [] } }));
    }
  };
  const runJointScheduling = async () => {
    if (!planningProblems.length) {
      setScheduling({ state: "error", message: "请先为至少一个任务计算卫星机会" });
      return;
    }
    setScheduling({ state: "loading" });
    try {
      const response = await fetch("/api/planning/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problems: planningProblems, transitionBufferSeconds: 120, manualRules }),
      });
      const result = await response.json() as SchedulingComparison & { error?: string; engine?: { mode: "external" | "local_fallback" | "local"; engineId: string; fallbackReason?: string } };
      if (!response.ok) throw new Error(result.error || `联合试排失败（HTTP ${response.status}）`);
      setScheduling({ state: "ready", comparison: result });
    } catch (error) {
      setScheduling({ state: "error", message: error instanceof Error ? error.message : "联合试排接口不可用" });
    }
  };
  const changeManualRules = (change: (current: SchedulingManualRules) => SchedulingManualRules) => {
    setManualRules(change);
    setScheduling({ state: "idle" });
    setScenarioLibrary((current) => ({ ...current, active: undefined, comparison: undefined, message: undefined }));
  };
  const setOpportunityRule = (reference: string, rule: "lock" | "exclude") => changeManualRules((current) => {
    const locked = new Set(current.lockedOpportunityRefs);
    const excluded = new Set(current.excludedOpportunityRefs);
    if (rule === "lock") {
      if (locked.has(reference)) locked.delete(reference); else { locked.add(reference); excluded.delete(reference); }
    } else if (excluded.has(reference)) excluded.delete(reference); else { excluded.add(reference); locked.delete(reference); }
    return { ...current, lockedOpportunityRefs: [...locked].sort(), excludedOpportunityRefs: [...excluded].sort() };
  });
  const setForcedRule = (taskId: string, field: "satellite" | "mode", value: string) => changeManualRules((current) => {
    const key = field === "satellite" ? "forcedSatelliteByTask" : "forcedImagingModeByTask";
    const next = { ...current[key] };
    if (value) next[taskId] = value; else delete next[taskId];
    return { ...current, [key]: next };
  });
  const fetchPlanningScenario = async (scenarioId: string) => {
    const response = await fetch(`/api/planning/scenarios?scenarioId=${encodeURIComponent(scenarioId)}`, { cache: "no-store" });
    const result = await response.json() as { scenario?: PlanningScenarioRecord; error?: string };
    if (!response.ok || !result.scenario) throw new Error(result.error || `规划方案读取失败（HTTP ${response.status}）`);
    return result.scenario;
  };
  const savePlanningScenarioVersion = async () => {
    if (!scheduling.comparison || !planningProblems.length) return;
    setScenarioLibrary((current) => ({ ...current, state: "saving", message: undefined }));
    try {
      const response = await fetch("/api/planning/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName,
          problems: planningProblems,
          manualRules,
          transitionBufferSeconds: 120,
          seriesId: scenarioLibrary.active?.seriesId,
          parentScenarioId: scenarioLibrary.active?.scenarioId,
        }),
      });
      const result = await response.json() as { scenario?: PlanningScenarioRecord; error?: string };
      if (!response.ok || !result.scenario) throw new Error(result.error || `方案保存失败（HTTP ${response.status}）`);
      const summary = planningScenarioSummary(result.scenario);
      setManualRules(result.scenario.manualRules);
      setScheduling({ state: "ready", comparison: result.scenario.comparison });
      setScenarioLibrary((current) => ({
        ...current,
        state: "ready",
        active: result.scenario,
        message: `已保存 ${result.scenario!.name} v${result.scenario!.version}`,
        summaries: [summary, ...current.summaries.filter((item) => item.scenarioId !== summary.scenarioId)].slice(0, 100),
      }));
    } catch (error) {
      setScenarioLibrary((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "方案保存失败" }));
    }
  };
  const loadPlanningScenario = async (scenarioId: string) => {
    setScenarioLibrary((current) => ({ ...current, state: "loading", message: undefined }));
    try {
      const scenario = await fetchPlanningScenario(scenarioId);
      if (!planningScenarioMatchesProblems(scenario, planningProblems.map((problem) => problem.problemId))) throw new Error("该版本使用的任务或机会已经变化，只能参与历史对比，不能恢复为当前工作方案");
      setManualRules(scenario.manualRules);
      setScheduling({ state: "ready", comparison: scenario.comparison });
      setScenarioName(scenario.name);
      setScenarioLibrary((current) => ({ ...current, state: "ready", active: scenario, message: `已恢复 ${scenario.name} v${scenario.version}` }));
    } catch (error) {
      setScenarioLibrary((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "方案恢复失败" }));
    }
  };
  const comparePlanningScenarios = async () => {
    if (!compareLeftId || !compareRightId || compareLeftId === compareRightId) {
      setScenarioLibrary((current) => ({ ...current, message: "请选择两个不同的方案版本" }));
      return;
    }
    setScenarioLibrary((current) => ({ ...current, state: "loading", message: undefined }));
    try {
      const [left, right] = await Promise.all([fetchPlanningScenario(compareLeftId), fetchPlanningScenario(compareRightId)]);
      setScenarioLibrary((current) => ({ ...current, state: "ready", comparison: { left, right } }));
    } catch (error) {
      setScenarioLibrary((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "方案对比失败" }));
    }
  };
  const exportCurrentPlanningScenario = () => {
    if (!scheduling.comparison) return;
    downloadJsonArtifact({
      schemaVersion: "tianxun.planning.workbench-export/v1",
      exportedAt: new Date().toISOString(),
      status: "simulation_only",
      problemIds: planningProblems.map((problem) => problem.problemId),
      manualRules,
      comparison: scheduling.comparison,
    }, `tianxun-planning-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  };
  return <aside ref={panelRef} className="task-panel" role="dialog" aria-modal={open ? "true" : undefined} aria-labelledby="task-panel-title" hidden={!open} inert={!open ? true : undefined}>
    <div className="task-panel-heading">
      <div><span>卫星任务工作台</span><h2 id="task-panel-title">卫星任务候选单 <b>{tasks.length}</b></h2><p>候选 → AOI 复核 → 机会 → 排程 → 执行回执 → 成像产品</p></div>
      <button ref={closeRef} onClick={onClose} aria-label="关闭卫星任务候选单">×</button>
    </div>
    <div className="task-export-bar">
      <span>导出任务包 · 当前 {exportableCount} 项</span>
      <select value={exportScope} aria-label="导出任务范围" onChange={(event) => setExportScope(event.target.value as "eligible" | "scheduled" | "selected")}><option value="eligible">全部通过复核</option><option value="scheduled">当前试排结果</option><option value="selected">手动勾选</option></select>
      <button disabled={!exportable} title={exportable ? `导出 ${exportableCount} 个已通过任务` : "没有通过校验且已同步的规划任务"} onClick={() => void exportValidated("json")}>JSON</button>
      <button disabled={!exportable} title={exportable ? `导出 ${exportableCount} 个已通过任务` : "没有通过校验且已同步的规划任务"} onClick={() => void exportValidated("csv")}>CSV</button>
      <button disabled={!exportable} title={exportable ? `导出 ${exportableCount} 个已通过任务` : "没有通过校验且已同步的规划任务"} onClick={() => void exportValidated("geojson")}>GeoJSON</button>
    </div>
    <section className={`joint-schedule ${scheduling.state}`} aria-labelledby="joint-schedule-title">
      <div className="joint-schedule-heading">
        <div><strong id="joint-schedule-title">多任务联合试排</strong><span>{planningProblems.length}/{tasks.length} 个任务已有机会</span></div>
        <button disabled={!planningProblems.length || scheduling.state === "loading"} onClick={() => void runJointScheduling()}>{scheduling.state === "loading" ? "正在比较算法…" : "运行试排"}</button>
      </div>
      <small>默认比较优先级贪心与有界约束搜索；配置 OR-Tools 服务后会校验外部选择。结果仅用于仿真，不改任务状态、不自动下发。</small>
      {planningProblems.length ? <details className="joint-manual-rules">
        <summary>人工规则 <b>{manualRuleCount}</b><span>锁定、排除或限定任务</span></summary>
        <div className="joint-task-rules">{planningProblems.map((problem) => {
          const satellites = [...new Set(problem.opportunities.map((opportunity) => opportunity.satelliteId))].sort();
          const modes = [...new Set(problem.opportunities.flatMap((opportunity) => opportunity.imagingMode ? [opportunity.imagingMode] : []))].sort();
          return <div key={problem.problemId}><strong>{problem.task.title}</strong><label>指定卫星<select value={manualRules.forcedSatelliteByTask[problem.task.taskId] ?? ""} onChange={(event) => setForcedRule(problem.task.taskId, "satellite", event.target.value)}><option value="">自动选择</option>{satellites.map((satellite) => <option key={satellite}>{satellite}</option>)}</select></label><label>指定模式<select value={manualRules.forcedImagingModeByTask[problem.task.taskId] ?? ""} onChange={(event) => setForcedRule(problem.task.taskId, "mode", event.target.value)}><option value="">自动选择</option>{modes.map((mode) => <option key={mode}>{mode}</option>)}</select></label></div>;
        })}</div>
        <button className="clear-manual-rules" disabled={!manualRuleCount} onClick={() => changeManualRules(() => emptySchedulingManualRules())}>清空全部人工规则</button>
        <small>单个机会的“锁定/排除”按钮位于对应任务的可见机会下方。冲突锁定会被服务端拒绝，不会静默改写。</small>
      </details> : null}
      {scheduling.message ? <p role="alert">{scheduling.message}</p> : null}
      {scheduling.comparison && recommendedSchedule ? <div className="joint-schedule-result">
        <div className="schedule-score-row">
          <span>贪心 <b>{scheduling.comparison.greedy.objectiveScore}</b></span>
          <span>{scheduling.comparison.optimized.algorithm.id === "external_or_tools_cp_sat_v1" ? "OR-Tools" : "有界搜索"} <b>{scheduling.comparison.optimized.objectiveScore}</b></span>
          <span>采用 <b>{scheduling.comparison.recommendedAlgorithm === "external_or_tools_cp_sat_v1" ? "OR-Tools" : scheduling.comparison.recommendedAlgorithm === "bounded_constraint_search_v1" ? "有界搜索" : "贪心"}</b></span>
        </div>
        {scheduling.comparison.engine ? <p className={`planning-engine-state ${scheduling.comparison.engine.mode}`}>{scheduling.comparison.engine.mode === "external" ? "外部 OR-Tools 已返回并通过本地约束复核" : scheduling.comparison.engine.mode === "local_fallback" ? `外部优化不可用，已降级为本地有界搜索：${scheduling.comparison.engine.fallbackReason ?? "原因未返回"}` : "当前使用本地有界约束搜索"}</p> : null}
        <p>{recommendedSchedule.summary.assignmentCount}/{recommendedSchedule.summary.requestedAssignments} 次观测已排入 · {recommendedSchedule.summary.scheduledTaskCount}/{recommendedSchedule.summary.taskCount} 个任务覆盖 · {recommendedSchedule.summary.conditionalAssignmentCount} 个条件机会</p>
        <ScheduleTimeline schedule={recommendedSchedule} onActivate={onActivate} />
        {recommendedSchedule.assignments.length ? <div className="schedule-assignments">{recommendedSchedule.assignments.slice(0, 12).map((assignment) => <button key={assignment.assignmentId} onClick={() => onActivate(assignment.taskId)} title="设为当前任务并在地图查看">
          <b>{assignment.taskTitle}{assignment.manuallyLocked ? <i>已锁定</i> : null}</b><span>{assignment.satelliteId} · {formatTimeWithYear(assignment.start)} UTC+08</span><small>{assignment.imagingMode ?? assignment.instrumentId ?? "模式待定"} · {assignment.constraintDecision === "eligible" ? "约束已满足" : "条件机会"}</small>
        </button>)}</div> : <p>当前没有可排入的候选机会。</p>}
        {recommendedSchedule.assignments.length > 12 ? <small>另有 {recommendedSchedule.assignments.length - 12} 个安排未在此处展开。</small> : null}
        {recommendedSchedule.unassigned.length ? <details><summary>{recommendedSchedule.unassigned.length} 个任务未满足全部重访</summary>{recommendedSchedule.unassigned.map((item) => <p key={item.taskId}>{item.taskTitle}：已排 {item.assigned}/{item.requested} 次 · {item.reason === "no_trial_eligible_opportunity" ? "无可进入试排的机会" : item.reason === "filtered_by_manual_rules" ? "已被人工卫星、模式或排除规则过滤" : item.reason === "revisit_target_partially_met" ? "仅部分满足重访次数" : "目标函数未选中"}</p>)}</details> : null}
        <div className="planning-version-actions"><label>方案名称<input value={scenarioName} maxLength={80} onChange={(event) => setScenarioName(event.target.value)} /></label><button onClick={() => void savePlanningScenarioVersion()} disabled={scenarioLibrary.state === "saving" || scenarioName.trim().length < 2}>{scenarioLibrary.state === "saving" ? "正在保存…" : scenarioLibrary.active ? `保存为新版本 v${scenarioLibrary.active.version + 1}` : "保存首个版本 v1"}</button><button onClick={exportCurrentPlanningScenario}>导出当前方案 JSON</button></div>
        <small>{scheduling.comparison.note}</small>
      </div> : null}
      <details className="planning-scenario-library">
        <summary>方案版本库 <b>{scenarioLibrary.summaries.length}</b><span>不可变仿真快照</span></summary>
        {scenarioLibrary.message ? <p role={scenarioLibrary.state === "error" ? "alert" : "status"}>{scenarioLibrary.message}</p> : null}
        {scenarioLibrary.summaries.length ? <div className="planning-version-list">{scenarioLibrary.summaries.slice(0, 12).map((summary) => <div key={summary.scenarioId}><span>{summary.name} · v{summary.version}</span><small>{formatTimeWithYear(summary.createdAt)} UTC+08 · 得分 {summary.objectiveScore} · {summary.assignmentCount} 次观测</small><button disabled={scenarioLibrary.state === "loading"} onClick={() => void loadPlanningScenario(summary.scenarioId)}>恢复此版本</button></div>)}</div> : <small>{scenarioLibrary.state === "loading" ? "正在读取方案库…" : "尚未保存方案版本。"}</small>}
        {scenarioLibrary.summaries.length >= 2 ? <div className="planning-version-compare"><select aria-label="对比基准版本" value={compareLeftId} onChange={(event) => setCompareLeftId(event.target.value)}><option value="">选择基准版本</option>{scenarioLibrary.summaries.map((summary) => <option key={summary.scenarioId} value={summary.scenarioId}>{summary.name} v{summary.version}</option>)}</select><select aria-label="对比目标版本" value={compareRightId} onChange={(event) => setCompareRightId(event.target.value)}><option value="">选择目标版本</option>{scenarioLibrary.summaries.map((summary) => <option key={summary.scenarioId} value={summary.scenarioId}>{summary.name} v{summary.version}</option>)}</select><button onClick={() => void comparePlanningScenarios()} disabled={scenarioLibrary.state === "loading"}>对比所选版本</button></div> : null}
        {scenarioLibrary.comparison ? <PlanningScenarioDiff left={scenarioLibrary.comparison.left} right={scenarioLibrary.comparison.right} /> : null}
        <small>“恢复”只恢复人工规则和仿真结果；任务或机会版本变化时会拒绝恢复，但仍可用于历史对比。</small>
      </details>
    </section>
    <details className={`orbit-fleet ${fleet.state}`}>
      <summary><span>SAR仿真轨道</span><strong>{fleet.state === "loading" ? "读取中" : `${fleet.current}/${fleet.satellites.length || 6} 当前可用`}</strong></summary>
      <div className="orbit-fleet-body">
        {fleet.message ? <p role={fleet.state === "error" ? "alert" : "status"}>{fleet.message}</p> : null}
        {fleet.satellites.map((satellite) => <article key={satellite.noradId} className={satellite.orbitStatus}>
          <div><b>{satellite.interfaceName || satellite.commonName}</b><span>NORAD {satellite.noradId}</span></div>
          <strong>{satellite.commonCode || satellite.interfaceCode || satellite.commonName}</strong>
          <small>{satellite.identityStatus === "unverified" ? "业务身份待核验" : "业务映射已配置"} · CelesTrak：{satellite.providerName || "尚无返回名称"}</small>
          {satellite.payloadProfile ? <small>{satellite.payloadProfile.payloadType} · {satellite.payloadProfile.frequencyBand}频段 · 左右侧视 · 入射角 {satellite.payloadProfile.incidenceAngleDeg.min}°～{satellite.payloadProfile.incidenceAngleDeg.max}° · 极化 {satellite.payloadProfile.polarizations.join("/") || "待提供"} · {satellite.payloadProfile.parameterStatus === "provisional_assumption" ? "临时假设参数" : "用户提供参数"}</small> : null}
          {satellite.payloadProfile ? <small>{satellite.payloadProfile.imagingModes.map((mode) => `${mode.name} ${mode.resolutionLabel}/${mode.nominalSceneCrossTrackKm}×${mode.nominalSceneAlongTrackKm} km`).join(" · ")}</small> : null}
          {satellite.payloadProfile?.productLevels.length ? <small>产品：{satellite.payloadProfile.productLevels.map((product) => `${product.level} ${product.name}（${product.code}）`).join(" · ")}</small> : satellite.payloadProfile ? <small>产品级别：尚未提供</small> : null}
          <time>{satellite.epoch ? `轨道历元 ${formatTimeWithYear(satellite.epoch)} UTC+08 · ${satellite.elementAgeHours ?? "--"}小时` : satellite.lastError || "尚未取得有效TLE"}</time>
        </article>)}
        <footer>每天自动刷新一次；失败保留上次有效TLE。业务名称与CelesTrak目录名称分开保存。 <a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer">接口说明 ↗</a></footer>
      </div>
    </details>
    {storageMode === "public-read-only" ? <div className="task-storage-banner" role="status"><strong>公网只读模式</strong><span>任务可在本机规划、导入和删除，但不会写入服务器；远程同步需启用 HTTPS 登录和任务权限。</span></div> : storageMode === "unavailable" ? <div className="task-storage-banner warning" role="alert"><strong>任务服务不可用</strong><span>当前修改仅保存在本机，恢复连接后可重试同步。</span></div> : null}
    {exportableCount !== tasks.length && tasks.length ? <div className="task-export-hint" role="status">将仅导出 {exportableCount}/{tasks.length} 项已通过任务；错误或未同步任务会保留在候选单，不再阻断其他任务。</div> : null}
    {exportError ? <div className="task-export-error" role="alert">{exportError}</div> : null}
    <div className="task-list">
      {!tasks.length ? <div className="task-empty"><strong>候选单为空</strong><p>从灾害详情中点击“加入卫星任务候选”，即可在这里设置AOI和成像时间窗。</p></div> : null}
      {tasks.map((task, index) => <article className={`task-item ${activeTaskId === task.taskId ? "active" : ""} ${expandedTaskIds.has(task.taskId) ? "expanded" : "collapsed"}`} key={task.taskId}>
        <div className="task-item-title">
          <i>{String(index + 1).padStart(2, "0")}</i>
          <div><label className="task-export-select"><input type="checkbox" checked={selectedExportTaskIds.has(task.taskId)} onChange={(event) => setSelectedExportTaskIds((current) => { const next = new Set(current); if (event.target.checked) next.add(task.taskId); else next.delete(task.taskId); return next; })} />选入手动导出</label><h3>{task.title}</h3><p>{hazardMeta[task.hazard].label} · 优先级 {task.priority} · {observationPhaseLabels[task.observationPhase]}</p><time>事件参考时间 · {formatTimeWithYear(task.eventOccurredAt)}</time><div className="task-card-actions"><button onClick={() => setExpandedTaskIds((current) => { const next = new Set(current); if (next.has(task.taskId)) next.delete(task.taskId); else next.add(task.taskId); return next; })} aria-expanded={expandedTaskIds.has(task.taskId)}>{expandedTaskIds.has(task.taskId) ? "收起参数" : "展开规划"}</button><button className="show-aoi" onClick={() => onActivate(task.taskId)}>在地图显示 AOI</button></div></div>
          {canTransitionTask(task.status, "cancelled") || ["submitted", "cancel_rejected"].includes(task.status) ? <button onClick={() => onRemove(task.taskId)} aria-label={`取消${task.title}`}>{task.status === "submitted" || task.status === "cancel_rejected" ? "申请取消" : task.revision > 0 ? "取消" : "删除草稿"}</button> : null}
        </div>
        <div className="task-coordinates"><span>中心坐标</span><code>{task.latitude.toFixed(6)}, {task.longitude.toFixed(6)}</code><button onClick={() => void copyCoordinates(task).then((copied) => { if (copied) { setCopiedTaskId(task.taskId); window.setTimeout(() => setCopiedTaskId((current) => current === task.taskId ? null : current), 1800); } })}>{copiedTaskId === task.taskId ? "已复制" : "复制"}</button></div>
        <div className={`task-quality ${task.aoiApproval}`}><span>{locationQualityLabels[task.locationQuality]} · ±{task.locationAccuracyKm} km</span><b>{task.aoiApproval === "source_verified" ? "来源几何已核验" : task.aoiApproval === "operator_confirmed" ? "操作员已复核 AOI" : "AOI 待复核"}</b><small>{task.evidenceCount} 条证据 · {task.masterEventId}</small>{task.aoiApproval === "review_required" ? <button onClick={() => onUpdate(task.taskId, { aoiApproval: "operator_confirmed", approvedAt: new Date().toISOString(), approvedBy: "当前操作员", approvalReason: "操作员已在地图核对当前 AOI、位置误差和观测目标" })}>确认当前 AOI</button> : null}</div>
        <WeatherForecastCard latitude={task.latitude} longitude={task.longitude} maximumCloudPercent={task.maximumCloudPercent} compact enabled={weatherTaskId === task.taskId} onRequest={() => setWeatherTaskId(task.taskId)} />
        {task.cycloneForecast ? <div className="task-forecast-summary"><strong>官方预报已随任务保存 · 动态跟踪</strong><span>{task.cycloneForecast.track.length} 个官方中心节点{task.cycloneForecast.impactField ? ` · ${task.cycloneForecast.impactField.frames.length} 个逐时时间片` : ""} · 至 {formatTimeWithYear(task.cycloneForecast.forecastValidUntil)} UTC+08</span><small>计算时按每次卫星过境时刻匹配对应预测片；官方新报次到达后必须重新计算机会。</small></div> : null}
        {task.hazard === "landslide" && task.orbitDirectionPreference ? <div className="task-landslide-summary"><strong>{task.orbitDirectionPreference === "ascending" ? "升轨" : task.orbitDirectionPreference === "descending" ? "降轨" : "任一轨向"} SAR 滑坡模板</strong><span>{task.referenceAcquisitionRequired ? "要求灾前参考影像" : "未要求灾前参考影像"} · {task.revisitCount} 次重访</span><small>地形格网是操作员确认的筛查 AOI，不是滑坡实况边界；成像机会仍需验证轨向、入射角及地形阴影/叠掩。</small></div> : null}
        <div className={`task-sync ${syncState[task.taskId]?.state ?? "local"}`} role="status">{syncState[task.taskId]?.state === "saving" ? "正在同步…" : syncState[task.taskId]?.state === "synced" ? (syncState[task.taskId]?.message ?? "已同步到业务数据库") : syncState[task.taskId]?.state === "error" ? <>同步失败：{syncState[task.taskId]?.message ?? "请重试"} <button onClick={() => void onRetry(task)}>重试同步</button></> : "仅保存在本机"}</div>
    <div className="aoi-type-selector" role="group" aria-label="AOI 目标类型">
          {aoiOptions.filter((option) => option.id !== "source" || task.sourceGeometry).map((option) => <button key={option.id} aria-pressed={task.aoiType === option.id} className={task.aoiType === option.id ? "active" : ""} onClick={() => onUpdate(task.taskId, {
            aoiType: option.id,
            ...customGeometryPatch(task.customGeometry, option.id),
          })}>{option.label}</button>)}
        </div>
        {["polygon", "multi"].includes(task.aoiType) ? <div className="custom-aoi-tools">
          <button onClick={() => onActivate(task.taskId)}>进入地图绘制</button>
          <label>上传 GeoJSON<input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void readCustomAoiFile(file).then((geometry) => {
              setAoiImportError((current) => { const next = { ...current }; delete next[task.taskId]; return next; });
              const normalized = task.aoiType === "multi" ? asMultiPolygon(geometry) : geometry;
              onUpdate(task.taskId, { aoiType: task.aoiType === "multi" ? "multi" : normalized.type === "Polygon" ? "polygon" : "multi", customGeometry: normalized });
            }).catch((error) => setAoiImportError((current) => ({ ...current, [task.taskId]: error instanceof Error ? error.message : "GeoJSON 导入失败" })));
          }} /></label>
          <span>{task.customGeometry ? `${task.customGeometry.type} · ${customAoiPartCount(task.customGeometry)} 块` : "尚未绘制或导入边界"}</span>
          {aoiImportError[task.taskId] ? <small role="alert">{aoiImportError[task.taskId]}</small> : null}
        </div> : null}
        <div className="payload-planning">
          <fieldset className="payload-options"><legend>载荷类型（可多选）</legend>{payloadOptions.map((payload) => {
            const checked = task.sensors.includes(payload);
            const inputId = `${task.taskId}-payload-${payload}`;
            return <label key={payload} htmlFor={inputId}><input id={inputId} type="checkbox" checked={checked} onChange={() => onUpdate(task.taskId, {
              sensors: toggleValue(task.sensors, payload),
              ...(payload === "SAR" ? { sarImagingModes: checked ? [] : sarModeChoices.map((mode) => mode.id) } : {}),
            })} /><span>{payload}<small>{payload === "光学" ? "云量约束参与窗口筛选；真实卫星与相机参数待配置" : "使用当前登记的 CSAR / XSAR 星座参数试算"}</small></span></label>;
          })}</fieldset>
          {task.sensors.includes("SAR") ? <fieldset className="sar-mode-options"><legend>SAR 成像方式（可多选）</legend>{sarModeChoices.map((mode) => {
            const checked = task.sarImagingModes.includes(mode.id);
            const inputId = `${task.taskId}-sar-mode-${mode.id}`;
            return <label key={mode.id} htmlFor={inputId}><input id={inputId} type="checkbox" checked={checked} disabled={checked && task.sarImagingModes.length === 1} onChange={() => onUpdate(task.taskId, { sarImagingModes: toggleValue(task.sarImagingModes, mode.id) as SarImagingModeId[] })} /><span>{mode.label}<small>{mode.summary}</small></span></label>;
          })}<p>至少保留一种模式；修改模式会清除已选机会并重新计算覆盖结果。</p></fieldset> : null}
        </div>
        <div className="task-fields">
          {task.hazard === "cyclone" && task.timeIndexedAoi?.length ? <label>台风动态跟踪目标<select value={task.cycloneTrackingTarget ?? "center"} onChange={(event) => onUpdate(task.taskId, { cycloneTrackingTarget: event.target.value as CycloneTrackingTarget })}><option value="center">预测中心（推荐）</option><option value="wind_field">逐时风圈范围</option><option value="uncertainty_area">逐时路径不确定区</option></select><small>预测中心适合连续路径跟踪；风圈和不确定区可能大于单景幅宽。</small></label> : null}
          {task.aoiType === "point" ? <label>点目标缓冲（公里，可为0）<input type="number" min="0" max="100" value={task.aoiRadiusKm} onChange={(event) => onUpdate(task.taskId, { aoiRadiusKm: clampNumber(event.target.value, 0, 100) })} /></label> : null}
          {task.aoiType === "circle" ? <label>圆形面半径（公里）<input type="number" min="1" max="1000" value={task.aoiRadiusKm} onChange={(event) => onUpdate(task.taskId, { aoiRadiusKm: clampNumber(event.target.value, 1, 1000) })} /></label> : null}
          {task.aoiType === "rectangle" ? <><label>矩形宽度（公里）<input type="number" min="1" max="2000" value={task.aoiWidthKm} onChange={(event) => onUpdate(task.taskId, { aoiWidthKm: clampNumber(event.target.value, 1, 2000) })} /></label><label>矩形高度（公里）<input type="number" min="1" max="2000" value={task.aoiHeightKm} onChange={(event) => onUpdate(task.taskId, { aoiHeightKm: clampNumber(event.target.value, 1, 2000) })} /></label></> : null}
          {task.aoiType === "corridor" ? <><label>走廊长度（公里）<input type="number" min="1" max="3000" value={task.aoiLengthKm} onChange={(event) => onUpdate(task.taskId, { aoiLengthKm: clampNumber(event.target.value, 1, 3000) })} /></label><label>走廊宽度（公里）<input type="number" min="1" max="500" value={task.aoiWidthKm} onChange={(event) => onUpdate(task.taskId, { aoiWidthKm: clampNumber(event.target.value, 1, 500) })} /></label><label>方位角（度）<input type="number" min="0" max="359" value={task.aoiBearingDeg} onChange={(event) => onUpdate(task.taskId, { aoiBearingDeg: clampNumber(event.target.value, 0, 359) })} /></label></> : null}
          <label>最早成像（Asia/Shanghai UTC+08）<input type="datetime-local" value={toLocalInput(task.imagingStart)} onChange={(event) => onUpdate(task.taskId, { imagingStart: fromLocalInput(event.target.value) })} /></label>
          <label>最晚成像（Asia/Shanghai UTC+08）<input type="datetime-local" min={toLocalInput(task.imagingStart)} value={toLocalInput(task.imagingEnd)} onChange={(event) => onUpdate(task.taskId, { imagingEnd: fromLocalInput(event.target.value) })} /></label>
          <label>规划状态<select value={task.status} disabled={!['candidate', 'reviewed'].includes(task.status)} onChange={(event) => onUpdate(task.taskId, { status: event.target.value as SatelliteTask["status"] })}>{allowedOperatorTaskStatuses(task.status).map((status) => <option key={status} value={status}>{taskStatusLabel(status)}</option>)}</select><small>排程、下发、成像和完成状态只能由仿真或执行回执产生</small></label>
          <label>最低覆盖率（%）<input type="number" min="1" max="100" value={task.minimumCoveragePercent} onChange={(event) => onUpdate(task.taskId, { minimumCoveragePercent: clampNumber(event.target.value, 1, 100) })} /></label>
          {task.sensors.includes("光学") ? <label>最大云量（%）<input type="number" min="0" max="100" value={task.maximumCloudPercent} onChange={(event) => onUpdate(task.taskId, { maximumCloudPercent: clampNumber(event.target.value, 0, 100) })} /></label> : null}
          <label>目标分辨率（米）<input type="number" min="0.1" max="10000" step="0.1" value={task.spatialResolutionMeters} onChange={(event) => onUpdate(task.taskId, { spatialResolutionMeters: clampNumber(event.target.value, 0.1, 10000) })} /></label>
          {task.sensors.includes("SAR") ? <><label>最小入射角（度）<input type="number" min="0" max="80" value={task.incidenceAngleMinDeg} onChange={(event) => onUpdate(task.taskId, { incidenceAngleMinDeg: clampNumber(event.target.value, 0, 80) })} /></label><label>最大入射角（度）<input type="number" min="0" max="80" value={task.incidenceAngleMaxDeg} onChange={(event) => onUpdate(task.taskId, { incidenceAngleMaxDeg: clampNumber(event.target.value, 0, 80) })} /></label></> : null}
          <label>重访次数<input type="number" min="1" max="50" value={task.revisitCount} onChange={(event) => onUpdate(task.taskId, { revisitCount: clampNumber(event.target.value, 1, 50) })} /></label>
          <label>最迟交付（Asia/Shanghai UTC+08）<input type="datetime-local" min={toLocalInput(task.imagingEnd)} value={toLocalInput(task.deliveryDeadline)} onChange={(event) => onUpdate(task.taskId, { deliveryDeadline: fromLocalInput(event.target.value) })} /></label>
          {task.hazard === "landslide" ? <><label>SAR 轨向偏好<select value={task.orbitDirectionPreference ?? "either"} onChange={(event) => onUpdate(task.taskId, { orbitDirectionPreference: event.target.value as SatelliteTask["orbitDirectionPreference"] })}><option value="ascending">升轨</option><option value="descending">降轨</option><option value="either">任一轨向</option></select></label><label>SAR 分析模式<select value={task.sarAnalysisMode ?? "amplitude_change_and_insar_pair"} onChange={(event) => onUpdate(task.taskId, { sarAnalysisMode: event.target.value as SatelliteTask["sarAnalysisMode"] })}><option value="amplitude_change_and_insar_pair">幅度变化 + InSAR 对比</option><option value="amplitude_change">幅度变化</option><option value="insar_pair">InSAR 配对</option></select></label><label className="task-checkbox-field"><input type="checkbox" checked={Boolean(task.referenceAcquisitionRequired)} onChange={(event) => onUpdate(task.taskId, { referenceAcquisitionRequired: event.target.checked })} />要求灾前参考影像</label></> : null}
        </div>
        <div className="task-targets">观测目标：{task.observationTargets.join(" · ")}</div>
        {(() => { const validation = validateSatelliteTask(task as unknown as Record<string, unknown>, { requireApproved: true, requirePayload: true, requireProvenance: true }); return validation.ok ? null : <div className="task-validation" role="alert"><strong>还不能计算卫星机会</strong><ul>{validation.errors.map((error) => <li key={error}>{humanizeTaskValidationError(error)}</li>)}</ul></div>; })()}
        <div className={`visibility-box ${visibility[task.taskId]?.state ?? "idle"}`}>
          {(() => { const ready = validateSatelliteTask(task as unknown as Record<string, unknown>, { requireApproved: true, requirePayload: true, requireProvenance: true }).ok; return <button onClick={() => void calculateVisibility(task)} disabled={visibility[task.taskId]?.state === "loading" || !ready || fleet.current === 0}>{visibility[task.taskId]?.state === "loading" ? "正在计算轨道机会…" : fleet.current === 0 ? "暂无可用轨道，暂不能计算" : !ready ? "请先完成上方必填项" : task.hazard === "cyclone" && task.timeIndexedAoi?.length ? "计算台风动态跟踪机会" : "计算卫星任务机会"}</button>; })()}
          {visibility[task.taskId]?.message ? <p>{visibility[task.taskId].message}</p> : null}
          {visibility[task.taskId]?.planningSummary ? <p className="planning-summary">规划约束：{visibility[task.taskId].planningSummary!.eligible + visibility[task.taskId].planningSummary!.conditional} 个可进入试排 · {visibility[task.taskId].planningSummary!.conditional} 个待补工程约束 · {visibility[task.taskId].planningSummary!.dispatchable} 个可进入下发复核</p> : null}
          {task.opportunityId ? <p className="selected-opportunity">已选机会：{task.satelliteId} · {task.opportunityId} · {task.simulationLevel === "orbit_only" ? `轨道级粗筛${task.minimumGroundTrackDistanceKm == null ? "" : ` · 最近 ${task.minimumGroundTrackDistanceKm} km`}` : task.simulationLevel === "assumed_sensor" ? "假设传感器试算" : "传感器级仿真"}</p> : null}
          {visibility[task.taskId]?.windows.map((window, windowIndex) => <div key={window.opportunityId || `${window.start}-${windowIndex}`}>
            <strong>{window.satelliteLabel || window.satelliteId || `窗口 ${windowIndex + 1}`}{window.simulationLevel === "orbit_only" ? " · 轨道近接候选" : window.simulationLevel === "assumed_sensor" ? ` · ${window.imagingMode ?? "假设传感器"}` : ""}</strong>
            <span>{formatTimeWithYear(window.start)} — {formatTimeWithYear(window.end)} UTC+08</span>
            {window.trackingMode === "forecast_time_indexed" ? <small className="cyclone-opportunity-time">台风 +{window.trackingLeadHours}h · {window.trackingTarget === "center" ? "预测中心" : window.trackingTarget === "wind_field" ? `${window.trackingThresholdKnots ?? "最低阈值"} kt 风圈` : "路径不确定区"} · 预测片 {formatTimeWithYear(window.trackingValidFrom!)}—{formatTimeWithYear(window.trackingValidTo!)} UTC+08 · 中心 {window.trackingCenter?.latitude.toFixed(3)}°, {window.trackingCenter?.longitude.toFixed(3)}°</small> : null}
            {window.closestApproachAt ? <small>最近近接 {formatTimeWithYear(window.closestApproachAt)} UTC+08 · 地面轨迹距 AOI 中心 {window.minimumGroundTrackDistanceKm ?? "--"} km · 高度 {window.altitudeKm ?? "--"} km</small> : null}
            <small>{window.coveragePercent == null ? (window.simulationLevel === "orbit_only" ? "真实覆盖率未计算" : "覆盖率待仿真服务返回") : `覆盖 ${window.coveragePercent}%`}{window.incidenceAngleDeg == null ? (window.simulationLevel === "orbit_only" ? " · 地面入射角未计算" : " · 入射角待验证") : ` · 地面入射角 ${window.incidenceAngleDeg}°`}{window.offNadirAngleDeg == null ? "" : ` · 离轴 ${window.offNadirAngleDeg}°`}{window.lookSide ? ` · ${window.lookSide === "left" ? "左视" : "右视"}` : ""}{window.orbitDirection ? ` · ${window.orbitDirection === "ascending" ? "升轨" : "降轨"}` : ""}</small>
            {window.spatialResolutionM != null ? <small>标称分辨率 {window.spatialResolutionLabel ?? `${window.spatialResolutionM} m`} · 标称场景 {window.nominalSceneCrossTrackKm}×{window.nominalSceneAlongTrackKm} km · 极化 {window.polarizations?.join("/") || "待提供"} · {window.parameterStatus === "provisional_assumption" ? "临时假设参数" : "用户提供参数"}</small> : null}
            {window.productLevels?.length ? <small>可选产品：{window.productLevels.map((product) => `${product.level} ${product.code}`).join(" / ")}</small> : null}
            {window.constraintAssessment ? <small className={`planning-decision ${window.constraintAssessment.decision}`}><b>{window.constraintAssessment.decision === "eligible" ? "约束已满足" : window.constraintAssessment.decision === "conditional" ? "可试排 · 待补工程约束" : "不满足规划约束"}</b>{window.constraintAssessment.findings.length ? ` · ${window.constraintAssessment.findings.slice(0, 2).map((finding) => finding.message).join("；")}${window.constraintAssessment.findings.length > 2 ? `；另 ${window.constraintAssessment.findings.length - 2} 项` : ""}` : " · 当前已登记约束均通过"}</small> : null}
            {window.constraintNotes?.map((note) => <small className="constraint-note" key={note}>{note}</small>)}
            {window.constraintAssessment?.eligibleForTrialSchedule && visibility[task.taskId]?.planningProblem ? (() => {
              const reference = schedulingOpportunityRef(visibility[task.taskId].planningProblem!.problemId, window.opportunityId);
              const locked = manualRules.lockedOpportunityRefs.includes(reference);
              const excluded = manualRules.excludedOpportunityRefs.includes(reference);
              return <div className="opportunity-manual-actions"><button className={locked ? "active lock" : ""} aria-pressed={locked} onClick={() => setOpportunityRule(reference, "lock")}>{locked ? "已锁定" : "锁定机会"}</button><button className={excluded ? "active exclude" : ""} aria-pressed={excluded} onClick={() => setOpportunityRule(reference, "exclude")}>{excluded ? "已排除" : "排除机会"}</button></div>;
            })() : null}
            <button className="choose-opportunity" onClick={() => {
              onUpdate(task.taskId, {
              satelliteId: window.satelliteId, instrumentId: window.instrumentId, imagingMode: window.imagingMode,
              opportunityId: window.opportunityId, orbitVersion: window.orbitVersion, visibilityComputedAt: window.computedAt,
              incidenceAngleDeg: window.incidenceAngleDeg, offNadirAngleDeg: window.offNadirAngleDeg,
              opportunityLookSide: window.lookSide, opportunityCoveragePercent: window.coveragePercent,
              opportunitySpatialResolutionM: window.spatialResolutionM, opportunitySceneCrossTrackKm: window.nominalSceneCrossTrackKm,
              opportunitySceneAlongTrackKm: window.nominalSceneAlongTrackKm, sensorParameterStatus: window.parameterStatus,
              opportunityFootprint: window.footprintGeometry, simulationLevel: window.simulationLevel ?? "sensor_model",
              satelliteNoradId: window.satelliteNoradId, closestApproachAt: window.closestApproachAt,
              closestSubpointLatitude: window.closestSubpoint?.latitude, closestSubpointLongitude: window.closestSubpoint?.longitude,
              minimumGroundTrackDistanceKm: window.minimumGroundTrackDistanceKm, orbitSearchRadiusKm: window.searchRadiusKm,
              opportunityOrbitDirection: window.orbitDirection, trackingValidFrom: window.trackingValidFrom,
              trackingValidTo: window.trackingValidTo, trackingLeadHours: window.trackingLeadHours,
              trackingCenterLatitude: window.trackingCenter?.latitude, trackingCenterLongitude: window.trackingCenter?.longitude,
              trackingCenterBasis: window.trackingCenterBasis, trackingThresholdKnots: window.trackingThresholdKnots,
              });
              onActivate(task.taskId);
            }}>{task.opportunityId === window.opportunityId ? "已选择 · 查看拍摄位置" : window.simulationLevel === "orbit_only" ? "选择并查看轨道粗筛位置" : window.simulationLevel === "assumed_sensor" ? "选择并查看试算位置" : "选择并在地图查看"}</button>
          </div>)}
        </div>
        {expandedTaskIds.has(task.taskId) ? <MissionLifecyclePanel task={task} enabled={storageMode === "operational-database" && syncState[task.taskId]?.state === "synced"} /> : null}
      </article>)}
    </div>
    <footer>导出字段包括灾害发生时间、任务时间窗、WGS 84坐标、多类型AOI、台风官方路径/风圈、载荷与 SAR 成像方式、目标、优先级与权威来源。</footer>
  </aside>;
}

type MissionLifecycleState = {
  state: "idle" | "loading" | "ready" | "saving" | "error";
  receipts: MissionExecutionReceipt[];
  products: ObservationProduct[];
  packages: AoiWorkPackage[];
  message?: string;
};

function MissionLifecyclePanel({ task, enabled }: { task: SatelliteTask; enabled: boolean }) {
  const defaultWidth = Math.max(1, Math.round(task.opportunitySceneCrossTrackKm ?? 25));
  const defaultHeight = Math.max(1, Math.round(task.opportunitySceneAlongTrackKm ?? defaultWidth));
  const [widthKm, setWidthKm] = useState(defaultWidth);
  const [heightKm, setHeightKm] = useState(defaultHeight);
  const [reviewNote, setReviewNote] = useState("");
  const [state, setState] = useState<MissionLifecycleState>({ state: "idle", receipts: [], products: [], packages: [] });

  const load = useCallback(async () => {
    if (!enabled) return;
    setState((current) => ({ ...current, state: "loading", message: undefined }));
    try {
      const taskId = encodeURIComponent(task.taskId);
      const [receiptResponse, productResponse, packageResponse] = await Promise.all([
        fetch(`/api/execution/receipts?taskId=${taskId}`, { cache: "no-store" }),
        fetch(`/api/products?taskId=${taskId}`, { cache: "no-store" }),
        fetch(`/api/aoi-work-packages?taskId=${taskId}`, { cache: "no-store" }),
      ]);
      const [receiptResult, productResult, packageResult] = await Promise.all([
        receiptResponse.json() as Promise<{ receipts?: MissionExecutionReceipt[]; error?: string }>,
        productResponse.json() as Promise<{ products?: ObservationProduct[]; error?: string }>,
        packageResponse.json() as Promise<{ packages?: AoiWorkPackage[]; error?: string }>,
      ]);
      const failed = [[receiptResponse, receiptResult.error], [productResponse, productResult.error], [packageResponse, packageResult.error]].find(([response]) => !(response as Response).ok);
      if (failed) throw new Error(String(failed[1] || `闭环记录读取失败（HTTP ${(failed[0] as Response).status}）`));
      setState({ state: "ready", receipts: receiptResult.receipts ?? [], products: productResult.products ?? [], packages: packageResult.packages ?? [] });
    } catch (error) {
      setState((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "任务闭环记录读取失败" }));
    }
  }, [enabled, task.taskId]);

  useEffect(() => { void load(); }, [load]);

  const generate = async () => {
    setState((current) => ({ ...current, state: "saving", message: undefined }));
    try {
      const response = await fetch("/api/aoi-work-packages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", taskId: task.taskId, widthKm, heightKm, maximumPackages: 100 }) });
      const result = await response.json() as { packages?: AoiWorkPackage[]; error?: string };
      if (!response.ok) throw new Error(result.error || `AOI 分块失败（HTTP ${response.status}）`);
      setState((current) => ({ ...current, state: "ready", packages: result.packages ?? [], message: `已生成或复用 ${result.packages?.length ?? 0} 个覆盖复核分块` }));
    } catch (error) { setState((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "AOI 分块失败" })); }
  };

  const act = async (workPackage: AoiWorkPackage, action: AoiWorkPackageAction) => {
    setState((current) => ({ ...current, state: "saving", message: undefined }));
    try {
      const response = await fetch("/api/aoi-work-packages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId: workPackage.packageId, expectedRevision: workPackage.revision, action, note: action === "request_changes" ? reviewNote : "" }) });
      const result = await response.json() as { package?: AoiWorkPackage; error?: string };
      if (!response.ok || !result.package) throw new Error(result.error || `分块状态更新失败（HTTP ${response.status}）`);
      setState((current) => ({ ...current, state: "ready", packages: current.packages.map((item) => item.packageId === result.package!.packageId ? result.package! : item), message: "分块状态已更新" }));
      if (action === "request_changes") setReviewNote("");
    } catch (error) {
      setState((current) => ({ ...current, state: "error", message: error instanceof Error ? error.message : "分块状态更新失败" }));
      void load();
    }
  };

  const counts = Object.fromEntries(["open", "claimed", "submitted", "in_review", "changes_requested", "approved"].map((status) => [status, state.packages.filter((item) => item.status === status).length]));
  return <details className={`mission-lifecycle ${state.state}`} open={Boolean(state.receipts.length || state.products.length || state.packages.length)}>
    <summary><span>任务闭环与覆盖复核</span><b>{taskStatusLabel(task.status)}</b></summary>
    {!enabled ? <p>任务同步到业务数据库后，才能生成复核分块并读取执行回执与产品。</p> : <>
      <div className="mission-lifecycle-head"><span>执行回执 {state.receipts.length}</span><span>STAC 产品 {state.products.length}</span><span>AOI 分块 {state.packages.length}</span><button onClick={() => void load()} disabled={state.state === "loading" || state.state === "saving"}>刷新</button></div>
      <div className="aoi-work-generator"><label>横轨宽度 km<input type="number" min="1" max="1000" value={widthKm} onChange={(event) => setWidthKm(clampNumber(event.target.value, 1, 1000))} /></label><label>沿轨长度 km<input type="number" min="1" max="1000" value={heightKm} onChange={(event) => setHeightKm(clampNumber(event.target.value, 1, 1000))} /></label><button onClick={() => void generate()} disabled={state.state === "saving"}>按场景网格生成</button></div>
      <small>优先采用已选机会足迹；没有足迹时按任务 AOI 分块。领取人与复核人必须是不同账号。</small>
      {state.packages.length ? <div className="aoi-work-summary"><span>待领取 {counts.open ?? 0}</span><span>作业中 {(counts.claimed ?? 0) + (counts.changes_requested ?? 0)}</span><span>待复核 {(counts.submitted ?? 0) + (counts.in_review ?? 0)}</span><span>已通过 {counts.approved ?? 0}</span></div> : null}
      {state.packages.slice(0, 20).map((workPackage) => <div className={`aoi-work-row ${workPackage.status}`} key={workPackage.packageId}><div><b>{workPackage.title}</b><span>{aoiWorkStatusLabel(workPackage.status)} · v{workPackage.revision}</span>{workPackage.assignee ? <small>领取：{workPackage.assignee}{workPackage.reviewer ? ` · 复核：${workPackage.reviewer}` : ""}</small> : null}</div><div>{workPackage.status === "open" || workPackage.status === "changes_requested" ? <button onClick={() => void act(workPackage, "claim")}>领取</button> : null}{workPackage.status === "claimed" ? <><button onClick={() => void act(workPackage, "submit")}>提交复核</button><button onClick={() => void act(workPackage, "release")}>释放</button></> : null}{["submitted", "in_review"].includes(workPackage.status) ? <><button onClick={() => void act(workPackage, "approve")}>独立通过</button><button onClick={() => void act(workPackage, "request_changes")} disabled={reviewNote.trim().length < 3}>退回</button></> : null}</div></div>)}
      {state.packages.some((item) => ["submitted", "in_review"].includes(item.status)) ? <label className="aoi-review-note">退回原因（至少3字）<input value={reviewNote} maxLength={1000} onChange={(event) => setReviewNote(event.target.value)} /></label> : null}
      {state.receipts.slice(0, 6).map((receipt) => <div className="mission-record" key={receipt.receiptId}><b>{taskStatusLabel(receipt.fromStatus)} → {taskStatusLabel(receipt.toStatus)}</b><span>{receipt.provider} · {formatTimeWithYear(receipt.occurredAt)} UTC+08</span><small>{receipt.externalTaskId}</small></div>)}
      {state.products.slice(0, 6).map((product) => <div className="mission-record product" key={product.itemId}><b>{product.productLevel} · {productQualityLabel(product.qualityStatus)}</b><span>{formatTimeWithYear(product.acquiredAt)} UTC+08</span><small>{product.itemId} · STAC 1.0.0</small></div>)}
      {state.message ? <p role={state.state === "error" ? "alert" : "status"}>{state.message}</p> : null}
    </>}
  </details>;
}

function aoiWorkStatusLabel(status: AoiWorkPackage["status"]) { return ({ open: "待领取", claimed: "已领取", submitted: "待复核", in_review: "复核中", changes_requested: "退回修改", approved: "已通过", cancelled: "已取消" } as const)[status]; }
function productQualityLabel(status: ObservationProduct["qualityStatus"]) { return ({ pending: "待质检", passed: "质检通过", conditional: "有条件通过", rejected: "已驳回" } as const)[status]; }

function ScheduleTimeline({ schedule, onActivate }: { schedule: MultiTaskSchedule; onActivate: (taskId: string) => void }) {
  if (!schedule.assignments.length) return null;
  const bufferMs = schedule.transitionBufferSeconds * 1_000;
  const start = Math.min(...schedule.assignments.map((assignment) => Date.parse(assignment.start)));
  const end = Math.max(...schedule.assignments.map((assignment) => Date.parse(assignment.end) + bufferMs));
  const duration = Math.max(1, end - start);
  const satellites = [...new Set(schedule.assignments.map((assignment) => assignment.satelliteId))].sort();
  return <div className="schedule-timeline" aria-label="卫星排程时间轴">
    <div className="schedule-timeline-axis"><span>{formatTimeWithYear(new Date(start).toISOString())}</span><b>卫星时间轴 · 缓冲区以浅色显示</b><span>{formatTimeWithYear(new Date(end).toISOString())}</span></div>
    <div className="schedule-timeline-scroll"><div className="schedule-timeline-grid">{satellites.map((satellite) => <div className="schedule-timeline-row" key={satellite}><strong>{satellite}</strong><div>{schedule.assignments.filter((assignment) => assignment.satelliteId === satellite).map((assignment) => {
        const assignmentStart = Date.parse(assignment.start);
        const assignmentEnd = Date.parse(assignment.end);
        const left = ((assignmentStart - start) / duration) * 100;
        const width = Math.max(0.6, ((assignmentEnd - assignmentStart) / duration) * 100);
        const bufferedWidth = Math.max(width, ((assignmentEnd + bufferMs - assignmentStart) / duration) * 100);
        return <span className="schedule-timeline-slot" key={assignment.assignmentId}><i style={{ left: `${left}%`, width: `${bufferedWidth}%` }} /><button className={`${assignment.constraintDecision} ${assignment.manuallyLocked ? "locked" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={() => onActivate(assignment.taskId)} title={`${assignment.taskTitle} · ${formatTimeWithYear(assignment.start)} UTC+08`}>{assignment.taskTitle}</button></span>;
      })}</div></div>)}</div></div>
  </div>;
}

function PlanningScenarioDiff({ left, right }: { left: PlanningScenarioRecord; right: PlanningScenarioRecord }) {
  const leftSchedule = left.comparison.recommendedAlgorithm === "priority_greedy_v1" ? left.comparison.greedy : left.comparison.optimized;
  const rightSchedule = right.comparison.recommendedAlgorithm === "priority_greedy_v1" ? right.comparison.greedy : right.comparison.optimized;
  const leftAssignments = new Set(leftSchedule.assignments.map((assignment) => assignment.assignmentId));
  const rightAssignments = new Set(rightSchedule.assignments.map((assignment) => assignment.assignmentId));
  const added = rightSchedule.assignments.filter((assignment) => !leftAssignments.has(assignment.assignmentId));
  const removed = leftSchedule.assignments.filter((assignment) => !rightAssignments.has(assignment.assignmentId));
  const scoreDelta = rightSchedule.objectiveScore - leftSchedule.objectiveScore;
  return <div className="planning-version-diff">
    <strong>{left.name} v{left.version} → {right.name} v{right.version}</strong>
    <div><span>得分变化 <b>{scoreDelta >= 0 ? "+" : ""}{scoreDelta}</b></span><span>观测次数 <b>{rightSchedule.summary.assignmentCount - leftSchedule.summary.assignmentCount >= 0 ? "+" : ""}{rightSchedule.summary.assignmentCount - leftSchedule.summary.assignmentCount}</b></span><span>条件机会 <b>{rightSchedule.summary.conditionalAssignmentCount - leftSchedule.summary.conditionalAssignmentCount >= 0 ? "+" : ""}{rightSchedule.summary.conditionalAssignmentCount - leftSchedule.summary.conditionalAssignmentCount}</b></span></div>
    <p>新增 {added.length} 项：{added.slice(0, 4).map((assignment) => `${assignment.taskTitle}/${assignment.satelliteId}`).join("、") || "无"}</p>
    <p>移除 {removed.length} 项：{removed.slice(0, 4).map((assignment) => `${assignment.taskTitle}/${assignment.satelliteId}`).join("、") || "无"}</p>
  </div>;
}

function ObservationPolicy() {
  return <details className="window-policy">
    <summary>观测阶段规则 <span>黄金期 → 后续期 → 历史库</span></summary>
    <div>
      {Object.entries(observationWindowPolicy).map(([id, policy]) => (
        <p key={id}><b>{hazardMeta[id as HazardType].label}</b><span>{policy.label}</span><small>{policy.rationale}</small></p>
      ))}
      <em>表内为首次复核点 / 基准后续期。实况会结合严重度、长期变化目标和可持续复访载荷修正，并设置不可自动延长的强制复核点；预警和预报严格服从权威报次有效期，严重度不延长报文。</em>
    </div>
  </details>;
}

function LoadingList() {
  return <div className="loading-list" role="status" aria-live="polite" aria-label="正在加载灾害事件">{[1, 2, 3, 4].map((n) => <div key={n}><i /><span /><b /></div>)}</div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state" role="status" aria-live="polite"><div>◌</div><strong>{title}</strong><p>{detail}</p></div>;
}

function relativeTime(value: string) {
  const rawMinutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (rawMinutes < 0) {
    const future = Math.abs(rawMinutes);
    if (future < 60) return `${future}分钟后`;
    if (future < 1_440) return `${Math.ceil(future / 60)}小时后`;
    return `${Math.ceil(future / 1_440)}天后`;
  }
  const minutes = rawMinutes;
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1_440)}天前`;
}

function evidenceRoleLabel(role: DisasterEvent["evidence"][number]["role"]) {
  return { detection: "探测", warning: "预警", verification: "核验", driver: "驱动因子", context: "背景资料" }[role];
}

function observationDeadline(event: DisasterEvent) {
  if (event.observationPhase === "forecast") return event.validFrom ?? event.observationReviewAt;
  if (event.observationPhase === "golden") return event.observationReviewAt;
  return event.observationExpiresAt;
}

function observationDeadlineLabel(event: DisasterEvent) {
  if (event.observationPhase === "forecast") return "距预报生效";
  if (event.observationPhase === "golden") return "距建议复核";
  if (event.observationPhase === "archive") return "观测期已结束";
  return "后续观测剩余";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatTimeWithYear(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatCardTime(value: string) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "--";
  return `${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function remainingObservationTime(value: string) {
  const minutes = Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 48 * 60) return `${Math.ceil(minutes / 60)}小时`;
  return `${Math.ceil(minutes / 1_440)}天`;
}

function humanizeTaskValidationError(error: string) {
  if (/尚未通过 AOI 审批|AOI 审批状态/.test(error)) return "请先在地图核对范围，然后点击“确认当前 AOI”。";
  if (/载荷|sensors|SAR 分析模式/.test(error)) return "请至少选择一种载荷；选择 SAR 后还需保留一种成像方式。";
  if (/事件版本指纹|AOI 指纹|revision/.test(error)) return "任务版本信息尚未同步，请先点击“重试同步”。";
  if (/成像窗口|imaging/.test(error)) return "请检查最早、最晚成像时间，确保时间顺序正确且仍在灾害观测期内。";
  if (/交付期限/.test(error)) return "最迟交付时间不能早于成像窗口结束。";
  if (/入射角/.test(error)) return "请检查 SAR 入射角范围，最大值不能小于最小值。";
  if (/AOI 参数|来源几何|自定义/.test(error)) return "当前观测范围不完整，请重新绘制、导入或选择有效的 AOI。";
  if (/台风/.test(error)) return `台风动态目标需要更新：${error}`;
  return error.replace(/revision/gi, "任务版本").replace(/AOI/g, "观测范围（AOI）");
}

function opportunityReferenceBelongsToTask(reference: string, taskIds: Set<string>) {
  try {
    const [problemId] = JSON.parse(reference) as [string];
    return [...taskIds].some((taskId) => problemId === taskId || problemId.startsWith(`${taskId}:`));
  } catch {
    return false;
  }
}

function removeTaskRules(rules: SchedulingManualRules, taskIds: Set<string>): SchedulingManualRules {
  return {
    lockedOpportunityRefs: rules.lockedOpportunityRefs.filter((reference) => !opportunityReferenceBelongsToTask(reference, taskIds)),
    excludedOpportunityRefs: rules.excludedOpportunityRefs.filter((reference) => !opportunityReferenceBelongsToTask(reference, taskIds)),
    forcedSatelliteByTask: Object.fromEntries(Object.entries(rules.forcedSatelliteByTask).filter(([taskId]) => !taskIds.has(taskId))),
    forcedImagingModeByTask: Object.fromEntries(Object.entries(rules.forcedImagingModeByTask).filter(([taskId]) => !taskIds.has(taskId))),
  };
}

function scheduleReferencesAnyTask(state: JointSchedulingState, taskIds: Set<string>) {
  if (!state.comparison) return false;
  const schedules = [state.comparison.greedy, state.comparison.optimized];
  return schedules.some((schedule) => schedule.assignments.some((assignment) => taskIds.has(assignment.taskId))
    || schedule.unassigned.some((entry) => taskIds.has(entry.taskId)));
}

function planningScenarioReferencesAnyTask(scenario: PlanningScenarioRecord, taskIds: Set<string>) {
  return scenario.problemIds.some((problemId) => [...taskIds].some((taskId) => problemId === taskId || problemId.startsWith(`${taskId}:`)));
}

function createSatelliteTask(event: DisasterEvent, operatorConfirmed: boolean): SatelliteTask {
  const now = Date.now();
  const forecastEnd = event.cycloneForecast ? Date.parse(event.cycloneForecast.forecastValidUntil) : Number.POSITIVE_INFINITY;
  const cycloneForecastUsable = !event.cycloneForecast || forecastEnd > now + 3_600_000;
  const sourceVerified = event.dispatchEligibility === "ready" && cycloneForecastUsable;
  const requestedStart = event.phenomenonStage === "forecast" || event.phenomenonStage === "warning"
    ? Math.max(now, Date.parse(event.validFrom ?? event.issuedAt))
    : now;
  const phaseEnd = new Date(event.observationPhase === "golden" ? event.observationReviewAt : event.observationExpiresAt).getTime();
  const preferredEnd = Math.min(phaseEnd, cycloneForecastUsable ? forecastEnd : Number.POSITIVE_INFINITY, requestedStart + (event.observationPhase === "golden" ? 72 : 168) * 3_600_000);
  if (!Number.isFinite(requestedStart) || preferredEnd <= requestedStart) throw new Error("当前权威有效期不足以建立至少一小时的成像窗口");
  const officialImpactGeometry = cycloneForecastUsable ? event.cycloneForecast?.impactGeometry : undefined;
  const sourceGeometry = officialImpactGeometry ?? event.geometry;
  const task: SatelliteTask = {
    taskId: `TASK-${event.id}-${now}`,
    eventId: event.id,
    masterEventId: event.masterEventId,
    entityKey: event.entityKey,
    title: event.title,
    hazard: event.hazard,
    priority: event.priority,
    latitude: event.latitude,
    longitude: event.longitude,
    eventOccurredAt: event.occurredAt,
    eventUpdatedAt: event.updatedAt,
    eventIssuedAt: event.issuedAt,
    eventValidFrom: event.validFrom,
    eventValidTo: event.validTo,
    phenomenonStage: event.phenomenonStage,
    aoiType: sourceVerified || officialImpactGeometry || (!event.cycloneForecast && event.geometryType !== "Point") ? "source" : "circle",
    aoiRadiusKm: defaultAoiRadiusKm[event.hazard],
    aoiWidthKm: Math.max(10, defaultAoiRadiusKm[event.hazard] * 2),
    aoiHeightKm: Math.max(10, defaultAoiRadiusKm[event.hazard] * 2),
    aoiLengthKm: Math.max(20, defaultAoiRadiusKm[event.hazard] * 3),
    aoiBearingDeg: 0,
    sourceGeometry,
    cycloneForecast: event.cycloneForecast,
    cycloneTrackingTarget: event.cycloneForecast?.impactField ? "center" : undefined,
    minimumCoveragePercent: 80,
    maximumCloudPercent: 30,
    spatialResolutionMeters: 10,
    incidenceAngleMinDeg: 20,
    incidenceAngleMaxDeg: 45,
    revisitCount: 1,
    imagingStart: new Date(requestedStart).toISOString(),
    imagingEnd: new Date(preferredEnd).toISOString(),
    deliveryDeadline: new Date(Math.max(requestedStart + 7_200_000, preferredEnd + 24 * 3_600_000)).toISOString(),
    sensors: [],
    sarImagingModes: [],
    observationTargets: event.observationTargets,
    observationPhase: event.observationPhase,
    source: event.source,
    sourceUrl: event.sourceUrl,
    locationQuality: event.locationQuality,
    locationAccuracyKm: event.locationAccuracyKm,
    evidenceCount: event.evidenceCount,
    aoiApproval: sourceVerified ? "source_verified" : operatorConfirmed ? "operator_confirmed" : "review_required",
    approvedAt: sourceVerified || operatorConfirmed ? new Date(now).toISOString() : undefined,
    approvedBy: sourceVerified ? event.source : operatorConfirmed ? "当前操作员" : undefined,
    approvalReason: sourceVerified ? undefined : operatorConfirmed ? "已在事件详情地图核对来源几何、位置误差和观测目标" : undefined,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    status: "candidate",
    revision: 0,
    eventRevision: eventRevisionFingerprint(event),
    aoiHash: "",
  };
  const timeIndexedAoi = cycloneTaskAoiSlices(event.cycloneForecast, task.imagingStart, task.imagingEnd);
  task.timeIndexedAoi = timeIndexedAoi.length ? timeIndexedAoi : undefined;
  task.forecastAdvisoryId = event.cycloneForecast ? `${event.cycloneForecast.source}:${event.cycloneForecast.advisory ?? event.cycloneForecast.issuedAt}` : undefined;
  task.forecastIssuedAt = event.cycloneForecast?.issuedAt;
  task.forecastValidUntil = event.cycloneForecast?.forecastValidUntil;
  return { ...task, aoiHash: aoiFingerprint(taskGeometry(task)) };
}

function createLandslideSarTasks(event: DisasterEvent, terrain: LandslideTerrainScreening): SatelliteTask[] {
  if (event.hazard !== "landslide") throw new Error("只有滑坡事件可以建立滑坡 SAR 模板");
  return landslideSarTemplates.map((template, index) => createLandslideSarTask(event, terrain, template, index));
}

function createLandslideSarTask(event: DisasterEvent, terrain: LandslideTerrainScreening, template: LandslideSarTemplate, index: number): SatelliteTask {
  const base = createSatelliteTask(event, true);
  const createdAt = new Date(Date.now() + index).toISOString();
  const task: SatelliteTask = {
    ...base,
    taskId: `TASK-${event.id}-LANDSLIDE-${template.orbitDirectionPreference.toUpperCase()}-${Date.now()}-${index}`,
    title: `${event.title} · ${template.label}`,
    aoiType: "multi",
    customGeometry: terrain.geometry,
    sensors: [...template.sensors],
    sarImagingModes: sarModeChoices.map((mode) => mode.id),
    observationTargets: [...template.observationTargets],
    minimumCoveragePercent: 90,
    maximumCloudPercent: 100,
    spatialResolutionMeters: template.spatialResolutionMeters,
    incidenceAngleMinDeg: template.incidenceAngleMinDeg,
    incidenceAngleMaxDeg: template.incidenceAngleMaxDeg,
    revisitCount: template.revisitCount,
    aoiApproval: "operator_confirmed",
    approvedAt: createdAt,
    approvedBy: "当前操作员",
    approvalReason: `操作员核对 ${terrain.provider} 地形筛查格网；该 AOI 仅为任务候选，不作为滑坡实况边界。${template.note}`,
    orbitDirectionPreference: template.orbitDirectionPreference,
    referenceAcquisitionRequired: template.referenceAcquisitionRequired,
    sarAnalysisMode: template.sarAnalysisMode,
    createdAt,
    updatedAt: createdAt,
  };
  return { ...task, aoiHash: aoiFingerprint(taskGeometry(task)) };
}

function downloadTaskArtifact(blob: Blob, contentDisposition: string | null, format: ExportFormat) {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  const fileName = match?.[1] ?? `tianxun-task-package-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "geojson" ? "geojson" : format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadJsonArtifact(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function migrateSatelliteTask(task: Partial<SatelliteTask>): SatelliteTask {
  const hazard = task.hazard ?? "earthquake";
  const radius = task.aoiRadiusKm ?? defaultAoiRadiusKm[hazard];
  const now = new Date().toISOString();
  const sensors = normalizeTaskSensors(task.sensors);
  const sarImagingModes = sensors.includes("SAR") ? normalizeSarImagingModes(task.sarImagingModes) : [];
  return {
    taskId: task.taskId ?? `TASK-MIGRATED-${Date.now()}`,
    eventId: task.eventId ?? "unknown-event",
    masterEventId: task.masterEventId ?? task.eventId ?? "unknown-event",
    entityKey: task.entityKey ?? inferLegacyTaskEntityKey(task),
    title: task.title ?? "未命名灾害任务",
    hazard,
    priority: task.priority ?? 0,
    latitude: task.latitude ?? 0,
    longitude: task.longitude ?? 0,
    eventOccurredAt: task.eventOccurredAt ?? task.createdAt ?? now,
    eventUpdatedAt: task.eventUpdatedAt ?? task.eventOccurredAt ?? task.createdAt ?? now,
    eventIssuedAt: task.eventIssuedAt ?? task.eventUpdatedAt ?? task.eventOccurredAt ?? task.createdAt ?? now,
    eventValidFrom: task.eventValidFrom,
    eventValidTo: task.eventValidTo,
    phenomenonStage: task.phenomenonStage ?? "observed",
    aoiType: task.aoiType ?? "circle",
    aoiRadiusKm: radius,
    aoiWidthKm: task.aoiWidthKm ?? Math.max(10, radius * 2),
    aoiHeightKm: task.aoiHeightKm ?? Math.max(10, radius * 2),
    aoiLengthKm: task.aoiLengthKm ?? Math.max(20, radius * 3),
    aoiBearingDeg: task.aoiBearingDeg ?? 0,
    sourceGeometry: task.sourceGeometry,
    customGeometry: task.customGeometry,
    cycloneForecast: task.cycloneForecast,
    timeIndexedAoi: task.timeIndexedAoi,
    forecastAdvisoryId: task.forecastAdvisoryId,
    forecastIssuedAt: task.forecastIssuedAt,
    forecastValidUntil: task.forecastValidUntil,
    cycloneTrackingTarget: task.cycloneTrackingTarget ?? (hazard === "cyclone" && task.cycloneForecast?.impactField ? "center" : undefined),
    trackingValidFrom: task.trackingValidFrom,
    trackingValidTo: task.trackingValidTo,
    trackingLeadHours: task.trackingLeadHours,
    trackingCenterLatitude: task.trackingCenterLatitude,
    trackingCenterLongitude: task.trackingCenterLongitude,
    trackingCenterBasis: task.trackingCenterBasis,
    trackingThresholdKnots: task.trackingThresholdKnots,
    minimumCoveragePercent: task.minimumCoveragePercent ?? 80,
    maximumCloudPercent: task.maximumCloudPercent ?? 30,
    spatialResolutionMeters: task.spatialResolutionMeters ?? 10,
    incidenceAngleMinDeg: task.incidenceAngleMinDeg ?? 20,
    incidenceAngleMaxDeg: task.incidenceAngleMaxDeg ?? 45,
    revisitCount: task.revisitCount ?? 1,
    imagingStart: task.imagingStart ?? now,
    imagingEnd: task.imagingEnd ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
    deliveryDeadline: task.deliveryDeadline ?? new Date(Date.now() + 48 * 3_600_000).toISOString(),
    sensors,
    sarImagingModes,
    observationTargets: task.observationTargets ?? [],
    observationPhase: task.observationPhase ?? "golden",
    source: task.source ?? "未知来源",
    sourceUrl: task.sourceUrl ?? "#",
    locationQuality: task.locationQuality ?? "unknown",
    locationAccuracyKm: task.locationAccuracyKm ?? 100,
    evidenceCount: task.evidenceCount ?? 1,
    aoiApproval: task.aoiApproval ?? "review_required",
    approvedAt: task.approvedAt,
    approvedBy: task.approvedBy,
    createdAt: task.createdAt ?? now,
    updatedAt: task.updatedAt ?? task.createdAt ?? now,
    status: task.status ?? "candidate",
    revision: Number.isInteger(task.revision) && Number(task.revision) >= 0 ? Number(task.revision) : 0,
    eventRevision: /^[a-f0-9]{64}$/.test(task.eventRevision ?? "") ? task.eventRevision! : "0".repeat(64),
    aoiHash: /^[a-f0-9]{64}$/.test(task.aoiHash ?? "") ? task.aoiHash! : "0".repeat(64),
    approvalReason: task.approvalReason,
    satelliteId: task.satelliteId,
    instrumentId: task.instrumentId,
    imagingMode: task.imagingMode,
    opportunityId: task.opportunityId,
    orbitVersion: task.orbitVersion,
    visibilityComputedAt: task.visibilityComputedAt,
    incidenceAngleDeg: task.incidenceAngleDeg,
    offNadirAngleDeg: task.offNadirAngleDeg,
    opportunityLookSide: task.opportunityLookSide,
    opportunityCoveragePercent: task.opportunityCoveragePercent,
    opportunitySpatialResolutionM: task.opportunitySpatialResolutionM,
    opportunitySceneCrossTrackKm: task.opportunitySceneCrossTrackKm,
    opportunitySceneAlongTrackKm: task.opportunitySceneAlongTrackKm,
    sensorParameterStatus: task.sensorParameterStatus,
    opportunityFootprint: task.opportunityFootprint,
    simulationLevel: task.simulationLevel,
    satelliteNoradId: task.satelliteNoradId,
    closestApproachAt: task.closestApproachAt,
    closestSubpointLatitude: task.closestSubpointLatitude,
    closestSubpointLongitude: task.closestSubpointLongitude,
    minimumGroundTrackDistanceKm: task.minimumGroundTrackDistanceKm,
    orbitSearchRadiusKm: task.orbitSearchRadiusKm,
    opportunityOrbitDirection: task.opportunityOrbitDirection,
    orbitDirectionPreference: task.orbitDirectionPreference,
    referenceAcquisitionRequired: task.referenceAcquisitionRequired,
    sarAnalysisMode: task.sarAnalysisMode,
  };
}

function rebaseUnsyncedDraft(task: SatelliteTask, event: DisasterEvent): SatelliteTask {
  const fresh = createSatelliteTask(event, true);
  const now = Date.now();
  const preservedStart = Date.parse(task.imagingStart) > now ? task.imagingStart : fresh.imagingStart;
  const maximumEnd = Math.min(
    Date.parse(event.observationExpiresAt),
    task.aoiType === "source" && event.cycloneForecast ? Date.parse(event.cycloneForecast.forecastValidUntil) : Number.POSITIVE_INFINITY,
  );
  const requestedEnd = Date.parse(task.imagingEnd);
  const cappedRequestedEnd = Math.min(requestedEnd, maximumEnd);
  const imagingEnd = Number.isFinite(cappedRequestedEnd) && cappedRequestedEnd > Date.parse(preservedStart) + 3_600_000
    ? new Date(cappedRequestedEnd).toISOString() : fresh.imagingEnd;
  const deliveryDeadline = Date.parse(task.deliveryDeadline) >= Date.parse(imagingEnd)
    ? task.deliveryDeadline
    : new Date(Date.parse(imagingEnd) + 24 * 3_600_000).toISOString();
  const rebased: SatelliteTask = {
    ...fresh,
    taskId: task.taskId,
    createdAt: task.createdAt,
    aoiType: task.aoiType,
    aoiRadiusKm: task.aoiRadiusKm,
    aoiWidthKm: task.aoiWidthKm,
    aoiHeightKm: task.aoiHeightKm,
    aoiLengthKm: task.aoiLengthKm,
    aoiBearingDeg: task.aoiBearingDeg,
    customGeometry: task.customGeometry,
    minimumCoveragePercent: task.minimumCoveragePercent,
    maximumCloudPercent: task.maximumCloudPercent,
    spatialResolutionMeters: task.spatialResolutionMeters,
    incidenceAngleMinDeg: task.incidenceAngleMinDeg,
    incidenceAngleMaxDeg: task.incidenceAngleMaxDeg,
    revisitCount: task.revisitCount,
    sensors: task.sensors,
    sarImagingModes: task.sarImagingModes,
    imagingStart: preservedStart,
    imagingEnd,
    deliveryDeadline,
    aoiApproval: task.aoiApproval,
    approvedAt: task.approvedAt,
    approvedBy: task.approvedBy,
    approvalReason: task.approvalReason,
    orbitDirectionPreference: task.orbitDirectionPreference,
    referenceAcquisitionRequired: task.referenceAcquisitionRequired,
    sarAnalysisMode: task.sarAnalysisMode,
    cycloneTrackingTarget: task.cycloneTrackingTarget,
    status: "candidate",
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
  rebased.timeIndexedAoi = cycloneTaskAoiSlices(event.cycloneForecast, rebased.imagingStart, rebased.imagingEnd);
  rebased.aoiHash = aoiFingerprint(taskGeometry(rebased));
  return rebased;
}

function taskMatchesEvent(task: SatelliteTask, event: DisasterEvent) {
  return task.masterEventId === event.masterEventId || (task.entityKey && task.entityKey === event.entityKey);
}

function inferLegacyTaskEntityKey(task: Partial<SatelliteTask>) {
  const year = new Date(task.eventOccurredAt ?? task.createdAt ?? Date.now()).getUTCFullYear();
  if (task.hazard === "cyclone") {
    const numbered = task.title?.match(/第\s*0?(\d{1,2})\s*号台风\s*[“"'‘]?([^”"'’\s（(，。]{2,20})?/i);
    if (numbered) return `cyclone:${year}:wp:${Number(numbered[1])}${numbered[2] ? `:${normalizeTaskEntityText(numbered[2])}` : ""}`;
    const international = task.title?.match(/(?:tropical\s+cyclone|typhoon|hurricane)\s+[“"']?([a-z][a-z-]{2,})(?:-(\d{2,4}))?/i);
    if (international) return `cyclone:${international[2] ? 2000 + Number(international[2].slice(-2)) : year}:name:${normalizeTaskEntityText(international[1])}`;
  }
  return `event:${task.hazard ?? "unknown"}:${task.eventId ?? "unknown"}`;
}

function normalizeTaskEntityText(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/[“”‘’"'`]/g, "").replace(/[\s·_—–-]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/^-|-$/g, "").slice(0, 80);
}

async function copyCoordinates(task: SatelliteTask) {
  const value = `${task.latitude.toFixed(6)}, ${task.longitude.toFixed(6)}`;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    window.prompt("复制失败，请手动复制坐标", value);
    return false;
  }
}

async function readCustomAoiFile(file: File) {
  if (file.size > 2_000_000) throw new Error("GeoJSON 文件不能超过 2 MB");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { throw new Error("文件不是有效的 JSON"); }
  const geometry = normalizeCustomAoiGeoJson(parsed);
  if (!geometry) throw new Error("只支持有效的 Polygon、MultiPolygon 或包含这些面的 FeatureCollection（最多 10,000 个顶点）");
  return geometry;
}

function customAoiPolygonParts(geometry: CustomAoiGeometry | undefined): AoiPolygonCoordinates[] {
  if (!geometry) return [];
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function taskGeometry(task: SatelliteTask) {
  return buildTaskAoi(task as unknown as Record<string, unknown>) ?? { type: "Point", coordinates: [task.longitude, task.latitude] };
}

function unwrapForecastGeometry(geometry: DisasterEvent["geometry"], referenceLongitude: number): DisasterEvent["geometry"] {
  const sequence = (value: unknown, reference = referenceLongitude) => {
    if (!Array.isArray(value)) return value;
    let previous = reference;
    return value.map((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) return coordinate;
      const longitude = unwrapLongitudeNear(Number(coordinate[0]), previous);
      previous = longitude;
      return [longitude, Number(coordinate[1])];
    });
  };
  if (geometry.type === "Point") {
    const coordinate = geometry.coordinates as number[];
    return { ...geometry, coordinates: [unwrapLongitudeNear(Number(coordinate[0]), referenceLongitude), Number(coordinate[1])] };
  }
  if (geometry.type === "LineString") return { ...geometry, coordinates: sequence(geometry.coordinates) };
  if (geometry.type === "Polygon") return { ...geometry, coordinates: (geometry.coordinates as unknown[]).map((ring) => sequence(ring)) };
  return {
    ...geometry,
    coordinates: (geometry.coordinates as unknown[]).map((polygon) => Array.isArray(polygon) ? polygon.map((ring) => sequence(ring)) : polygon),
  };
}

function unwrapLongitudeNear(longitude: number, reference: number) {
  let result = longitude;
  while (result - reference > 180) result -= 360;
  while (result - reference < -180) result += 360;
  return result;
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function normalizeTaskSensors(values: string[] | undefined) {
  const source = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  const normalized: string[] = [];
  if (source.some((value) => legacyOpticalPayloads.has(value))) normalized.push("光学");
  if (source.includes("SAR")) normalized.push("SAR");
  return normalized;
}

function normalizeSarImagingModes(values: SarImagingModeId[] | undefined): SarImagingModeId[] {
  const allowed = new Set<SarImagingModeId>(sarImagingModeOptions.map((mode) => mode.id));
  const normalized = Array.isArray(values) ? [...new Set(values.filter((value) => allowed.has(value)))] : [];
  return normalized.length ? normalized : sarImagingModeOptions.map((mode) => mode.id);
}

function asMultiPolygon(geometry: CustomAoiGeometry): CustomAoiGeometry {
  return geometry.type === "MultiPolygon"
    ? geometry
    : { type: "MultiPolygon", coordinates: [geometry.coordinates] };
}

function firstPolygon(geometry: CustomAoiGeometry): CustomAoiGeometry | undefined {
  if (geometry.type === "Polygon") return geometry;
  const coordinates = geometry.coordinates;
  return Array.isArray(coordinates) && coordinates.length === 1 ? { type: "Polygon", coordinates: coordinates[0] } : undefined;
}

function customGeometryPatch(geometry: CustomAoiGeometry | undefined, aoiType: AoiType): Pick<SatelliteTask, "customGeometry"> | Record<string, never> {
  if (!geometry || !["polygon", "multi"].includes(aoiType)) return {};
  if (aoiType === "multi") return { customGeometry: asMultiPolygon(geometry) };
  return { customGeometry: firstPolygon(geometry) };
}

function isResponseScenario(value: unknown): value is ResponseScenario {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scenario = value as Record<string, unknown>;
  const validCoordinate = (candidate: unknown) => Array.isArray(candidate) && candidate.length === 2
    && Number.isFinite(Number(candidate[0])) && Number(candidate[0]) >= -180 && Number(candidate[0]) <= 180
    && Number.isFinite(Number(candidate[1])) && Number(candidate[1]) >= -90 && Number(candidate[1]) <= 90;
  if (scenario.schemaVersion !== 1 || typeof scenario.scenarioId !== "string" || scenario.scenarioId.length > 300 || typeof scenario.masterEventId !== "string" || scenario.masterEventId.length > 300) return false;
  if (typeof scenario.eventRevision !== "string" || !/^[a-f0-9]{64}$/.test(scenario.eventRevision) || !Number.isFinite(Date.parse(String(scenario.departureAt ?? "")))) return false;
  if (!validCoordinate(scenario.origin) || !validCoordinate(scenario.destination) || !Number.isFinite(Number(scenario.travelSpeedKph)) || Number(scenario.travelSpeedKph) < 5 || Number(scenario.travelSpeedKph) > 160) return false;
  if (scenario.travelMode !== undefined && !["driving", "walking", "bicycling", "electrobike"].includes(String(scenario.travelMode))) return false;
  if (scenario.roadDisruptions !== undefined && !isRoadDisruptionList(scenario.roadDisruptions)) return false;
  if (scenario.roadDisruptionCheckCount !== undefined && (!Number.isInteger(Number(scenario.roadDisruptionCheckCount)) || Number(scenario.roadDisruptionCheckCount) < 0 || Number(scenario.roadDisruptionCheckCount) > 500)) return false;
  if (!Array.isArray(scenario.routes) || scenario.routes.length < 1 || scenario.routes.length > 10) return false;
  return scenario.routes.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const route = candidate as Record<string, unknown>;
    const geometry = route.geometry as Record<string, unknown> | undefined;
    const conflictsValid = route.disruptionConflicts === undefined || Array.isArray(route.disruptionConflicts) && route.disruptionConflicts.length <= 50 && route.disruptionConflicts.every((conflict) => conflict && typeof conflict === "object" && !Array.isArray(conflict) && typeof (conflict as Record<string, unknown>).label === "string" && String((conflict as Record<string, unknown>).label).length <= 120);
    return conflictsValid && typeof route.routeId === "string" && ["clear", "limited", "blocked", "unverified"].includes(String(route.status))
      && geometry?.type === "LineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2 && geometry.coordinates.length <= 2_000
      && geometry.coordinates.every(validCoordinate);
  });
}


function clampNumber(value: string, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function toLocalInput(value: string) {
  const date = new Date(value);
  const shifted = new Date(date.getTime() + 8 * 3_600_000);
  return shifted.toISOString().slice(0, 16);
}

function fromLocalInput(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return new Date().toISOString();
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute)));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function chinaTime(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

function taskStatusLabel(status: SatelliteTask["status"]) {
  return ({ candidate: "候选", reviewed: "已复核", scheduled: "已排程（回执）", submitted: "已下发（回执）", cancellation_requested: "撤回请求中", cancel_acknowledged: "撤回已确认", cancel_rejected: "撤回被拒绝", acquired: "已成像（回执）", completed: "已完成（产品回执）", failed: "失败", cancelled: "已取消" } as const)[status];
}
