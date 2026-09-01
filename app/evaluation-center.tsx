"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hazardMeta, hazardSubtypeLabels, type HazardSubtype, type HazardType } from "../lib/disasters";
import type { DetectionEvaluationReport, EvaluationBenchmarkCase, EvaluationObjective, EvaluationOutcome } from "../lib/evaluation-center";

type EvaluationPayload = {
  cases: EvaluationBenchmarkCase[];
  runs: DetectionEvaluationReport[];
  latest: DetectionEvaluationReport | null;
  forecastArchive?: { productCount: number; firstProductAt: string | null; lastProductAt: string | null; archivedBytes: number };
  officialPilotCatalog?: { catalog: string; datasetUrl: string; targetCount: number; importedCount: number; verificationPolicy: "draft_only"; comparisonModel: string };
  error?: string;
};
type EvaluationForm = {
  title: string;
  hazard: HazardType;
  objective: EvaluationObjective;
  hazardSubtype: HazardSubtype;
  outcome: EvaluationOutcome;
  calibrationGroup: string;
  occurredAt: string;
  latitude: string;
  longitude: string;
  locationToleranceKm: string;
  eventTimeToleranceHours: string;
  acceptedLeadMinutes: string;
  detectionDeadlineMinutes: string;
  expectedSeverity: "" | "blue" | "yellow" | "orange" | "red";
  requiredSource: string;
  minimumForecastRiskPercent: string;
  provenanceUrl: string;
  notes: string;
  verificationStatus: "verified" | "draft";
};

const hazardOrder: HazardType[] = ["earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"];
const landslideSubtypeOrder: HazardSubtype[] = ["landslide", "debris_flow", "rockfall", "slope_failure", "mass_movement"];
const defaultCriteria: Record<HazardType, { locationKm: number; timeHours: number; deadlineMinutes: number; acceptedLeadMinutes: number }> = {
  earthquake: { locationKm: 30, timeHours: 2, deadlineMinutes: 60, acceptedLeadMinutes: 0 },
  tsunami: { locationKm: 100, timeHours: 6, deadlineMinutes: 60, acceptedLeadMinutes: 30 },
  wildfire: { locationKm: 20, timeHours: 12, deadlineMinutes: 180, acceptedLeadMinutes: 0 },
  flood: { locationKm: 80, timeHours: 48, deadlineMinutes: 360, acceptedLeadMinutes: 360 },
  cyclone: { locationKm: 150, timeHours: 72, deadlineMinutes: 120, acceptedLeadMinutes: 1_440 },
  volcano: { locationKm: 50, timeHours: 24, deadlineMinutes: 360, acceptedLeadMinutes: 0 },
  landslide: { locationKm: 30, timeHours: 24, deadlineMinutes: 360, acceptedLeadMinutes: 360 },
  drought: { locationKm: 200, timeHours: 168, deadlineMinutes: 1_440, acceptedLeadMinutes: 1_440 },
  dust: { locationKm: 150, timeHours: 24, deadlineMinutes: 120, acceptedLeadMinutes: 360 },
  ice: { locationKm: 100, timeHours: 72, deadlineMinutes: 720, acceptedLeadMinutes: 720 },
};

