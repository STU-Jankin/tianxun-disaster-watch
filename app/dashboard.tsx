"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hazardMeta,
  isVisibleInScope,
  observationWindowPolicy,
  scopes,
  type DisasterEvent,
  type HazardType,
  type ScopeId,
} from "../lib/disasters";
import { allowedTaskStatuses, canTransitionTask, safeHttpUrl, validateSatelliteTask } from "../lib/task-contract";
import { buildTaskAoi, customAoiPartCount, normalizeCustomAoiGeoJson, type CustomAoiGeometry } from "../lib/task-aoi";
import { aoiFingerprint, eventRevisionFingerprint } from "../lib/event-integrity";
import { cycloneUncertaintyGeometry, cycloneWindGeometry } from "../lib/cyclone-forecast";

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
};

const scopeOrder: ScopeId[] = ["wuxi", "jiangsu", "china", "global"];
const severityLabels = { red: "红色", orange: "橙色", yellow: "黄色", blue: "蓝色" };
const locationQualityLabels: Record<DisasterEvent["locationQuality"], string> = { precise: "精确点位", estimated: "估算点位", representative: "区域代表点", unknown: "位置待核验" };
const confidenceLabels: Record<DisasterEvent["confidenceLevel"], string> = { high: "高可信", medium: "中可信", low: "低可信" };
type SortMode = "priority" | "occurred" | "updated";
type ExportFormat = "json" | "csv" | "geojson";
type SourceStatus = {
  name: string;
  state: "online" | "offline" | "needs_config";
  online: boolean;
  producing: boolean;
  count: number;
  tier: "中国第一批" | "中国第二批" | "基础" | "第一优先级" | "第二优先级";
  role: "事件" | "预报" | "核验";
  message: string;
  setupUrl: string;
};
type AoiType = "source" | "point" | "circle" | "rectangle" | "corridor" | "polygon" | "multi";

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
  aoiType: AoiType;
  aoiRadiusKm: number;
  aoiWidthKm: number;
  aoiHeightKm: number;
  aoiLengthKm: number;
  aoiBearingDeg: number;
  sourceGeometry?: DisasterEvent["geometry"];
  customGeometry?: CustomAoiGeometry;
  cycloneForecast?: DisasterEvent["cycloneForecast"];
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
  observationTargets: string[];
  observationPhase: DisasterEvent["observationPhase"];
  source: string;
  sourceUrl: string;
  locationQuality: DisasterEvent["locationQuality"];
  locationAccuracyKm: number;
  evidenceCount: number;
  aoiApproval: "source_verified" | "operator_confirmed";
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  status: "candidate" | "reviewed" | "scheduled" | "submitted" | "acquired" | "completed" | "failed" | "cancelled";
  revision: number;
  eventRevision: string;
  aoiHash: string;
  approvalReason?: string;
};

type TaskSyncState = { state: "saving" | "synced" | "local" | "error"; message?: string };
type TaskStorageMode = "loading" | "operational-database" | "public-read-only" | "unavailable";

type VisibilityWindow = {
  satelliteId?: string;
  start: string;
  end: string;
  coveragePercent?: number;
  lookAngleDeg?: number;
};

type VisibilityState = {
  state: "idle" | "loading" | "ready" | "needs_config" | "error";
  message?: string;
  windows: VisibilityWindow[];
};

const taskStorageKey = "tianxun-satellite-task-candidates-v1";
const payloadOptions = ["高分辨率光学", "宽幅光学", "多光谱", "高光谱", "SAR", "热红外", "微波辐射计", "激光雷达"];
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

