"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hazardMeta, type HazardType } from "../lib/disasters";
import type { DetectionEvaluationReport, EvaluationBenchmarkCase } from "../lib/evaluation-center";

type EvaluationPayload = { cases: EvaluationBenchmarkCase[]; runs: DetectionEvaluationReport[]; latest: DetectionEvaluationReport | null; error?: string };
type EvaluationForm = {
  title: string;
  hazard: HazardType;
  occurredAt: string;
  latitude: string;
  longitude: string;
  locationToleranceKm: string;
  eventTimeToleranceHours: string;
  acceptedLeadMinutes: string;
  detectionDeadlineMinutes: string;
  expectedSeverity: "" | "blue" | "yellow" | "orange" | "red";
  requiredSource: string;
  provenanceUrl: string;
  notes: string;
  verificationStatus: "verified" | "draft";
};

const hazardOrder: HazardType[] = ["earthquake", "tsunami", "wildfire", "flood", "cyclone", "volcano", "landslide", "drought", "dust", "ice"];
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
  const [form, setForm] = useState<EvaluationForm>(() => initialForm("earthquake"));
  const report = payload.latest;

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
          },
        }),
      });
      const result = await response.json() as { case?: EvaluationBenchmarkCase; error?: string };
      if (!response.ok || !result.case) throw new Error(result.error || "评测样本保存失败");
      setForm(initialForm(form.hazard));
      await load();
      setMessage("评测样本已保存；需要重新运行评测才会进入最新结果。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "评测样本保存失败");
    }
  };

  const runEvaluation = async () => {
    setState("running");
    setMessage("");
    try {
      const response = await fetch("/api/evaluation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
      const result = await response.json() as { report?: DetectionEvaluationReport; error?: string };
      if (!response.ok || !result.report) throw new Error(result.error || "评测运行失败");
      const completedReport = result.report;
      setPayload((current) => ({ ...current, latest: completedReport, runs: [completedReport, ...current.runs.filter((item) => item.runId !== completedReport.runId)].slice(0, 10) }));
      setState("idle");
      setMessage("评测完成。漏报只在历史快照覆盖完整时判定。");
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
        <p>非穷举样本库只能计算已核验事件召回率，不能计算误报率。历史有缺口时标记“历史不足”，不会冒充漏报。</p>
      </section>

      {state === "loading" && !payload.cases.length ? <div className="evaluation-empty">正在读取评测资料…</div> : null}
      {message ? <div className={`evaluation-message ${state === "error" ? "error" : ""}`} role={state === "error" ? "alert" : "status"}>{message}</div> : null}

      <section className="evaluation-summary">
        <div className="evaluation-section-title"><div><span>最近一次运行</span><strong>{report ? formatDateTime(report.computedAt) : "尚未运行"}</strong></div>{role === "admin" ? <button type="button" onClick={() => void runEvaluation()} disabled={state === "running" || state === "saving" || !payload.cases.length}>{state === "running" ? "正在计算…" : "运行评测"}</button> : null}</div>
        <div className="evaluation-metrics">
          <Metric label="已核验样本" value={report?.metrics.verifiedCases ?? payload.cases.filter((item) => item.verificationStatus === "verified").length} detail={`${payload.cases.length} 个样本记录`} />
          <Metric label="检测召回率" value={percent(report?.metrics.recallPercent)} detail={report ? `${report.metrics.detectedCases}/${report.metrics.eligibleCases} 按时发现` : "等待评测"} />
          <Metric label="时延中位数" value={minutes(report?.metrics.medianLatencyMinutes)} detail={report?.metrics.p95LatencyMinutes === null || report?.metrics.p95LatencyMinutes === undefined ? "暂无 P95" : `P95 ${minutes(report.metrics.p95LatencyMinutes)}`} />
          <Metric label="位置误差中位数" value={distance(report?.metrics.medianLocationErrorKm)} detail="按样本代表点计算" />
        </div>
        {report ? <div className="evaluation-coverage">
          <span>历史覆盖</span><strong>{report.coverage.snapshotCount} 个快照</strong><small>{report.coverage.firstSnapshotAt ? `${formatDateTime(report.coverage.firstSnapshotAt)} — ${formatDateTime(report.coverage.lastSnapshotAt!)}` : "暂无快照"}</small><b className={(report.coverage.maximumGapMinutes ?? 0) > report.coverage.gapToleranceMinutes ? "warn" : ""}>最大间隔 {report.coverage.maximumGapMinutes === null ? "—" : minutes(report.coverage.maximumGapMinutes)}</b>
        </div> : null}
      </section>

      <section className="evaluation-results">
        <div className="evaluation-section-title"><div><span>逐项结果</span><strong>{report ? `${report.results.length} 项` : "运行后显示"}</strong></div></div>
        {!report ? <div className="evaluation-empty">录入权威样本后运行评测，系统会回查保存的历史快照。</div> : report.results.map((result) => <article key={result.caseId} className={`evaluation-result ${result.status}`}>
          <div><b>{resultStatus(result.status)}</b><strong>{result.title}</strong><small>{hazardMeta[result.hazard].label} · 截止 {formatDateTime(result.expectedBy)}</small></div>
          <p>{result.reason}</p>
          {result.status === "detected" ? <dl><div><dt>发现时延</dt><dd>{minutes(result.latencyMinutes!)}</dd></div><div><dt>位置误差</dt><dd>{distance(result.locationErrorKm!)}</dd></div><div><dt>匹配事件</dt><dd>{result.matchedTitle}</dd></div>{result.expectedSeverity ? <div><dt>等级核对</dt><dd>{result.severityMet ? "达到" : "未达到"} · {result.detectedSeverity}</dd></div> : null}</dl> : null}
        </article>)}
      </section>

      <section className="evaluation-source-reliability">
        <div className="evaluation-section-title"><div><span>抓取链路</span><strong>{report ? `${report.sourceReliability.length} 个来源有记录` : "等待评测"}</strong></div></div>
        {!report ? <div className="evaluation-empty">运行评测后显示同一历史区间内的来源抓取稳定性。</div> : worstSources.length ? worstSources.map((source) => <div key={source.sourceId}><span><strong>{source.name}</strong><small>{source.successfulAttempts}/{source.attempts} 次成功 · 平均 {source.averageDurationMs} ms</small></span><b>{source.successRatePercent}%</b></div>) : <p className="evaluation-good">有记录且至少抓取两次的来源在本评测区间内均成功。</p>}
        <small className="evaluation-source-note">抓取成功率不是灾害召回率，也不证明上游公告没有延迟。</small>
      </section>

      <section className="evaluation-cases">
        <div className="evaluation-section-title"><div><span>权威基准库</span><strong>{payload.cases.length} 个样本</strong></div></div>
        {payload.cases.length ? payload.cases.map((benchmark) => <article key={benchmark.caseId}>
          <div><span className={benchmark.verificationStatus}>{benchmark.verificationStatus === "verified" ? "已核验" : "草稿"}</span><strong>{benchmark.title}</strong><small>{hazardMeta[benchmark.hazard].label} · {formatDateTime(benchmark.occurredAt)} · 容差 {benchmark.locationToleranceKm} km / {benchmark.eventTimeToleranceHours} h</small></div>
          <a href={benchmark.provenanceUrl} target="_blank" rel="noreferrer">权威依据 ↗</a>
          {role === "admin" ? <button type="button" onClick={() => void removeCase(benchmark)} disabled={state === "saving"}>删除</button> : null}
        </article>) : <div className="evaluation-empty">暂无基准样本。样本必须来自可追溯的权威公告或核验目录。</div>}
      </section>

      {role === "admin" ? <details className="evaluation-create">
        <summary>录入权威核验样本</summary>
        <form onSubmit={createCase}>
          <label className="wide">样本名称<input required maxLength={160} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="例如：四川长宁县 M4.7 地震" /></label>
          <label>灾种<select value={form.hazard} onChange={(event) => setHazard(event.target.value as HazardType)}>{hazardOrder.map((hazard) => <option key={hazard} value={hazard}>{hazardMeta[hazard].label}</option>)}</select></label>
          <label>发生时间<input required type="datetime-local" max={localDateTime(new Date())} value={form.occurredAt} onChange={(event) => setForm((current) => ({ ...current, occurredAt: event.target.value }))} /></label>
          <label>纬度<input required type="number" min="-90" max="90" step="0.0001" value={form.latitude} onChange={(event) => setForm((current) => ({ ...current, latitude: event.target.value }))} /></label>
          <label>经度<input required type="number" min="-180" max="180" step="0.0001" value={form.longitude} onChange={(event) => setForm((current) => ({ ...current, longitude: event.target.value }))} /></label>
          <label className="wide">权威来源链接<input required type="url" maxLength={1500} value={form.provenanceUrl} onChange={(event) => setForm((current) => ({ ...current, provenanceUrl: event.target.value }))} placeholder="https://…" /></label>
          <label>期望等级<select value={form.expectedSeverity} onChange={(event) => setForm((current) => ({ ...current, expectedSeverity: event.target.value as EvaluationForm["expectedSeverity"] }))}><option value="">不核对等级</option><option value="blue">蓝色</option><option value="yellow">黄色</option><option value="orange">橙色</option><option value="red">红色</option></select></label>
          <label>指定来源<input maxLength={120} value={form.requiredSource} onChange={(event) => setForm((current) => ({ ...current, requiredSource: event.target.value }))} placeholder="留空表示任一来源" /></label>
          <details className="wide evaluation-criteria"><summary>匹配与时效口径</summary><div>
            <label>位置容差 km<input required type="number" min="0.1" max="1000" step="0.1" value={form.locationToleranceKm} onChange={(event) => setForm((current) => ({ ...current, locationToleranceKm: event.target.value }))} /></label>
            <label>事件时间容差 h<input required type="number" min="0.1" max="168" step="0.1" value={form.eventTimeToleranceHours} onChange={(event) => setForm((current) => ({ ...current, eventTimeToleranceHours: event.target.value }))} /></label>
            <label>允许提前发现 min<input required type="number" min="0" max="10080" step="1" value={form.acceptedLeadMinutes} onChange={(event) => setForm((current) => ({ ...current, acceptedLeadMinutes: event.target.value }))} /></label>
            <label>检测时限 min<input required type="number" min="1" max="10080" step="1" value={form.detectionDeadlineMinutes} onChange={(event) => setForm((current) => ({ ...current, detectionDeadlineMinutes: event.target.value }))} /></label>
          </div><p>默认值按灾种用于第一轮验收，正式结论前应根据官方公告时效和来源更新频率校准。</p></details>
          <label className="wide">备注<textarea maxLength={500} rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="记录公告编号、核验说明或特殊匹配口径" /></label>
          <label className="evaluation-verification wide"><input type="checkbox" checked={form.verificationStatus === "verified"} onChange={(event) => setForm((current) => ({ ...current, verificationStatus: event.target.checked ? "verified" : "draft" }))} />我已核对事件、时间、坐标和来源；该样本可进入正式指标</label>
          <button className="evaluation-save" type="submit" disabled={state === "saving"}>{state === "saving" ? "保存中…" : "保存评测样本"}</button>
        </form>
      </details> : <p className="evaluation-readonly">当前身份可查看评测结果；只有管理员可以维护基准样本和运行新评测。</p>}

      {report ? <details className="evaluation-limitations"><summary>查看统计口径与限制</summary>{report.limitations.map((item) => <p key={item}>{item}</p>)}</details> : null}
    </div>
    <footer>评测模型 {report?.modelVersion ?? "tianxun-detection-evaluation-v1"} · 报告按运行时快照固化，后续样本修改不会改写历史报告。</footer>
  </aside>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function initialForm(hazard: HazardType): EvaluationForm {
  const defaults = defaultCriteria[hazard];
  return {
    title: "", hazard, occurredAt: localDateTime(new Date(Date.now() - 60 * 60_000)), latitude: "", longitude: "",
    locationToleranceKm: String(defaults.locationKm), eventTimeToleranceHours: String(defaults.timeHours),
    acceptedLeadMinutes: String(defaults.acceptedLeadMinutes), detectionDeadlineMinutes: String(defaults.deadlineMinutes),
    expectedSeverity: "", requiredSource: "", provenanceUrl: "", notes: "", verificationStatus: "draft",
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

function minutes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const sign = value < 0 ? "提前 " : "";
  const absolute = Math.abs(value);
  return absolute >= 60 ? `${sign}${Math.round(absolute / 6) / 10} h` : `${sign}${Math.round(absolute * 10) / 10} min`;
}

function distance(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value} km`;
}

function resultStatus(status: DetectionEvaluationReport["results"][number]["status"]) {
  return status === "detected" ? "按时发现" : status === "missed" ? "漏报" : status === "pending" ? "尚未到期" : status === "insufficient_history" ? "历史不足" : "样本草稿";
}