export function EvaluationCenter({ open, role, onClose }: { open: boolean; role: "viewer" | "operator" | "admin"; onClose: () => void }) {
  const [payload, setPayload] = useState<EvaluationPayload>({ cases: [], runs: [], latest: null });
  const [state, setState] = useState<"idle" | "loading" | "saving" | "running" | "error">("idle");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<EvaluationForm>(() => initialForm("event_detection", "earthquake"));
  const [historyDays, setHistoryDays] = useState<30 | 90 | 365 | "all">(90);
  const report = payload.latest;
  const calibration = report?.forecastCalibration;

  const load = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      const response = await fetch("/api/evaluation", { cache: "no-store" });
      const result = await response.json() as EvaluationPayload;
      if (!response.ok) throw new Error(result.error || "评测数据读取失败");
      setPayload(result);
      setState("idle");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "评测数据读取失败");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, onClose]);

  const setHazard = (hazard: HazardType) => {
    const defaults = defaultCriteria[hazard];
    setForm((current) => ({
      ...current,
      hazard,
      locationToleranceKm: String(defaults.locationKm),
      eventTimeToleranceHours: String(defaults.timeHours),
      detectionDeadlineMinutes: String(defaults.deadlineMinutes),
      acceptedLeadMinutes: String(defaults.acceptedLeadMinutes),
    }));
  };

  const setObjective = (objective: EvaluationObjective) => {
    setForm(initialForm(objective, objective === "landslide_forecast" ? "landslide" : "earthquake"));
  };

  const createCase = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("saving");
    setMessage("");
    try {
      const occurred = new Date(form.occurredAt);
      if (!Number.isFinite(occurred.getTime())) throw new Error("请填写有效的灾害发生时间");
      const response = await fetch("/api/evaluation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_case",
          case: {
            ...form,
            occurredAt: occurred.toISOString(),
            latitude: Number(form.latitude),
            longitude: Number(form.longitude),
            locationToleranceKm: Number(form.locationToleranceKm),
            eventTimeToleranceHours: Number(form.eventTimeToleranceHours),
            acceptedLeadMinutes: Number(form.acceptedLeadMinutes),
            detectionDeadlineMinutes: Number(form.detectionDeadlineMinutes),
            minimumForecastRiskPercent: form.objective === "landslide_forecast" ? Number(form.minimumForecastRiskPercent) : undefined,
          },
        }),
      });
      const result = await response.json() as { case?: EvaluationBenchmarkCase; error?: string };
      if (!response.ok || !result.case) throw new Error(result.error || "评测样本保存失败");
      setForm(initialForm(form.objective, form.hazard));
      await load();
      setMessage("评测样本已保存；需要重新运行评测才会进入最新结果。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "评测样本保存失败");
    }
  };

  const downloadLandslideTemplate = () => {
    const template = {
      schema: "tianxun.landslide-benchmark/v2",
      generatedAt: new Date().toISOString(),
      note: "事件样本与无事件对照必须使用相同的空间、时间和目录核验口径。verificationStatus 建议先使用 draft，人工复核后再改为 verified。",
      cases: [{
        caseId: `benchmark-${crypto.randomUUID()}`,
        title: "示例：某地经权威核验的泥石流",
        hazardSubtype: "debris_flow",
        outcome: "event",
        calibrationGroup: "西藏-汛期",
        occurredAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        latitude: 29.5,
        longitude: 90.5,
        locationToleranceKm: 20,
        eventTimeToleranceHours: 24,
        acceptedLeadMinutes: 1_440,
        detectionDeadlineMinutes: 60,
        minimumForecastRiskPercent: 80,
        requiredSource: "NASA LHASA",
        provenanceUrl: "https://example.invalid/replace-with-official-source",
        notes: "填写公告编号、发生时间口径和坐标来源。",
        verificationStatus: "draft",
      }, {
        caseId: `benchmark-${crypto.randomUUID()}`,
        title: "示例：同一区域经目录核验无滑坡的对照窗口",
        hazardSubtype: "debris_flow",
        outcome: "no_event",
        calibrationGroup: "西藏-汛期",
        occurredAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        latitude: 29.7,
        longitude: 90.7,
        locationToleranceKm: 20,
        eventTimeToleranceHours: 24,
        acceptedLeadMinutes: 1_440,
        detectionDeadlineMinutes: 60,
        minimumForecastRiskPercent: 80,
        requiredSource: "NASA LHASA",
        provenanceUrl: "https://example.invalid/replace-with-exhaustive-catalogue",
        notes: "填写所查核验目录、区域、开始与结束时间，以及确认无事件的责任人。",
        verificationStatus: "draft",
      }],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "天巡-滑坡泥石流权威样本模板.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importLandslideCases = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setState("saving");
    setMessage("");
    try {
      if (file.size > 48 * 1024) throw new Error("样本文件不能超过 48 KB");
      const parsed = JSON.parse(await file.text()) as { schema?: string; cases?: unknown[] };
      const response = await fetch("/api/evaluation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import_landslide_cases", schema: parsed.schema, cases: parsed.cases }),
      });
      const result = await response.json() as { imported?: number; error?: string };
      if (!response.ok || !result.imported) throw new Error(result.error || "样本导入失败");
      await load();
      setMessage(`已导入 ${result.imported} 条滑坡/泥石流样本；请逐条核验后再运行正式评测。`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "样本导入失败");
    }
  };

  const importOfficialPilot = async () => {
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/evaluation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import_official_landslide_pilot" }),
      });
      const result = await response.json() as { imported?: number; added?: number; refreshed?: number; stats?: { eligibleRows: number; countries: number }; error?: string };
      if (!response.ok || !result.imported) throw new Error(result.error || "官方试验库导入失败");
      await load();
      setMessage(`NASA GLC试验库已导入${result.imported}条草稿：新增${result.added ?? 0}条、刷新${result.refreshed ?? 0}条，覆盖${result.stats?.countries ?? 0}个国家。请逐条核对后再标记为已核验。`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "官方试验库导入失败");
    }
  };

  const runEvaluation = async () => {
    setState("running");
    setMessage("");
    try {
      const response = await fetch("/api/evaluation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", historyDays: historyDays === "all" ? null : historyDays }) });
      const result = await response.json() as { report?: DetectionEvaluationReport; error?: string };
      if (!response.ok || !result.report) throw new Error(result.error || "评测运行失败");
      const completedReport = result.report;
      setPayload((current) => ({ ...current, latest: completedReport, runs: [completedReport, ...current.runs.filter((item) => item.runId !== completedReport.runId)].slice(0, 10) }));
      setState("idle");
      setMessage("评测完成。漏报和正确排除只在对应历史资料覆盖完整时判定。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "评测运行失败");
    }
  };

  const removeCase = async (benchmark: EvaluationBenchmarkCase) => {
    if (!window.confirm(`确认删除评测样本“${benchmark.title}”？历史评测报告不会被改写。`)) return;
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/evaluation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_case", caseId: benchmark.caseId }) });
      const result = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !result.deleted) throw new Error(result.error || "评测样本删除失败");
      await load();
      setMessage("评测样本已删除；已有历史报告仍保留原始结果。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "评测样本删除失败");
    }
  };

  const worstSources = useMemo(() => report?.sourceReliability.filter((item) => item.attempts >= 2 && item.successRatePercent < 100).slice(0, 8) ?? [], [report]);

  return <aside className="evaluation-panel" hidden={!open} aria-hidden={!open || undefined} role="dialog" aria-modal="true" aria-label="系统评测中心">
    <header className="evaluation-heading">
      <div><span>VALIDATION LAB</span><h2>系统评测中心</h2><p>用权威历史样本检查发现时效、漏报、位置误差和抓取稳定性。</p></div>
      <button type="button" onClick={onClose} aria-label="关闭系统评测中心">×</button>
    </header>
    <div className="evaluation-body">
      <section className="evaluation-principle">
        <strong>只报告能够证明的指标</strong>
        <p>事件检测和事前预测分开统计。实时地图只显示高风险区；评测独立保存完整概率栅格，并用同口径事件样本和无事件对照校准阈值。</p>
      </section>

      <section className="evaluation-archive-status">
        <div><span>完整概率归档</span><strong>{payload.forecastArchive?.productCount ?? 0} 期</strong></div>
        <p>{payload.forecastArchive?.lastProductAt ? `最近产品 ${formatDateTime(payload.forecastArchive.lastProductAt)} · ${formatBytes(payload.forecastArchive.archivedBytes)}` : "归档将在下一次成功读取NASA LHASA产品后开始；此前只能验证80%以上实时筛查结果。"}</p>
      </section>

      <section className="evaluation-official-pilot">
        <div className="evaluation-section-title"><div><span>官方历史试验库</span><strong>{payload.officialPilotCatalog?.importedCount ?? 0}/{payload.officialPilotCatalog?.targetCount ?? 20} 条</strong></div>{role === "admin" ? <button type="button" onClick={() => void importOfficialPilot()} disabled={state === "saving" || state === "running"}>{state === "saving" ? "正在处理…" : (payload.officialPilotCatalog?.importedCount ?? 0) >= (payload.officialPilotCatalog?.targetCount ?? 20) ? "重新核对目录" : "导入首批草稿"}</button> : null}</div>
        <p>从 NASA Global Landslide Catalog 在线读取，严格限定降雨诱因、2000—2020年、HTTPS原始来源以及 exact/1 km/5 km 定位精度，再按灾种和国家有界抽样。</p>
        <div className="evaluation-pilot-rules"><span>13 条 landslide</span><span>5 条 mudslide</span><span>2 条 debris flow</span><span>单国最多2条</span><span>同源/同日近邻去重</span><span>全部先标记草稿</span></div>
        <small>类别名称沿用 NASA 原始目录；严格条件下 debris_flow 仅有2条合格记录，因此不为凑数放宽定位或来源要求。目录正样本不自动等同于权威核验，也不会自动生成“无事件”对照；日期级记录以12:00 UTC占位，必须核对原始报道、当地时区和灾种。历史回放还需另行接入NASA LHASA v1栅格。</small>
        <a href={payload.officialPilotCatalog?.datasetUrl ?? "https://data.nasa.gov/dataset/global-landslide-catalog-export"} target="_blank" rel="noreferrer">查看 NASA 官方目录 ↗</a>
      </section>

      {state === "loading" && !payload.cases.length ? <div className="evaluation-empty">正在读取评测资料…</div> : null}
      {message ? <div className={`evaluation-message ${state === "error" ? "error" : ""}`} role={state === "error" ? "alert" : "status"}>{message}</div> : null}

      <section className="evaluation-summary">
        <div className="evaluation-section-title"><div><span>最近一次运行</span><strong>{report ? formatDateTime(report.computedAt) : "尚未运行"}</strong></div>{role === "admin" ? <div className="evaluation-run-tools"><label>历史回放<select value={historyDays} onChange={(event) => setHistoryDays(event.target.value === "all" ? "all" : Number(event.target.value) as 30 | 90 | 365)}><option value="30">30天</option><option value="90">90天</option><option value="365">365天</option><option value="all">全部</option></select></label><button type="button" onClick={() => void runEvaluation()} disabled={state === "running" || state === "saving" || !payload.cases.length}>{state === "running" ? "正在计算…" : "运行评测"}</button></div> : null}</div>
        <div className="evaluation-metrics">
          <Metric label="已核验样本" value={report?.metrics.verifiedCases ?? payload.cases.filter((item) => item.verificationStatus === "verified").length} detail={`${payload.cases.length} 个样本记录`} />
          <Metric label="事件检测召回率" value={percent(report?.metrics.recallPercent)} detail={report ? `${report.metrics.detectionHits ?? 0}/${report.metrics.detectionEligibleCases ?? 0} 按时发现` : "等待评测"} />
          <Metric label="滑坡预测命中率" value={percent(report?.metrics.forecastHitRatePercent)} detail={report ? `${report.metrics.forecastHits ?? 0}/${report.metrics.forecastEligibleCases ?? 0} 事前命中` : "等待评测"} />
          <Metric label="滑坡预测精确率" value={percent(report?.metrics.forecastPrecisionPercent)} detail={report?.metrics.precisionAvailable ? `${report.metrics.forecastFalseAlarms}/${report.metrics.forecastNegativeEligibleCases} 个对照误报` : "需要同口径无事件对照"} />
          <Metric label="Brier 分数" value={decimal(report?.metrics.forecastBrierScore)} detail="越接近0越好；需完整概率" />
          <Metric label="预测提前量中位数" value={minutesAsLead(report?.metrics.medianForecastLeadMinutes)} detail="以系统首次保存预测为准" />
          <Metric label="时延中位数" value={minutes(report?.metrics.medianLatencyMinutes)} detail={report?.metrics.p95LatencyMinutes === null || report?.metrics.p95LatencyMinutes === undefined ? "暂无 P95" : `P95 ${minutes(report.metrics.p95LatencyMinutes)}`} />
          <Metric label="位置误差中位数" value={distance(report?.metrics.medianLocationErrorKm)} detail="按样本代表点计算" />
        </div>
        {report ? <div className="evaluation-coverage">
          <span>历史覆盖</span><strong>{report.coverage.snapshotCount} 个快照</strong><small>{report.coverage.firstSnapshotAt ? `${formatDateTime(report.coverage.firstSnapshotAt)} — ${formatDateTime(report.coverage.lastSnapshotAt!)}` : "暂无快照"}</small><b className={(report.coverage.maximumGapMinutes ?? 0) > report.coverage.gapToleranceMinutes ? "warn" : ""}>最大间隔 {report.coverage.maximumGapMinutes === null ? "—" : minutes(report.coverage.maximumGapMinutes)}</b>
        </div> : null}
      </section>

      <section className="evaluation-calibration">
        <div className="evaluation-section-title"><div><span>滑坡阈值校准</span><strong>{calibration?.recommendedThresholdPercent ? `建议 ${calibration.recommendedThresholdPercent}%` : "暂不推荐阈值"}</strong></div></div>
        {!calibration ? <div className="evaluation-empty">运行新版评测后显示50%–100%阈值扫描和概率可靠性。</div> : <>
          <p className={`evaluation-calibration-status ${calibration.recommendationStatus}`}>{calibration.recommendationReason}</p>
          {calibration.groups?.length ? <div className="evaluation-calibration-groups">{calibration.groups.map((group) => <div key={group.calibrationGroup}><strong>{group.calibrationGroup}</strong><span>{group.positiveCases} 事件 / {group.negativeCases} 对照</span><b>{group.recommendedThresholdPercent ? `${group.recommendedThresholdPercent}%` : "样本不足"}</b></div>)}</div> : null}
          <div className="evaluation-threshold-table" role="table" aria-label="滑坡预测阈值扫描">
            <div role="row"><b>阈值</b><b>精确率</b><b>召回率</b><b>误报率</b><b>F1</b></div>
            {calibration.thresholdScores.map((score) => <div role="row" key={score.thresholdPercent} className={score.thresholdPercent === calibration.recommendedThresholdPercent ? "recommended" : ""}><span>{score.thresholdPercent}%</span><span>{percent(score.precisionPercent)}</span><span>{percent(score.recallPercent)}</span><span>{percent(score.falseAlarmRatePercent)}</span><span>{percent(score.f1Percent)}</span></div>)}
          </div>
          <details className="evaluation-reliability"><summary>查看概率可靠性</summary>{calibration.reliabilityBins.map((bin) => <div key={bin.minimumPercent}><span>{bin.minimumPercent}–{bin.maximumPercent}%</span><small>{bin.sampleCount} 个样本</small><b>预测均值 {percent(bin.meanForecastPercent)} / 实际发生 {percent(bin.observedEventRatePercent)}</b></div>)}</details>
          <small className="evaluation-source-note">只有至少5个已核验事件和5个同口径无事件对照时才给出探索性建议；正式启用仍需独立留出样本复验。</small>
        </>}
      </section>

      <section className="evaluation-results">
        <div className="evaluation-section-title"><div><span>逐项结果</span><strong>{report ? `${report.results.length} 项` : "运行后显示"}</strong></div></div>
        {!report ? <div className="evaluation-empty">录入权威样本后运行评测，系统会回查保存的历史快照。</div> : report.results.map((result) => <article key={result.caseId} className={`evaluation-result ${result.status}`}>
          <div><b>{resultStatus(result.status, result.objective)}</b><strong>{result.title}</strong><small>{result.objective === "landslide_forecast" ? "事前预测" : hazardMeta[result.hazard].label} · {result.objective === "landslide_forecast" ? "最晚有效预测" : "检测截止"} {formatDateTime(result.expectedBy)}</small></div>
          <p>{result.reason}</p>
          {["detected", "false_alarm", "correct_rejection"].includes(result.status) ? <dl>
            <div><dt>{result.objective === "landslide_forecast" ? "预测提前量" : "发现时延"}</dt><dd>{result.objective === "landslide_forecast" ? minutesAsLead(result.forecastLeadMinutes) : minutes(result.latencyMinutes!)}</dd></div>
            <div><dt>{result.objective === "landslide_forecast" ? "空间取值" : "位置误差"}</dt><dd>{result.objective === "landslide_forecast" ? result.spatialMatch === "raster_cell" ? "核验点所在原始概率格" : result.spatialMatch === "geometry_contains" ? "预测面覆盖" : `点容差 · 中心距 ${distance(result.locationErrorKm)}` : distance(result.locationErrorKm!)}</dd></div>
            {result.matchedTitle ? <div><dt>匹配产品</dt><dd>{result.matchedTitle}</dd></div> : null}
            {result.objective === "landslide_forecast" ? <div><dt>风险值</dt><dd>{result.forecastRiskPercent === undefined ? "未提供" : `${result.forecastRiskPercent}%`}</dd></div> : result.expectedSeverity ? <div><dt>等级核对</dt><dd>{result.severityMet ? "达到" : "未达到"} · {result.detectedSeverity}</dd></div> : null}
          </dl> : null}
        </article>)}
      </section>

      <section className="evaluation-source-reliability">
        <div className="evaluation-section-title"><div><span>抓取链路</span><strong>{report ? `${report.sourceReliability.length} 个来源有记录` : "等待评测"}</strong></div></div>
        {!report ? <div className="evaluation-empty">运行评测后显示同一历史区间内的来源抓取稳定性。</div> : worstSources.length ? worstSources.map((source) => <div key={source.sourceId}><span><strong>{source.name}</strong><small>{source.successfulAttempts}/{source.attempts} 次成功 · 平均 {source.averageDurationMs} ms</small></span><b>{source.successRatePercent}%</b></div>) : <p className="evaluation-good">有记录且至少抓取两次的来源在本评测区间内均成功。</p>}
        <small className="evaluation-source-note">抓取成功率不是灾害召回率，也不证明上游公告没有延迟。</small>
      </section>

      <section className="evaluation-cases">
        <div className="evaluation-section-title"><div><span>权威基准库</span><strong>{payload.cases.length} 个样本</strong></div>{role === "admin" ? <div className="evaluation-import-tools"><button type="button" onClick={downloadLandslideTemplate}>下载滑坡模板</button><label>导入 JSON<input type="file" accept="application/json,.json" onChange={(event) => void importLandslideCases(event)} disabled={state === "saving"} /></label></div> : null}</div>
        {payload.cases.length ? payload.cases.map((benchmark) => <article key={benchmark.caseId}>
          <div><span className={benchmark.verificationStatus}>{benchmark.verificationStatus === "verified" ? "已核验" : "草稿"}</span><strong>{benchmark.title}</strong><small>{benchmark.objective === "landslide_forecast" ? `${benchmark.outcome === "no_event" ? "无事件对照" : "真实事件"} · ${benchmark.hazardSubtype ? hazardSubtypeLabels[benchmark.hazardSubtype] : "滑坡"} · ${benchmark.minimumForecastRiskPercent ?? 80}% 起${benchmark.calibrationGroup ? ` · ${benchmark.calibrationGroup}` : ""}` : `${hazardMeta[benchmark.hazard].label}检测`} · {formatDateTime(benchmark.occurredAt)} · {benchmark.objective === "landslide_forecast" ? `提前 ${benchmark.detectionDeadlineMinutes}–${benchmark.acceptedLeadMinutes} min` : `容差 ${benchmark.locationToleranceKm} km / ${benchmark.eventTimeToleranceHours} h`}</small></div>
          <a href={benchmark.provenanceUrl} target="_blank" rel="noreferrer">权威依据 ↗</a>
          {role === "admin" ? <button type="button" onClick={() => void removeCase(benchmark)} disabled={state === "saving"}>删除</button> : null}
        </article>) : <div className="evaluation-empty">暂无基准样本。样本必须来自可追溯的权威公告或核验目录。</div>}
      </section>

      {role === "admin" ? <details className="evaluation-create">
        <summary>录入权威核验样本</summary>
        <form onSubmit={createCase}>
          <label className="wide">评测目标<select value={form.objective} onChange={(event) => setObjective(event.target.value as EvaluationObjective)}><option value="event_detection">已发生事件能否及时发现</option><option value="landslide_forecast">滑坡/泥石流能否事前预测</option></select></label>
          {form.objective === "landslide_forecast" ? <><label>样本结果<select value={form.outcome} onChange={(event) => setForm((current) => ({ ...current, outcome: event.target.value as EvaluationOutcome }))}><option value="event">已发生事件</option><option value="no_event">无事件对照</option></select></label><label>校准分组<input maxLength={80} value={form.calibrationGroup} onChange={(event) => setForm((current) => ({ ...current, calibrationGroup: event.target.value }))} placeholder="例如：西藏-汛期" /></label></> : null}
          <label className="wide">样本名称<input required maxLength={160} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder={form.objective === "landslide_forecast" ? "例如：西藏某县经核验泥石流" : "例如：四川长宁县 M4.7 地震"} /></label>
          {form.objective === "event_detection" ? <label>灾种<select value={form.hazard} onChange={(event) => setHazard(event.target.value as HazardType)}>{hazardOrder.map((hazard) => <option key={hazard} value={hazard}>{hazardMeta[hazard].label}</option>)}</select></label> : <label>灾害子类型<select value={form.hazardSubtype} onChange={(event) => setForm((current) => ({ ...current, hazardSubtype: event.target.value as HazardSubtype }))}>{landslideSubtypeOrder.map((subtype) => <option key={subtype} value={subtype}>{hazardSubtypeLabels[subtype]}</option>)}</select></label>}
          <label>{form.objective === "landslide_forecast" && form.outcome === "no_event" ? "对照窗口结束" : "发生时间"}<input required type="datetime-local" max={localDateTime(new Date())} value={form.occurredAt} onChange={(event) => setForm((current) => ({ ...current, occurredAt: event.target.value }))} /></label>
          <label>纬度<input required type="number" min="-90" max="90" step="0.0001" value={form.latitude} onChange={(event) => setForm((current) => ({ ...current, latitude: event.target.value }))} /></label>
          <label>经度<input required type="number" min="-180" max="180" step="0.0001" value={form.longitude} onChange={(event) => setForm((current) => ({ ...current, longitude: event.target.value }))} /></label>
          <label className="wide">权威来源链接<input required type="url" maxLength={1500} value={form.provenanceUrl} onChange={(event) => setForm((current) => ({ ...current, provenanceUrl: event.target.value }))} placeholder="https://…" /></label>
          {form.objective === "event_detection" ? <label>期望等级<select value={form.expectedSeverity} onChange={(event) => setForm((current) => ({ ...current, expectedSeverity: event.target.value as EvaluationForm["expectedSeverity"] }))}><option value="">不核对等级</option><option value="blue">蓝色</option><option value="yellow">黄色</option><option value="orange">橙色</option><option value="red">红色</option></select></label> : <label>验收阈值 %<input required type="number" min="50" max="100" step="1" value={form.minimumForecastRiskPercent} onChange={(event) => setForm((current) => ({ ...current, minimumForecastRiskPercent: event.target.value }))} /></label>}
          <label>指定来源<input maxLength={120} value={form.requiredSource} onChange={(event) => setForm((current) => ({ ...current, requiredSource: event.target.value }))} placeholder={form.objective === "landslide_forecast" ? "NASA LHASA" : "留空表示任一来源"} /></label>
          <details className="wide evaluation-criteria"><summary>匹配与时效口径</summary><div>
            <label>位置容差 km<input required type="number" min="0.1" max="1000" step="0.1" value={form.locationToleranceKm} onChange={(event) => setForm((current) => ({ ...current, locationToleranceKm: event.target.value }))} /></label>
            {form.objective === "event_detection" ? <label>事件时间容差 h<input required type="number" min="0.1" max="168" step="0.1" value={form.eventTimeToleranceHours} onChange={(event) => setForm((current) => ({ ...current, eventTimeToleranceHours: event.target.value }))} /></label> : null}
            <label>{form.objective === "landslide_forecast" ? "最大预测提前量 min" : "允许提前发现 min"}<input required type="number" min="0" max="10080" step="1" value={form.acceptedLeadMinutes} onChange={(event) => setForm((current) => ({ ...current, acceptedLeadMinutes: event.target.value }))} /></label>
            <label>{form.objective === "landslide_forecast" ? "最小有效提前量 min" : "检测时限 min"}<input required type="number" min={form.objective === "landslide_forecast" ? "0" : "1"} max="10080" step="1" value={form.detectionDeadlineMinutes} onChange={(event) => setForm((current) => ({ ...current, detectionDeadlineMinutes: event.target.value }))} /></label>
          </div><p>{form.objective === "landslide_forecast" ? "命中必须同时满足：系统事前已保存、预测有效期覆盖真实事件时刻、预测面或点容差命中核验位置、风险值达到阈值。" : "默认值按灾种用于第一轮验收，正式结论前应根据官方公告时效和来源更新频率校准。"}</p></details>
          <label className="wide">备注<textarea maxLength={500} rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder={form.outcome === "no_event" ? "必须记录所查核验目录、区域、时间范围和确认无事件的依据" : "记录公告编号、核验说明或特殊匹配口径"} /></label>
          <label className="evaluation-verification wide"><input type="checkbox" checked={form.verificationStatus === "verified"} onChange={(event) => setForm((current) => ({ ...current, verificationStatus: event.target.checked ? "verified" : "draft" }))} />{form.outcome === "no_event" ? "我已按相同目录和时空口径确认该窗口无事件" : "我已核对事件、时间、坐标和来源；该样本可进入正式指标"}</label>
          <button className="evaluation-save" type="submit" disabled={state === "saving"}>{state === "saving" ? "保存中…" : "保存评测样本"}</button>
        </form>
      </details> : <p className="evaluation-readonly">当前身份可查看评测结果；只有管理员可以维护基准样本和运行新评测。</p>}

      {report ? <details className="evaluation-limitations"><summary>查看统计口径与限制</summary>{report.limitations.map((item) => <p key={item}>{item}</p>)}</details> : null}
    </div>
    <footer>评测模型 {report?.modelVersion ?? "tianxun-evaluation-v3"} · 报告按运行时快照固化，后续样本修改不会改写历史报告。</footer>
  </aside>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function initialForm(objective: EvaluationObjective, hazard: HazardType): EvaluationForm {
  const defaults = objective === "landslide_forecast"
    ? { locationKm: 20, timeHours: 24, deadlineMinutes: 60, acceptedLeadMinutes: 1_440 }
    : defaultCriteria[hazard];
  return {
    title: "", hazard, objective, hazardSubtype: "landslide", outcome: "event", calibrationGroup: "", occurredAt: localDateTime(new Date(Date.now() - 60 * 60_000)), latitude: "", longitude: "",
    locationToleranceKm: String(defaults.locationKm), eventTimeToleranceHours: String(defaults.timeHours),
    acceptedLeadMinutes: String(defaults.acceptedLeadMinutes), detectionDeadlineMinutes: String(defaults.deadlineMinutes),
    expectedSeverity: "", requiredSource: objective === "landslide_forecast" ? "NASA LHASA" : "", minimumForecastRiskPercent: "80", provenanceUrl: "", notes: "", verificationStatus: "draft",
  };
}

function localDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function decimal(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(4);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1024 ** 3) return `${Math.round(value / 1024 ** 3 * 10) / 10} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2 * 10) / 10} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function minutes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "提前 " : "";
  const absolute = Math.abs(value);
  return absolute >= 60 ? `${sign}${Math.round(absolute / 6) / 10} h` : `${sign}${Math.round(absolute * 10) / 10} min`;
}

function minutesAsLead(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const absolute = Math.abs(value);
  return absolute >= 60 ? `${Math.round(absolute / 6) / 10} h` : `${Math.round(absolute * 10) / 10} min`;
}

function distance(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value} km`;
}

function resultStatus(status: DetectionEvaluationReport["results"][number]["status"], objective: EvaluationObjective) {
  if (status === "detected") return objective === "landslide_forecast" ? "事前命中" : "按时发现";
  if (status === "missed") return objective === "landslide_forecast" ? "预测未命中" : "漏报";
  if (status === "false_alarm") return "对照误报";
  if (status === "correct_rejection") return "正确排除";
  return status === "pending" ? "尚未到期" : status === "insufficient_history" ? "历史不足" : "样本草稿";
}