export function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [scope, setScope] = useState<ScopeId>("global");
  const [hazard, setHazard] = useState<HazardType | "all">("all");
  const [selected, setSelected] = useState<DisasterEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastRefreshErrorAt, setLastRefreshErrorAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [listOpen, setListOpen] = useState(true);
  const [locationZh, setLocationZh] = useState<Record<string, string>>({});
  const [locationLoading, setLocationLoading] = useState<string | null>(null);
  const [locationState, setLocationState] = useState<Record<string, { state: "resolved" | "fallback" | "error"; source?: string }>>({});
  const [locationRetry, setLocationRetry] = useState(0);
  const [tasks, setTasks] = useState<SatelliteTask[]>([]);
  const [tasksHydrated, setTasksHydrated] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [confirmedAois, setConfirmedAois] = useState<Set<string>>(new Set());
  const [taskSync, setTaskSync] = useState<Record<string, TaskSyncState>>({});
  const [taskStorageMode, setTaskStorageMode] = useState<TaskStorageMode>("loading");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const taskTriggerRef = useRef<HTMLButtonElement>(null);
  const previousTaskPanelOpen = useRef(false);
  const taskSaveTimers = useRef(new Map<string, number>());
  const taskSaveControllers = useRef(new Map<string, AbortController>());
  const taskMutationGeneration = useRef(new Map<string, number>());
  const tasksRef = useRef<SatelliteTask[]>([]);
  const closeTaskPanel = useCallback(() => { setTaskPanelOpen(false); }, []);
  const selectEvent = useCallback((event: DisasterEvent) => {
    setSelected(event);
    if (window.matchMedia("(max-width: 720px)").matches) setListOpen(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/events", { cache: "no-store" });
      if (!response.ok) throw new Error("数据请求失败");
      setData(await response.json());
      setLastRefreshErrorAt(null);
    } catch {
      setError(true);
      setLastRefreshErrorAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => () => {
    taskSaveTimers.current.forEach((timer) => window.clearTimeout(timer));
    taskSaveControllers.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousTaskPanelOpen.current && !taskPanelOpen) taskTriggerRef.current?.focus();
    previousTaskPanelOpen.current = taskPanelOpen;
  }, [taskPanelOpen]);

  useEffect(() => {
    const restore = window.setTimeout(async () => {
      let localTasks: SatelliteTask[] = [];
      try {
        const saved = window.localStorage.getItem(taskStorageKey);
        if (saved) localTasks = (JSON.parse(saved) as Array<Partial<SatelliteTask>>).map(migrateSatelliteTask);
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
        const cancelled = new Set(result.cancelledTaskIds ?? []);
        const merged = [...new Map([...localTasks.filter((task) => !cancelled.has(task.taskId)), ...serverTasks].map((task) => [task.taskId, task])).values()];
        setTasks(merged);
        setTaskSync(Object.fromEntries(merged.map((task) => [task.taskId, {
          state: serverTasks.some((server) => server.taskId === task.taskId) ? "synced" : "local",
          message: storageMode === "public-read-only" ? "公网入口为只读模式；此任务仅保存在本机" : undefined,
        } as TaskSyncState])));
      } catch {
        setTaskStorageMode("unavailable");
        setTasks(localTasks);
        setTaskSync(Object.fromEntries(localTasks.map((task) => [task.taskId, { state: "local", message: "任务服务不可用；仅保存在本机" } as TaskSyncState])));
      } finally {
        setTasksHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => {
    if (!tasksHydrated) return;
    window.localStorage.setItem(taskStorageKey, JSON.stringify(tasks));
  }, [tasks, tasksHydrated]);

  const saveTask = useCallback(async (task: SatelliteTask) => {
    if (taskStorageMode === "public-read-only") {
      setTaskSync((current) => ({ ...current, [task.taskId]: { state: "local", message: "公网入口为只读模式；任务仅保存在本机" } }));
      return false;
    }
    const generation = taskMutationGeneration.current.get(task.taskId) ?? 0;
    taskSaveControllers.current.get(task.taskId)?.abort();
    const controller = new AbortController();
    taskSaveControllers.current.set(task.taskId, controller);
    setTaskSync((current) => ({ ...current, [task.taskId]: { state: "saving" } }));
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(task), signal: controller.signal });
      const result = await response.json() as { task?: Partial<SatelliteTask>; error?: string; errors?: string[] };
      if (!response.ok) throw new Error(result.errors?.join("；") || result.error || "保存失败");
      if ((taskMutationGeneration.current.get(task.taskId) ?? 0) !== generation || !tasksRef.current.some((item) => item.taskId === task.taskId)) return false;
      if (result.task) {
        const serverTask = migrateSatelliteTask(result.task);
        setTasks((current) => current.map((item) => item.taskId !== task.taskId ? item : item.updatedAt === task.updatedAt ? serverTask : { ...item, revision: serverTask.revision, eventRevision: serverTask.eventRevision, aoiHash: serverTask.aoiHash }));
      }
      setTaskSync((current) => ({ ...current, [task.taskId]: { state: "synced" } }));
      return true;
    } catch (saveError) {
      if (controller.signal.aborted || (taskMutationGeneration.current.get(task.taskId) ?? 0) !== generation) return false;
      setTaskSync((current) => ({ ...current, [task.taskId]: { state: "error", message: saveError instanceof Error ? saveError.message : "保存失败" } }));
      return false;
    } finally {
      if (taskSaveControllers.current.get(task.taskId) === controller) taskSaveControllers.current.delete(task.taskId);
    }
  }, [taskStorageMode]);

  const addTask = useCallback((event: DisasterEvent, operatorConfirmed: boolean) => {
    const task = createSatelliteTask(event, operatorConfirmed);
    setTasks((current) => {
      if (current.some((item) => taskMatchesEvent(item, event))) return current;
      return [task, ...current];
    });
    void saveTask(task).then((ok) => {
      if (!ok) setTaskSync((current) => ({ ...current, [task.taskId]: current[task.taskId] ?? { state: "local", message: "仅保存在本机，可稍后重试同步" } }));
    });
    setTaskPanelOpen(true);
    setActiveTaskId(task.taskId);
  }, [saveTask]);

  const updateTask = useCallback((taskId: string, patch: Partial<SatelliteTask>) => {
    const aoiKeys = ["aoiType", "aoiRadiusKm", "aoiWidthKm", "aoiHeightKm", "aoiLengthKm", "aoiBearingDeg", "customGeometry"];
    const touchesAoi = Object.keys(patch).some((key) => aoiKeys.includes(key));
    taskMutationGeneration.current.set(taskId, (taskMutationGeneration.current.get(taskId) ?? 0) + 1);
    taskSaveControllers.current.get(taskId)?.abort();
    setTasks((current) => current.map((task) => {
      if (task.taskId !== taskId) return task;
      return { ...task, ...patch, ...(touchesAoi ? { aoiApproval: "operator_confirmed" as const, approvalReason: "操作员调整 AOI 参数" } : {}), updatedAt: new Date().toISOString() };
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
    setTasks((current) => current.filter((task) => task.taskId !== taskId));
    if (activeTaskId === taskId) setActiveTaskId(null);
    const removeSyncState = () => setTaskSync((current) => { const next = { ...current }; delete next[taskId]; return next; });
    if (task.revision === 0 || taskStorageMode === "public-read-only" || taskStorageMode === "unavailable") {
      removeSyncState();
      return;
    }
    try {
      const response = await fetch(`/api/tasks?taskId=${encodeURIComponent(taskId)}&revision=${task.revision}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `取消任务失败（HTTP ${response.status}）`);
      removeSyncState();
    } catch (removeError) {
      setTasks((current) => current.some((item) => item.taskId === taskId) ? current : [task, ...current]);
      setTaskSync((current) => ({ ...current, [taskId]: { state: "error", message: removeError instanceof Error ? removeError.message : "服务端取消失败，任务已恢复" } }));
    }
  }, [activeTaskId, taskStorageMode]);

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

  useEffect(() => {
    if (!selected || !data) return;
    const current = data.events.find((event) => event.masterEventId === selected.masterEventId) ?? data.events.find((event) => event.id === selected.id);
    if (!current) setSelected(null);
    else if (current !== selected) setSelected(current);
  }, [data, selected]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-event-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...new Map((data?.events ?? []).map((event) => [event.masterEventId, event])).values()]
    .filter((event) =>
        isVisibleInScope(event.scope, scope) &&
        (hazard === "all" || event.hazard === hazard) &&
        (!needle || `${event.title} ${event.country ?? ""} ${event.source} ${locationZh[event.id] ?? ""}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => sortMode === "occurred"
        ? +new Date(b.occurredAt) - +new Date(a.occurredAt) || b.priority - a.priority
        : sortMode === "updated" ? +new Date(b.updatedAt) - +new Date(a.updatedAt) || b.priority - a.priority
        : b.priority - a.priority || +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [data, hazard, locationZh, query, scope, sortMode]);

  useEffect(() => {
    if (selected && !filtered.some((event) => event.id === selected.id)) setSelected(null);
  }, [filtered, selected]);

  const scopedEvents = useMemo(() => (data?.events ?? []).filter((event) => isVisibleInScope(event.scope, scope)), [data, scope]);

  const scopeCounts = useMemo(() => Object.fromEntries(scopeOrder.map((id) => [
    id,
    (data?.events ?? []).filter((event) => isVisibleInScope(event.scope, id)).length,
  ])) as Record<ScopeId, number>, [data]);

  const severeCount = filtered.filter((e) => e.severity === "red" || e.severity === "orange").length;
  const highPriorityCount = filtered.filter((e) => e.priority >= 70).length;
  const producingSourceCount = data?.producingSourceCount ?? data?.sourceStatus.filter((source) => source.producing).length ?? 0;
  const runtimeMode = !data ? "正在连接" : data.fallback && data.retainedCount > 0 ? "缓存模式" : data.fallback ? "演示模式" : producingSourceCount === 0 ? "无事件产出" : data.persistenceAvailable === false ? "数据库降级" : "实时监测中";
  const modeStale = runtimeMode !== "实时监测中" || Boolean(lastRefreshErrorAt);
  const activeTask = tasks.find((task) => task.taskId === activeTaskId) ?? null;
  const reviewTaskAoi = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    setSelected(null);
    setTaskPanelOpen(false);
    if (window.matchMedia("(max-width: 720px)").matches) setListOpen(false);
  }, []);
  const updateCustomAoi = useCallback((taskId: string, geometry?: CustomAoiGeometry) => {
    updateTask(taskId, {
      customGeometry: geometry,
      ...(geometry ? { aoiType: geometry.type === "Polygon" ? "polygon" : "multi" } : {}),
    });
  }, [updateTask]);

  return (
    <main className="app-shell">
      <header className="topbar" inert={taskPanelOpen ? true : undefined} aria-hidden={taskPanelOpen || undefined}>
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div><strong>天巡</strong><small>TIANXUN DISASTER WATCH</small></div>
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
          <button ref={taskTriggerRef} className="task-queue-button" onClick={() => { document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((details) => { details.open = false; }); setTaskPanelOpen(true); }} aria-label={`打开卫星任务候选单，共${tasks.length}项`}>
            任务候选 <b>{tasks.length}</b>
          </button>
          <div className="time-box"><strong>{chinaTime(clock)}</strong><small>UTC+08:00</small></div>
        </div>
      </header>

      <section className="control-strip" inert={taskPanelOpen ? true : undefined} aria-hidden={taskPanelOpen || undefined}>
        <div className="scope-tabs" aria-label="重点观测范围">
          <span className="strip-label">重点范围</span>
          {scopeOrder.map((id, index) => (
            <button key={id} onClick={() => setScope(id)} className={scope === id ? "active" : ""} aria-pressed={scope === id}>
              <i>{index + 1}</i><span>{scopes[id].label}</span><b>{scopeCounts[id] ?? 0}</b>
            </button>
          ))}
        </div>
        <SourceStatusPanel sources={data?.sourceStatus ?? []} forceClosed={taskPanelOpen} />
      </section>

      <section className={`workspace ${taskPanelOpen ? "tasks-open" : ""}`}>
        <aside className={`event-panel ${listOpen ? "open" : "closed"}`} inert={taskPanelOpen ? true : undefined} aria-hidden={taskPanelOpen || undefined}>
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
          {modeStale ? <div className="stale-banner" role="alert">当前为{lastRefreshErrorAt ? "刷新失败后的保留结果" : runtimeMode}；不得将本轮读取时间当作灾害观测时间，自动下发已禁止。</div> : null}
          <HazardFilters selected={hazard} onChange={setHazard} events={scopedEvents} />
          <SortControl selected={sortMode} onChange={setSortMode} />
          <ObservationPolicy />
          <div className="event-list">
            {loading && !data ? <LoadingList /> : null}
            {error && !data ? <EmptyState title="暂时无法连接数据源" detail="请检查网络后点击右上角刷新。" /> : null}
            {!loading && filtered.length === 0 ? <EmptyState title={`${scopes[scope].label}暂无匹配事件`} detail={query || hazard !== "all" ? "当前搜索或筛选没有匹配结果，请清除搜索或重置灾种。" : modeStale ? "当前数据源未产出可用实时事件，请检查数据源状态。" : "当前范围没有满足条件的可观测事件。"} /> : null}
            {filtered.map((event) => (
              <EventCard key={event.id} event={event} active={selected?.id === event.id} onClick={() => selectEvent(event)} />
            ))}
          </div>
          <footer className="panel-footer">
            <span className={loading ? "syncing" : ""}>↻</span>
            {loading ? "正在同步…" : data ? `本轮读取 ${formatTimeWithYear(data.fetchedAt)} UTC+08 · 实时${data.processedCount}条 + 延续${data.retainedCount}条 · ${producingSourceCount}个来源产出` : "等待同步"}
          </footer>
        </aside>

        {!listOpen && <button className="reopen-panel" onClick={() => setListOpen(true)} inert={taskPanelOpen ? true : undefined} aria-hidden={taskPanelOpen || undefined}>事件列表 <b>{filtered.length}</b> ›</button>}

          <MapView scope={scope} events={filtered} selected={selected} activeTask={activeTask} detailOpen={Boolean(selected) && !taskPanelOpen} layoutKey={`${taskPanelOpen}-${listOpen}`} obscured={taskPanelOpen} onSelect={selectEvent} onCustomAoiChange={updateCustomAoi} onReturnToTask={() => setTaskPanelOpen(true)} />

        <div className="map-legend" inert={taskPanelOpen ? true : undefined} aria-hidden={taskPanelOpen || undefined}>
          <span><i className="red" />红色</span><span><i className="orange" />橙色</span><span><i className="yellow" />黄色</span><span><i className="blue" />蓝色</span>
          <em />
          <span className="priority-ring">◎</span><span>重点范围加权</span>
          {selected?.cycloneForecast ? <><em /><span><i className="forecast-track-key" />官方路径</span><span><i className="forecast-impact-key" />风圈范围</span><span><i className="forecast-uncertainty-key" />路径不确定区</span></> : null}
        </div>

        {selected && <DetailPanel event={selected} obscured={taskPanelOpen} dispatchBlocked={modeStale} locationZh={locationZh[selected.id]} locationLoading={locationLoading === selected.id} locationState={locationState[selected.id]?.state} onRetryLocation={() => { setLocationState((current) => { const next = { ...current }; delete next[selected.id]; return next; }); setLocationRetry((value) => value + 1); }} taskAdded={tasks.some((task) => taskMatchesEvent(task, selected))} aoiConfirmed={confirmedAois.has(selected.masterEventId)} onConfirmAoi={(confirmed) => setConfirmedAois((current) => { const next = new Set(current); if (confirmed) next.add(selected.masterEventId); else next.delete(selected.masterEventId); return next; })} onAddTask={addTask} onClose={() => setSelected(null)} />}
        {taskPanelOpen && <TaskPanel tasks={tasks} syncState={taskSync} storageMode={taskStorageMode} activeTaskId={activeTaskId} onActivate={reviewTaskAoi} onUpdate={updateTask} onRemove={(taskId) => void removeTask(taskId)} onClose={closeTaskPanel} onRetry={(task) => void saveTask(task)} />}
      </section>
    </main>
  );
}

function SourceStatusPanel({ sources, forceClosed }: { sources: SourceStatus[]; forceClosed: boolean }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (forceClosed && detailsRef.current) detailsRef.current.open = false; }, [forceClosed]);
  const online = sources.filter((source) => source.state === "online").length;
  const pending = sources.filter((source) => source.state === "needs_config").length;
  return <details ref={detailsRef} className="source-status">
    <summary><span><i className="online-dot" />数据源 {online}/{sources.length}</span>{pending ? <b>{pending} 待配置</b> : null}</summary>
    <div className="source-status-popover">
      {(["中国第一批", "中国第二批", "基础", "第一优先级", "第二优先级"] as const).map((tier) => <section key={tier}>
        <h3>{tier}</h3>
        {sources.filter((source) => source.tier === tier).map((source) => <a key={source.name} href={safeHttpUrl(source.setupUrl)} target="_blank" rel="noreferrer" className={source.state} title={source.message}>
          <i /><span><strong>{source.name}</strong><small>{source.role} · {source.message}</small></span><b>{source.state === "online" ? source.producing ? source.count : "仅连通" : source.state === "needs_config" ? "待配置" : "异常"}</b>
        </a>)}
      </section>)}
      <footer>区域通报只生成任务初筛AOI；传感器点位和受灾边界必须由正式矢量或实测数据替换。“核验”源不生成任务坐标。</footer>
    </div>
  </details>;
}

function SortControl({ selected, onChange }: { selected: SortMode; onChange: (value: SortMode) => void }) {
  return <div className="sort-control" aria-label="事件排序方式">
    <span>排序</span>
    <button aria-pressed={selected === "priority"} className={selected === "priority" ? "active" : ""} onClick={() => onChange("priority")}>综合优先</button>
    <button aria-pressed={selected === "occurred"} className={selected === "occurred" ? "active" : ""} onClick={() => onChange("occurred")}>最新发生</button>
    <button aria-pressed={selected === "updated"} className={selected === "updated" ? "active" : ""} onClick={() => onChange("updated")}>最新更新</button>
    <small>{selected === "priority" ? "时效最高30分，7天半衰" : selected === "occurred" ? "按灾害发生时间" : "按最新有效报次"}</small>
  </div>;
}

function HazardFilters({ selected, onChange, events }: { selected: HazardType | "all"; onChange: (value: HazardType | "all") => void; events: DisasterEvent[] }) {
  const options: Array<HazardType | "all"> = ["all", "earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"];
  return <div className="hazard-filters">
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
  const cardTime = event.updateCount > 1 ? event.updatedAt : event.occurredAt;
  return <button data-event-id={event.id} className={`event-card ${event.severity} ${active ? "active" : ""}`} onClick={onClick}>
    <div className="hazard-icon">{hazardMeta[event.hazard].symbol}</div>
    <div className="event-copy">
      <div className="event-title-row"><h2>{event.title}</h2><span title={event.updateCount > 1 ? `首次 ${formatTimeWithYear(event.occurredAt)} · 最新 ${formatTimeWithYear(event.updatedAt)}` : `${formatTime(event.occurredAt)} · ${relativeTime(event.occurredAt)}`}>{event.updateCount > 1 ? "更新 " : ""}{formatCardTime(cardTime)}</span></div>
      <p>{event.country || `${event.latitude.toFixed(2)}°, ${event.longitude.toFixed(2)}°`}</p>
      <div className="event-tags">
        <span className="severity-tag">{severityLabels[event.severity]}预警</span>
        <span className={`phase-tag ${event.observationPhase}`}>{event.observationPhase === "golden" ? "黄金观测期" : "后续观测期"}</span>
        {event.sourcePresence === "retained" ? <span className="monitoring-tag">来源暂未复现</span> : null}
        {event.updateCount > 1 ? <span className="update-tag">{event.updateCount}期更新</span> : null}
        <span className={`confidence-tag ${event.confidenceLevel}`}>{confidenceLabels[event.confidenceLevel]} · {event.evidenceCount}源</span>
        <span className="time-weight-tag">时效 +{event.priorityBreakdown.time}</span>
        <span>{event.observable === "direct" ? "直接可观测" : event.observable === "consequence" ? "灾后可观测" : "条件可观测"}</span>
      </div>
    </div>
    <div className="priority-score"><strong>{event.priority}</strong><small>优先级</small></div>
  </button>;
}

function MapView({ scope, events, selected, activeTask, detailOpen, layoutKey, obscured, onSelect, onCustomAoiChange, onReturnToTask }: { scope: ScopeId; events: DisasterEvent[]; selected: DisasterEvent | null; activeTask: SatelliteTask | null; detailOpen: boolean; layoutKey: string; obscured: boolean; onSelect: (event: DisasterEvent) => void; onCustomAoiChange: (taskId: string, geometry?: CustomAoiGeometry) => void; onReturnToTask: () => void }) {
  const bbox = scopes[scope].bbox;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const selectedLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
  const aoiLayerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const drawPreviewLayerRef = useRef<import("leaflet").FeatureGroup | null>(null);
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
      drawPreviewLayerRef.current = L.featureGroup().addTo(map);
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
      drawPreviewLayerRef.current = null;
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
        if (activeTask) {
          const layer = aoiLayerRef.current;
          if (layer?.getBounds().isValid()) fitWithOverlay(map, layer.getBounds(), 11);
        } else if (selected?.cycloneForecast && selectedLayerRef.current?.getBounds().isValid()) {
          fitWithOverlay(map, selectedLayerRef.current.getBounds(), 7);
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
  }, [activeTask, bbox, centerWithOverlay, fitWithOverlay, layoutKey, mapReady, scope, selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [24, 24], animate: true, duration: 0.45 });
  }, [bbox, mapReady, scope]);

  const forecastFrameIndex = forecastSelection.eventId === selected?.id ? forecastSelection.index : 0;
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
          const latitude = group.reduce((sum, event) => sum + event.latitude, 0) / group.length;
          const longitude = circularLongitude(group.map((event) => event.longitude));
          const cluster = L.marker([latitude, longitude], {
            icon: L.divIcon({ className: "event-div-icon", html: `<span class="geo-cluster"><b>${group.length}</b></span>`, iconSize: [38, 38], iconAnchor: [19, 19] }),
            title: `${group.length} 个邻近灾害事件`, keyboard: true,
          });
          cluster.bindTooltip(`${group.length} 个共址/邻近事件：${group.slice(0, 4).map((event) => event.title).join("；")}${group.length > 4 ? "…" : ""}`, { direction: "top", offset: [0, -17] });
          cluster.on("click", () => map.getZoom() >= 12 ? onSelectRef.current(group[0]) : map.setView([latitude, longitude], Math.min(12, map.getZoom() + 3), { animate: true }));
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
      if (selected.geometry.type !== "Point") {
        L.geoJSON(unwrapForecastGeometry(selected.geometry, selected.longitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#006d63", weight: 3, fillColor: "#46a795", fillOpacity: 0.12, dashArray: "4 3", className: "selected-source-geometry" },
          interactive: false,
        }).addTo(layer);
      }
      if (forecast?.impactGeometry && !forecast.impactField) {
        L.geoJSON(unwrapForecastGeometry(forecast.impactGeometry, selected.longitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#c15624", weight: 1.5, fillColor: "#e58a42", fillOpacity: 0.16, className: "cyclone-impact-area" },
          interactive: false,
        }).addTo(layer);
      }
      if (forecast?.uncertaintyGeometry) {
        L.geoJSON(unwrapForecastGeometry(forecast.uncertaintyGeometry, selected.longitude) as GeoJSON.GeoJsonObject, {
          style: { color: "#6b5aa6", weight: 1.5, fillColor: "#8c79bd", fillOpacity: 0.10, dashArray: "5 4", className: "cyclone-uncertainty-area" },
          interactive: false,
        }).addTo(layer);
      }
      if (impactFrame) {
        const frameUncertainty = cycloneUncertaintyGeometry(impactFrame);
        if (frameUncertainty) {
          L.geoJSON(unwrapForecastGeometry(frameUncertainty, impactFrame.longitude) as GeoJSON.GeoJsonObject, {
            style: { color: "#6b5aa6", weight: 2, fillColor: "#8c79bd", fillOpacity: 0.16, dashArray: "4 3", className: "cyclone-frame-uncertainty" },
            interactive: false,
          }).addTo(layer);
        }
        [...impactFrame.windFields].sort((left, right) => left.thresholdKnots - right.thresholdKnots).forEach((field) => {
          const color = field.thresholdKnots >= 64 ? "#a72222" : field.thresholdKnots >= 50 ? "#cf552f" : "#e58a42";
          L.geoJSON(unwrapForecastGeometry(cycloneWindGeometry(impactFrame, field), impactFrame.longitude) as GeoJSON.GeoJsonObject, {
            style: { color, weight: 1.8, fillColor: color, fillOpacity: field.thresholdKnots >= 64 ? 0.22 : 0.12, className: `cyclone-wind-${field.thresholdKnots}` },
            interactive: false,
          }).addTo(layer);
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
      L.circleMarker([selected.latitude, selected.longitude], { radius: 20, color: "#006d63", weight: 3, fill: false, interactive: false, className: "selected-event-ring" }).addTo(layer);
      if (!activeTask && layer.getBounds().isValid() && (forecast || selected.geometry.type !== "Point")) fitWithOverlay(map, layer.getBounds(), forecast ? 7 : 9);
    });
    return () => { cancelled = true; };
  }, [activeTask, fitWithOverlay, forecastFrameIndex, mapReady, selected]);

  useEffect(() => {
    if (!mapReady || !selected || selected.cycloneForecast || selected.geometry.type !== "Point" || !mapRef.current) return;
    const map = mapRef.current;
    const targetZoom = Math.max(map.getZoom(), scope === "global" ? 4 : map.getZoom());
    if (detailOpen) centerWithOverlay(map, selected.latitude, selected.longitude, targetZoom);
    else map.flyTo([selected.latitude, selected.longitude], targetZoom, { animate: true, duration: 0.45 });
  }, [centerWithOverlay, detailOpen, mapReady, scope, selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled) return;
      if (aoiLayerRef.current) aoiLayerRef.current.removeFrom(map);
      aoiLayerRef.current = null;
      if (!activeTask) return;
      const geometry = buildTaskAoi(activeTask as unknown as Record<string, unknown>);
      if (!geometry) return;
      const layer = L.geoJSON(geometry as GeoJSON.GeoJsonObject, { style: { color: "#006d63", weight: 2, fillColor: "#46a795", fillOpacity: 0.18, dashArray: "6 4" } }).addTo(map);
      aoiLayerRef.current = layer;
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 11 });
    });
    return () => { cancelled = true; };
  }, [activeTask, mapReady]);

  const finishCustomPolygon = useCallback(() => {
    if (!activeTask || activeDraftVertices.length < 3) {
      setDrawingError("至少点击 3 个不同顶点后才能完成多边形");
      return;
    }
    const ring = [...activeDraftVertices, [...activeDraftVertices[0]] as [number, number]];
    const existing = activeTask.aoiType === "multi" ? customAoiPolygonParts(activeTask.customGeometry) : [];
    const polygons = [...existing, [ring]];
    const geometry: CustomAoiGeometry = polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
    onCustomAoiChange(activeTask.taskId, geometry);
    setDraftVertices([]);
    setDrawing(false);
    setDrawingError("");
  }, [activeDraftVertices, activeTask, onCustomAoiChange]);

  const forecastFrames = selected?.cycloneForecast?.impactField?.frames ?? [];
  const activeForecastFrame = forecastFrames[Math.min(forecastFrameIndex, Math.max(0, forecastFrames.length - 1))];

  return <div className="map-stage" inert={obscured ? true : undefined} aria-hidden={obscured || undefined}>
    <div ref={containerRef} className="leaflet-map" aria-label={`${scopes[scope].label}灾害事件地图`} />
    <div className="map-shade" />
    <div className="map-title"><span>观测视图</span><strong>{scopes[scope].label}</strong><small>{events.length} 个事件 · 行政范围为快速筛选近似边界</small></div>
    <div className="coordinates">WGS 84 · {viewLabel || "地图初始化中"}</div>
    {forecastFrames.length > 0 && activeForecastFrame ? <div className="cyclone-timeline" role="group" aria-label="台风四维影响场时间轴">
      <div><strong>4D 影响场</strong><span>{activeForecastFrame.centerBasis === "official_node" ? "官方节点" : "逐时插值"} · +{activeForecastFrame.leadHours}h</span></div>
      <time>{formatTimeWithYear(activeForecastFrame.forecastAt)} UTC+08</time>
      <input type="range" min="0" max={forecastFrames.length - 1} value={Math.min(forecastFrameIndex, forecastFrames.length - 1)} onChange={(event) => setForecastSelection({ eventId: selected?.id ?? "", index: Number(event.target.value) })} aria-label="选择台风预报小时" />
      <small>{activeForecastFrame.windFields.length ? activeForecastFrame.windFields.map((field) => `≥${field.thresholdKnots} kt 象限风圈`).join(" · ") : "本时次无可用官方风圈"} · {activeForecastFrame.uncertaintyRadiusKm || activeForecastFrame.uncertaintyGeometry ? "含分时不确定区" : selected?.cycloneForecast?.uncertaintyGeometry ? "显示本报次总体不确定区" : "无不确定区数据"}</small>
    </div> : null}
    {activeTask ? <div className="map-review-toolbar" role="group" aria-label="任务AOI地图复核">
      <div><strong>{activeTask.title}</strong><span>{["polygon", "multi"].includes(activeTask.aoiType) ? `${customAoiPartCount(activeTask.customGeometry)} 块自定义 AOI` : "正在显示任务 AOI"}</span></div>
      {["polygon", "multi"].includes(activeTask.aoiType) ? <>
        <button onClick={() => { setDrawingTaskId(activeTask.taskId); setDrawing(true); setDraftVertices([]); setDrawingError(""); }}>{activeTask.aoiType === "multi" && activeTask.customGeometry ? "添加子区" : "开始绘制"}</button>
        <button onClick={() => setDraftVertices((current) => current.slice(0, -1))} disabled={!activeDrawing || !activeDraftVertices.length}>撤销顶点</button>
        <button onClick={finishCustomPolygon} disabled={!activeDrawing}>完成当前面</button>
        <button onClick={() => { onCustomAoiChange(activeTask.taskId, undefined); setDraftVertices([]); setDrawing(false); }} disabled={!activeTask.customGeometry && !activeDraftVertices.length}>清空</button>
      </> : null}
      <button onClick={onReturnToTask}>返回任务单</button>
      {activeDrawing ? <small>在地图依次点击边界顶点，完成后点击“完成当前面”。{activeDraftVertices.length} 个顶点。</small> : null}
      {drawingError ? <small className="drawing-error" role="alert">{drawingError}</small> : null}
    </div> : null}
    {mapError ? <div className="map-error" role="alert">{mapError}<button onClick={() => window.location.reload()}>重试</button></div> : null}
  </div>;
}

function DetailPanel({ event, obscured, dispatchBlocked, locationZh, locationLoading, locationState, onRetryLocation, taskAdded, aoiConfirmed, onConfirmAoi, onAddTask, onClose }: { event: DisasterEvent; obscured: boolean; dispatchBlocked: boolean; locationZh?: string; locationLoading: boolean; locationState?: "resolved" | "fallback" | "error"; onRetryLocation: () => void; taskAdded: boolean; aoiConfirmed: boolean; onConfirmAoi: (confirmed: boolean) => void; onAddTask: (event: DisasterEvent, operatorConfirmed: boolean) => void; onClose: () => void }) {
  const isDemo = event.source === "演示数据";
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (window.matchMedia("(max-width: 720px)").matches) closeRef.current?.focus(); }, [event.id]);
  const canDispatch = !dispatchBlocked && !isDemo && event.lifecycleStatus !== "resolved" && event.lifecycleStatus !== "archived" && (event.dispatchEligibility === "ready" || aoiConfirmed);
  return <aside className="detail-panel" aria-labelledby={`detail-title-${event.id}`} inert={obscured ? true : undefined} aria-hidden={obscured || undefined}>
    <button ref={closeRef} className="detail-close" onClick={onClose} aria-label="关闭详情">×</button>
    <div className={`detail-kicker ${event.severity}`}><span>{hazardMeta[event.hazard].symbol}</span>{hazardMeta[event.hazard].label} · {severityLabels[event.severity]}预警</div>
    <h2 id={`detail-title-${event.id}`}>{event.title}</h2>
    <div className="detail-location">
      <span>⌖ 中文地点</span>
      <strong className={locationLoading ? "location-loading" : ""}>{locationLoading ? "正在解析中文地点…" : locationZh || "暂无中文地点"}</strong>
      {locationState === "fallback" ? <small>在线地名解析暂不可用，当前为来源文本/坐标回退结果。<button onClick={onRetryLocation}>重试解析</button></small> : null}
      {locationState === "error" ? <small role="alert">中文地点解析失败。<button onClick={onRetryLocation}>重试</button></small> : null}
      <small>来源原文：{event.country || event.title}</small>
    </div>
    <div className="detail-score"><div><strong>{event.priority}</strong><span>任务优先级</span></div><p>严重度 {event.priorityBreakdown.severity} · 区域 {event.priorityBreakdown.scope} · 遥感 {event.priorityBreakdown.observability} · 时效 {event.priorityBreakdown.time} · 可信度 {event.priorityBreakdown.confidence ?? 0}</p></div>
    <div className={`event-integrity ${event.dispatchEligibility}`}>
      <div><strong>{confidenceLabels[event.confidenceLevel]} {event.confidenceScore}</strong><span>{event.evidenceCount} 条来源证据</span></div>
      <p><b>{locationQualityLabels[event.locationQuality]}</b> · 估计误差约 {event.locationAccuracyKm} km</p>
      <small>主事件ID：{event.masterEventId}</small>
      {event.sourcePresence === "retained" ? <em>当前短时数据源未再次报告该事件；未据此判定灾害已结束，仍保留至观测期届满或权威撤销。</em> : null}
    </div>
    <div className="observation-deadline"><span>{event.observationPhase === "golden" ? "距建议复核" : "后续观测剩余"}</span><strong>{remainingObservationTime(event.observationPhase === "golden" ? event.observationReviewAt : event.observationExpiresAt)}</strong><small>{event.observationPhase === "golden" ? `黄金期至 ${formatTime(event.observationReviewAt)}；到期不撤销，转后续观测` : `建议持续复核；兜底归档 ${formatTime(event.observationExpiresAt)}`}</small></div>
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
    <section className="evidence-chain"><h3>证据链</h3>{event.evidence.map((item) => <a key={`${item.source}-${item.sourceEventId}`} href={safeHttpUrl(item.sourceUrl)} target="_blank" rel="noreferrer"><span>{item.source}</span><small>{item.role === "detection" ? "探测" : item.role === "warning" ? "预警" : "核验"} · {formatTime(item.observedAt)}</small></a>)}</section>
    {event.updateCount > 1 ? <section className="update-history"><h3>过程更新 · 共 {event.updateCount} 期</h3>{event.updateHistory.slice(0, 8).map((item, index) => <a key={`${item.source}-${item.sourceEventId}`} href={safeHttpUrl(item.sourceUrl)} target="_blank" rel="noreferrer"><i>{index === 0 ? "最新" : String(event.updateCount - index).padStart(2, "0")}</i><span><strong>{item.title}</strong><small>{item.source} · {formatTimeWithYear(item.observedAt)}</small></span></a>)}</section> : null}
    <dl>
      <div><dt>发生时间</dt><dd>{formatTimeWithYear(event.occurredAt)} UTC+08</dd></div>
      <div><dt>最新更新</dt><dd>{formatTimeWithYear(event.updatedAt)} UTC+08</dd></div>
      <div><dt>来源等级</dt><dd>{event.sourceSeverity}</dd></div>
      <div><dt>坐标</dt><dd>{event.latitude.toFixed(3)}°, {event.longitude.toFixed(3)}°</dd></div>
      <div><dt>数据来源</dt><dd>{event.source}</dd></div>
    </dl>
    <a className="source-link" href={safeHttpUrl(event.sourceUrl)} target="_blank" rel="noreferrer">查看权威来源 ↗</a>
    {event.aoiApprovalRequired ? <div className="aoi-approval"><input id={`aoi-confirm-${event.id}`} type="checkbox" checked={aoiConfirmed} onChange={(change) => onConfirmAoi(change.target.checked)} /><label htmlFor={`aoi-confirm-${event.id}`}><strong>人工核对 AOI</strong><small>地图已用绿色虚线显示完整来源几何；确认前请核对目标类型、范围和代表点误差。</small></label></div> : null}
    <button className="task-button" onClick={() => onAddTask(event, aoiConfirmed)} disabled={taskAdded || !canDispatch}>{taskAdded ? "已加入卫星任务候选" : dispatchBlocked ? "非实时/数据库降级状态禁止下发" : isDemo ? "演示事件禁止下发" : !canDispatch ? "需先人工核对 AOI" : "加入卫星任务候选"}</button>
  </aside>;
}

function TaskPanel({ tasks, syncState, storageMode, activeTaskId, onActivate, onUpdate, onRemove, onClose, onRetry }: { tasks: SatelliteTask[]; syncState: Record<string, TaskSyncState>; storageMode: TaskStorageMode; activeTaskId: string | null; onActivate: (taskId: string) => void; onUpdate: (taskId: string, patch: Partial<SatelliteTask>) => void; onRemove: (taskId: string) => void; onClose: () => void; onRetry: (task: SatelliteTask) => void }) {
  const [visibility, setVisibility] = useState<Record<string, VisibilityState>>({});
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");
  const [aoiImportError, setAoiImportError] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
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
  }, [onClose]);
  const exportableCount = tasks.filter((task) => validateSatelliteTask(task as unknown as Record<string, unknown>, { requireApproved: true, requirePayload: true, requireProvenance: true }).ok && syncState[task.taskId]?.state === "synced").length;
  const exportable = tasks.length > 0 && exportableCount === tasks.length;
  const exportValidated = async (format: ExportFormat) => {
    setExportError("");
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      if (!response.ok) throw new Error("无法复核业务数据库");
      const result = await response.json() as { tasks?: Array<Partial<SatelliteTask>>; cancelledTaskIds?: string[] };
      const cancelled = new Set(result.cancelledTaskIds ?? []);
      const server = new Map((result.tasks ?? []).map((task) => [task.taskId, task]));
      const mismatch = tasks.find((task) => {
        const stored = server.get(task.taskId);
        return cancelled.has(task.taskId) || !stored || stored.status !== task.status || stored.masterEventId !== task.masterEventId
          || stored.revision !== task.revision || stored.eventRevision !== task.eventRevision || stored.aoiHash !== task.aoiHash;
      });
      if (mismatch) throw new Error(`任务 ${mismatch.taskId} 已取消或服务端状态已变化，请刷新后重试`);
      downloadTasks(tasks, format);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出前复核失败");
    }
  };
  const calculateVisibility = async (task: SatelliteTask) => {
    setVisibility((current) => ({ ...current, [task.taskId]: { state: "loading", windows: [] } }));
    try {
      const response = await fetch("/api/visibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...task, aoi: taskGeometry(task) }) });
      const result = await response.json() as { state?: VisibilityState["state"]; message?: string; windows?: VisibilityWindow[] };
      setVisibility((current) => ({ ...current, [task.taskId]: { state: result.state ?? (response.ok ? "ready" : "error"), message: result.message, windows: result.windows ?? [] } }));
    } catch {
      setVisibility((current) => ({ ...current, [task.taskId]: { state: "error", message: "无法连接可见性计算接口", windows: [] } }));
    }
  };
  return <aside ref={panelRef} className="task-panel" role="dialog" aria-modal="true" aria-labelledby="task-panel-title">
    <div className="task-panel-heading">
      <div><span>仿真系统输入</span><h2 id="task-panel-title">卫星任务候选单 <b>{tasks.length}</b></h2><p>业务数据库 + 本机离线缓存 · WGS 84</p></div>
      <button ref={closeRef} onClick={onClose} aria-label="关闭卫星任务候选单">×</button>
    </div>
    <div className="task-export-bar">
      <span>导出任务包</span>
      <button disabled={!exportable} title={exportable ? "" : "所有任务需通过校验、选择载荷并同步到业务数据库"} onClick={() => void exportValidated("json")}>JSON</button>
      <button disabled={!exportable} title={exportable ? "" : "所有任务需通过校验、选择载荷并同步到业务数据库"} onClick={() => void exportValidated("csv")}>CSV</button>
      <button disabled={!exportable} title={exportable ? "" : "所有任务需通过校验、选择载荷并同步到业务数据库"} onClick={() => void exportValidated("geojson")}>GeoJSON</button>
    </div>
    {storageMode === "public-read-only" ? <div className="task-storage-banner" role="status"><strong>公网只读模式</strong><span>任务可在本机规划、导入和删除，但不会写入服务器；远程同步需启用 HTTPS 登录和任务权限。</span></div> : storageMode === "unavailable" ? <div className="task-storage-banner warning" role="alert"><strong>任务服务不可用</strong><span>当前修改仅保存在本机，恢复连接后可重试同步。</span></div> : null}
    {!exportable && tasks.length ? <div className="task-export-hint" role="status">当前 {exportableCount}/{tasks.length} 项可导出。任务必须选择载荷、通过时间/AOI校验，并完成数据库同步；逐项错误显示在任务卡内。</div> : null}
    {exportError ? <div className="task-export-error" role="alert">{exportError}</div> : null}
    <div className="task-list">
      {!tasks.length ? <div className="task-empty"><strong>候选单为空</strong><p>从灾害详情中点击“加入卫星任务候选”，即可在这里设置AOI和成像时间窗。</p></div> : null}
      {tasks.map((task, index) => <article className={`task-item ${activeTaskId === task.taskId ? "active" : ""}`} key={task.taskId}>
        <div className="task-item-title">
          <i>{String(index + 1).padStart(2, "0")}</i>
          <div><h3>{task.title}</h3><p>{hazardMeta[task.hazard].label} · 优先级 {task.priority} · {task.observationPhase === "golden" ? "黄金观测期" : "后续观测期"}</p><time>发生时间 · {formatTimeWithYear(task.eventOccurredAt)}</time><button className="show-aoi" onClick={() => onActivate(task.taskId)}>在地图显示 AOI</button></div>
          {canTransitionTask(task.status, "cancelled") ? <button onClick={() => onRemove(task.taskId)} aria-label={`取消${task.title}`}>{task.revision > 0 ? "取消" : "删除草稿"}</button> : null}
        </div>
        <div className="task-coordinates"><span>中心坐标</span><code>{task.latitude.toFixed(6)}, {task.longitude.toFixed(6)}</code><button onClick={() => void copyCoordinates(task).then((copied) => { if (copied) { setCopiedTaskId(task.taskId); window.setTimeout(() => setCopiedTaskId((current) => current === task.taskId ? null : current), 1800); } })}>{copiedTaskId === task.taskId ? "已复制" : "复制"}</button></div>
        <div className={`task-quality ${task.aoiApproval}`}><span>{locationQualityLabels[task.locationQuality]} · ±{task.locationAccuracyKm} km</span><b>{task.aoiApproval === "source_verified" ? "来源可下发" : "已人工核对"}</b><small>{task.evidenceCount} 条证据 · {task.masterEventId}</small></div>
        {task.cycloneForecast ? <div className="task-forecast-summary"><strong>官方预报已随任务保存</strong><span>{task.cycloneForecast.track.length} 个官方中心节点{task.cycloneForecast.impactField ? ` · ${task.cycloneForecast.impactField.frames.length} 个逐时时间片` : ""} · 至 {formatTimeWithYear(task.cycloneForecast.forecastValidUntil)} UTC+08</span><small>{task.cycloneForecast.impactGeometry ? `${task.cycloneForecast.impactThreshold || "官方风圈"}已作为默认来源 AOI` : "本报次没有官方风圈；默认 AOI 仍以当前中心设置"}</small></div> : null}
        <div className={`task-sync ${syncState[task.taskId]?.state ?? "local"}`} role="status">{syncState[task.taskId]?.state === "saving" ? "正在同步…" : syncState[task.taskId]?.state === "synced" ? "已同步到业务数据库" : syncState[task.taskId]?.state === "error" ? <>同步失败：{syncState[task.taskId]?.message ?? "请重试"} <button onClick={() => onRetry(task)}>重试同步</button></> : "仅保存在本机"}</div>
    <div className="aoi-type-selector" aria-label="AOI目标类型">
          {aoiOptions.filter((option) => option.id !== "source" || task.sourceGeometry).map((option) => <button key={option.id} aria-pressed={task.aoiType === option.id} className={task.aoiType === option.id ? "active" : ""} onClick={() => onUpdate(task.taskId, { aoiType: option.id, ...(["polygon", "multi"].includes(option.id) && task.customGeometry?.type !== (option.id === "polygon" ? "Polygon" : "MultiPolygon") ? { customGeometry: undefined } : {}) })}>{option.label}</button>)}
        </div>
        {["polygon", "multi"].includes(task.aoiType) ? <div className="custom-aoi-tools">
          <button onClick={() => onActivate(task.taskId)}>进入地图绘制</button>
          <label>上传 GeoJSON<input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void readCustomAoiFile(file).then((geometry) => {
              setAoiImportError((current) => { const next = { ...current }; delete next[task.taskId]; return next; });
              onUpdate(task.taskId, { aoiType: geometry.type === "Polygon" ? "polygon" : "multi", customGeometry: geometry });
            }).catch((error) => setAoiImportError((current) => ({ ...current, [task.taskId]: error instanceof Error ? error.message : "GeoJSON 导入失败" })));
          }} /></label>
          <span>{task.customGeometry ? `${task.customGeometry.type} · ${customAoiPartCount(task.customGeometry)} 块` : "尚未绘制或导入边界"}</span>
          {aoiImportError[task.taskId] ? <small role="alert">{aoiImportError[task.taskId]}</small> : null}
        </div> : null}
        <div className="task-fields">
          {task.aoiType === "point" ? <label>点目标缓冲（公里，可为0）<input type="number" min="0" max="100" value={task.aoiRadiusKm} onChange={(event) => onUpdate(task.taskId, { aoiRadiusKm: clampNumber(event.target.value, 0, 100) })} /></label> : null}
          {task.aoiType === "circle" ? <label>圆形面半径（公里）<input type="number" min="1" max="1000" value={task.aoiRadiusKm} onChange={(event) => onUpdate(task.taskId, { aoiRadiusKm: clampNumber(event.target.value, 1, 1000) })} /></label> : null}
          {task.aoiType === "rectangle" ? <><label>矩形宽度（公里）<input type="number" min="1" max="2000" value={task.aoiWidthKm} onChange={(event) => onUpdate(task.taskId, { aoiWidthKm: clampNumber(event.target.value, 1, 2000) })} /></label><label>矩形高度（公里）<input type="number" min="1" max="2000" value={task.aoiHeightKm} onChange={(event) => onUpdate(task.taskId, { aoiHeightKm: clampNumber(event.target.value, 1, 2000) })} /></label></> : null}
          {task.aoiType === "corridor" ? <><label>走廊长度（公里）<input type="number" min="1" max="3000" value={task.aoiLengthKm} onChange={(event) => onUpdate(task.taskId, { aoiLengthKm: clampNumber(event.target.value, 1, 3000) })} /></label><label>走廊宽度（公里）<input type="number" min="1" max="500" value={task.aoiWidthKm} onChange={(event) => onUpdate(task.taskId, { aoiWidthKm: clampNumber(event.target.value, 1, 500) })} /></label><label>方位角（度）<input type="number" min="0" max="359" value={task.aoiBearingDeg} onChange={(event) => onUpdate(task.taskId, { aoiBearingDeg: clampNumber(event.target.value, 0, 359) })} /></label></> : null}
          <label>最早成像（Asia/Shanghai UTC+08）<input type="datetime-local" value={toLocalInput(task.imagingStart)} onChange={(event) => onUpdate(task.taskId, { imagingStart: fromLocalInput(event.target.value) })} /></label>
          <label>最晚成像（Asia/Shanghai UTC+08）<input type="datetime-local" min={toLocalInput(task.imagingStart)} value={toLocalInput(task.imagingEnd)} onChange={(event) => onUpdate(task.taskId, { imagingEnd: fromLocalInput(event.target.value) })} /></label>
          <label>任务状态<select value={task.status} onChange={(event) => onUpdate(task.taskId, { status: event.target.value as SatelliteTask["status"] })}>{allowedTaskStatuses(task.status).filter((status) => status !== "cancelled").map((status) => <option key={status} value={status}>{taskStatusLabel(status)}</option>)}</select></label>
          <label>最低覆盖率（%）<input type="number" min="1" max="100" value={task.minimumCoveragePercent} onChange={(event) => onUpdate(task.taskId, { minimumCoveragePercent: clampNumber(event.target.value, 1, 100) })} /></label>
          <label>最大云量（%）<input type="number" min="0" max="100" value={task.maximumCloudPercent} onChange={(event) => onUpdate(task.taskId, { maximumCloudPercent: clampNumber(event.target.value, 0, 100) })} /></label>
          <label>目标分辨率（米）<input type="number" min="0.1" max="10000" step="0.1" value={task.spatialResolutionMeters} onChange={(event) => onUpdate(task.taskId, { spatialResolutionMeters: clampNumber(event.target.value, 0.1, 10000) })} /></label>
          <label>最小入射角（度）<input type="number" min="0" max="80" value={task.incidenceAngleMinDeg} onChange={(event) => onUpdate(task.taskId, { incidenceAngleMinDeg: clampNumber(event.target.value, 0, 80) })} /></label>
          <label>最大入射角（度）<input type="number" min="0" max="80" value={task.incidenceAngleMaxDeg} onChange={(event) => onUpdate(task.taskId, { incidenceAngleMaxDeg: clampNumber(event.target.value, 0, 80) })} /></label>
          <label>重访次数<input type="number" min="1" max="50" value={task.revisitCount} onChange={(event) => onUpdate(task.taskId, { revisitCount: clampNumber(event.target.value, 1, 50) })} /></label>
          <label>最迟交付（Asia/Shanghai UTC+08）<input type="datetime-local" min={toLocalInput(task.imagingEnd)} value={toLocalInput(task.deliveryDeadline)} onChange={(event) => onUpdate(task.taskId, { deliveryDeadline: fromLocalInput(event.target.value) })} /></label>
        </div>
        <fieldset className="payload-options"><legend>载荷选项（可多选）</legend>{payloadOptions.map((payload) => <label key={payload}><input type="checkbox" checked={task.sensors.includes(payload)} onChange={() => onUpdate(task.taskId, { sensors: toggleValue(task.sensors, payload) })} />{payload}</label>)}</fieldset>
        <div className="task-targets">观测目标：{task.observationTargets.join(" · ")}</div>
        {(() => { const validation = validateSatelliteTask(task as unknown as Record<string, unknown>, { requireApproved: true, requirePayload: true, requireProvenance: true }); return validation.ok ? null : <div className="task-validation" role="alert">{validation.errors.join("；")}</div>; })()}
        <div className={`visibility-box ${visibility[task.taskId]?.state ?? "idle"}`}>
          <button onClick={() => void calculateVisibility(task)} disabled={visibility[task.taskId]?.state === "loading"}>{visibility[task.taskId]?.state === "loading" ? "正在请求仿真…" : "计算卫星可见窗口"}</button>
          {visibility[task.taskId]?.message ? <p>{visibility[task.taskId].message}</p> : null}
          {visibility[task.taskId]?.windows.map((window, windowIndex) => <div key={`${window.start}-${windowIndex}`}><strong>{window.satelliteId || `窗口 ${windowIndex + 1}`}</strong><span>{formatTimeWithYear(window.start)} — {formatTimeWithYear(window.end)}</span><small>{window.coveragePercent == null ? "覆盖率待仿真服务返回" : `覆盖 ${window.coveragePercent}%`}{window.lookAngleDeg == null ? "" : ` · 侧摆 ${window.lookAngleDeg}°`}</small></div>)}
        </div>
      </article>)}
    </div>
    <footer>导出字段包括灾害发生时间、任务时间窗、WGS 84坐标、多类型AOI、台风官方路径/风圈、载荷、目标、优先级与权威来源。</footer>
  </aside>;
}

function ObservationPolicy() {
  return <details className="window-policy">
    <summary>观测阶段规则 <span>黄金期 → 后续期 → 历史库</span></summary>
    <div>
      {Object.entries(observationWindowPolicy).map(([id, policy]) => (
        <p key={id}><b>{hazardMeta[id as HazardType].label}</b><span>{policy.label}</span><small>{policy.rationale}</small></p>
      ))}
      <em>表内为黄金期 / 后续期；红、橙、黄事件的后续期兜底上限分别 ×1.5 / ×1.25 / ×1.1。时效得分独立参与排序。</em>
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
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1_440)}天前`;
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

function createSatelliteTask(event: DisasterEvent, operatorConfirmed: boolean): SatelliteTask {
  if (event.dispatchEligibility !== "ready" && !operatorConfirmed) throw new Error("AOI 尚未完成人工核对");
  const now = Date.now();
  const phaseEnd = new Date(event.observationPhase === "golden" ? event.observationReviewAt : event.observationExpiresAt).getTime();
  const preferredEnd = Math.min(phaseEnd, now + (event.observationPhase === "golden" ? 72 : 168) * 3_600_000);
  const officialImpactGeometry = event.cycloneForecast?.impactGeometry;
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
    aoiType: event.dispatchEligibility === "ready" || officialImpactGeometry || event.geometryType !== "Point" ? "source" : "circle",
    aoiRadiusKm: defaultAoiRadiusKm[event.hazard],
    aoiWidthKm: Math.max(10, defaultAoiRadiusKm[event.hazard] * 2),
    aoiHeightKm: Math.max(10, defaultAoiRadiusKm[event.hazard] * 2),
    aoiLengthKm: Math.max(20, defaultAoiRadiusKm[event.hazard] * 3),
    aoiBearingDeg: 0,
    sourceGeometry,
    cycloneForecast: event.cycloneForecast,
    minimumCoveragePercent: 80,
    maximumCloudPercent: 30,
    spatialResolutionMeters: 10,
    incidenceAngleMinDeg: 20,
    incidenceAngleMaxDeg: 45,
    revisitCount: 1,
    imagingStart: new Date(now).toISOString(),
    imagingEnd: new Date(Math.max(now + 3_600_000, preferredEnd)).toISOString(),
    deliveryDeadline: new Date(Math.max(now + 7_200_000, preferredEnd + 24 * 3_600_000)).toISOString(),
    sensors: [],
    observationTargets: event.observationTargets,
    observationPhase: event.observationPhase,
    source: event.source,
    sourceUrl: event.sourceUrl,
    locationQuality: event.locationQuality,
    locationAccuracyKm: event.locationAccuracyKm,
    evidenceCount: event.evidenceCount,
    aoiApproval: event.dispatchEligibility === "ready" ? "source_verified" : "operator_confirmed",
    approvedAt: new Date(now).toISOString(),
    approvedBy: event.dispatchEligibility === "ready" ? event.source : "当前操作员",
    approvalReason: event.dispatchEligibility === "ready" ? undefined : "已在事件详情地图核对来源几何、位置误差和观测目标",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    status: "candidate",
    revision: 0,
    eventRevision: eventRevisionFingerprint(event),
    aoiHash: "",
  };
  return { ...task, aoiHash: aoiFingerprint(taskGeometry(task)) };
}

function downloadTasks(tasks: SatelliteTask[], format: ExportFormat) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let content: string;
  let mime: string;

  if (format === "geojson") {
    content = JSON.stringify({
      type: "FeatureCollection",
      name: "tianxun_satellite_task_candidates",
      features: tasks.map((task) => ({
        type: "Feature",
        id: task.taskId,
        geometry: taskGeometry(task),
        properties: { ...task, centerLongitude: task.longitude, centerLatitude: task.latitude, longitude: undefined, latitude: undefined },
      })),
    }, null, 2);
    mime = "application/geo+json;charset=utf-8";
  } else if (format === "csv") {
    const rows = tasks.map((task) => ({
      task_id: task.taskId,
      event_id: task.eventId,
      master_event_id: task.masterEventId,
      entity_key: task.entityKey,
      title: task.title,
      hazard: task.hazard,
      priority: task.priority,
      latitude_wgs84: task.latitude,
      longitude_wgs84: task.longitude,
      event_occurred_at_utc: task.eventOccurredAt,
      event_updated_at_utc: task.eventUpdatedAt,
      task_revision: task.revision,
      event_revision: task.eventRevision,
      aoi_hash: task.aoiHash,
      aoi_type: task.aoiType,
      aoi_radius_km: task.aoiRadiusKm,
      aoi_width_km: task.aoiWidthKm,
      aoi_height_km: task.aoiHeightKm,
      aoi_length_km: task.aoiLengthKm,
      aoi_bearing_deg: task.aoiBearingDeg,
      aoi_geojson: JSON.stringify(taskGeometry(task)),
      imaging_start_utc: task.imagingStart,
      imaging_end_utc: task.imagingEnd,
      delivery_deadline_utc: task.deliveryDeadline,
      minimum_coverage_percent: task.minimumCoveragePercent,
      maximum_cloud_percent: task.maximumCloudPercent,
      spatial_resolution_meters: task.spatialResolutionMeters,
      incidence_angle_min_deg: task.incidenceAngleMinDeg,
      incidence_angle_max_deg: task.incidenceAngleMaxDeg,
      revisit_count: task.revisitCount,
      sensors: task.sensors.join("|"),
      observation_targets: task.observationTargets.join("|"),
      observation_phase: task.observationPhase,
      source: task.source,
      source_url: task.sourceUrl,
      status: task.status,
      location_quality: task.locationQuality,
      location_accuracy_km: task.locationAccuracyKm,
      evidence_count: task.evidenceCount,
      aoi_approval: task.aoiApproval,
      cyclone_forecast_source: task.cycloneForecast?.source ?? "",
      cyclone_forecast_issued_at_utc: task.cycloneForecast?.issuedAt ?? "",
      cyclone_forecast_valid_until_utc: task.cycloneForecast?.forecastValidUntil ?? "",
      cyclone_forecast_point_count: task.cycloneForecast?.track.length ?? 0,
      cyclone_impact_frame_count: task.cycloneForecast?.impactField?.frames.length ?? 0,
      cyclone_impact_temporal_resolution_hours: task.cycloneForecast?.impactField?.temporalResolutionHours ?? "",
      cyclone_impact_basis: task.cycloneForecast?.impactBasis ?? "",
      cyclone_impact_threshold: task.cycloneForecast?.impactThreshold ?? "",
      cyclone_forecast_url: task.cycloneForecast?.sourceUrl ?? "",
    }));
    const headers = Object.keys(rows[0] ?? {});
    content = `\uFEFF${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(",")).join("\n")}`;
    mime = "text/csv;charset=utf-8";
  } else {
    content = JSON.stringify({
      schema: "tianxun.satellite-task-candidates/v2",
      generatedAt: new Date().toISOString(),
      coordinateReferenceSystem: "WGS84（经度、纬度分别存储；GeoJSON使用CRS84 [longitude, latitude]）",
      count: tasks.length,
      tasks,
    }, null, 2);
    mime = "application/json;charset=utf-8";
  }

  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tianxun-satellite-tasks-${timestamp}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function migrateSatelliteTask(task: Partial<SatelliteTask>): SatelliteTask {
  const hazard = task.hazard ?? "earthquake";
  const radius = task.aoiRadiusKm ?? defaultAoiRadiusKm[hazard];
  const now = new Date().toISOString();
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
    aoiType: task.aoiType ?? "circle",
    aoiRadiusKm: radius,
    aoiWidthKm: task.aoiWidthKm ?? Math.max(10, radius * 2),
    aoiHeightKm: task.aoiHeightKm ?? Math.max(10, radius * 2),
    aoiLengthKm: task.aoiLengthKm ?? Math.max(20, radius * 3),
    aoiBearingDeg: task.aoiBearingDeg ?? 0,
    sourceGeometry: task.sourceGeometry,
    customGeometry: task.customGeometry,
    cycloneForecast: task.cycloneForecast,
    minimumCoveragePercent: task.minimumCoveragePercent ?? 80,
    maximumCloudPercent: task.maximumCloudPercent ?? 30,
    spatialResolutionMeters: task.spatialResolutionMeters ?? 10,
    incidenceAngleMinDeg: task.incidenceAngleMinDeg ?? 20,
    incidenceAngleMaxDeg: task.incidenceAngleMaxDeg ?? 45,
    revisitCount: task.revisitCount ?? 1,
    imagingStart: task.imagingStart ?? now,
    imagingEnd: task.imagingEnd ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
    deliveryDeadline: task.deliveryDeadline ?? new Date(Date.now() + 48 * 3_600_000).toISOString(),
    sensors: (task.sensors ?? []).filter((sensor) => payloadOptions.includes(sensor)),
    observationTargets: task.observationTargets ?? [],
    observationPhase: task.observationPhase ?? "golden",
    source: task.source ?? "未知来源",
    sourceUrl: task.sourceUrl ?? "#",
    locationQuality: task.locationQuality ?? "unknown",
    locationAccuracyKm: task.locationAccuracyKm ?? 100,
    evidenceCount: task.evidenceCount ?? 1,
    aoiApproval: task.aoiApproval ?? "operator_confirmed",
    approvedAt: task.approvedAt,
    approvedBy: task.approvedBy,
    createdAt: task.createdAt ?? now,
    updatedAt: task.updatedAt ?? task.createdAt ?? now,
    status: task.status ?? "candidate",
    revision: Number.isInteger(task.revision) && Number(task.revision) >= 0 ? Number(task.revision) : 0,
    eventRevision: task.eventRevision ?? "0000000000000000",
    aoiHash: task.aoiHash ?? "0000000000000000",
    approvalReason: task.approvalReason,
  };
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

function csvCell(value: string | number) {
  const raw = String(value);
  const text = /^[=+@]/.test(raw) || /^-\D/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function customAoiPolygonParts(geometry: CustomAoiGeometry | undefined): number[][][][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  return geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
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
  return ({ candidate: "候选", reviewed: "已复核", scheduled: "已排程", submitted: "已下发", acquired: "已成像", completed: "已完成", failed: "失败", cancelled: "已取消" } as const)[status];
}
