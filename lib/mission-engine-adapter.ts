import type { MissionPlanningProblem } from "./mission-planning.ts";
import {
  buildExternallySelectedSchedule,
  runSchedulingComparison,
  type SchedulingComparison,
  type SchedulingManualRules,
} from "./mission-scheduler.ts";

export type MissionPlanningEngineState = {
  mode: "external" | "local_fallback" | "local";
  engineId: "or_tools_cp_sat" | "bounded_constraint_search";
  verifiedCapabilities: string[];
  fallbackReason?: string;
};

export type SchedulingComparisonWithEngine = SchedulingComparison & { engine: MissionPlanningEngineState };

export async function runSchedulingComparisonWithAdapter(
  problems: MissionPlanningProblem[],
  options: { transitionBufferSeconds?: number; maxSearchNodes?: number; maxSearchCandidates?: number; manualRules?: unknown } = {},
): Promise<SchedulingComparisonWithEngine> {
  const local = runSchedulingComparison(problems, options);
  const configured = process.env.MISSION_OPTIMIZER_API_URL?.trim();
  if (!configured) return { ...local, engine: { mode: "local", engineId: "bounded_constraint_search", verifiedCapabilities: ["manual_rules", "revisit_count", "same_satellite_time_conflicts"] } };
  try {
    const endpoint = safeServiceUrl(configured);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const token = process.env.MISSION_SERVICE_TOKEN?.trim();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        schemaVersion: "tianxun.optimizer.problem-set/v1",
        problems,
        options: {
          transitionBufferSeconds: local.input.transitionBufferSeconds,
          manualRules: local.manualRules,
          objective: "maximize_tianxun_screening_score",
        },
      }),
      signal: controller.signal,
      redirect: "manual",
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error(`外部优化服务返回 HTTP ${response.status}`);
    const raw = await readLimitedJson(response, 512 * 1024);
    if (raw.schemaVersion !== "tianxun.optimizer.selection/v1") throw new Error("外部优化服务响应版本不受支持");
    const engine = object(raw.engine, "外部优化服务缺少引擎声明");
    if (engine.id !== "or_tools_cp_sat") throw new Error("外部服务未声明 OR-Tools CP-SAT 引擎");
    if (!Array.isArray(raw.selectedOpportunityRefs) || raw.selectedOpportunityRefs.some((item) => typeof item !== "string")) throw new Error("外部优化服务选择结果无效");
    const optimized = buildExternallySelectedSchedule(problems, raw.selectedOpportunityRefs as string[], {
      transitionBufferSeconds: local.input.transitionBufferSeconds,
      manualRules: options.manualRules as SchedulingManualRules | undefined,
      generatedAt: new Date().toISOString(),
      optimality: engine.optimality === "proven" ? "proven" : "bounded",
      nodesEvaluated: Number(engine.nodesEvaluated ?? 0),
    });
    return {
      ...local,
      generatedAt: optimized.generatedAt,
      optimized,
      recommendedAlgorithm: optimized.objectiveScore >= local.greedy.objectiveScore ? "external_or_tools_cp_sat_v1" : "priority_greedy_v1",
      note: "外部 OR-Tools CP-SAT 返回选择后，已在本系统内重新校验机会身份、人工规则、重访次数和同星时间冲突；未登记的工程约束仍不得视为已满足。",
      engine: { mode: "external", engineId: "or_tools_cp_sat", verifiedCapabilities: ["selection_identity", "manual_rules", "revisit_count", "same_satellite_time_conflicts"] },
    };
  } catch (error) {
    return {
      ...local,
      note: `${local.note} 外部 OR-Tools 服务不可用，本轮已明确降级为本地有界搜索。`,
      engine: {
        mode: "local_fallback",
        engineId: "bounded_constraint_search",
        verifiedCapabilities: ["manual_rules", "revisit_count", "same_satellite_time_conflicts"],
        fallbackReason: error instanceof Error ? error.message.slice(0, 500) : "外部优化服务不可用",
      },
    };
  }
}

function safeServiceUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("优化服务 URL 禁止内嵌凭据");
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("优化服务必须使用 HTTPS，回环地址除外");
  return url.toString();
}

async function readLimitedJson(response: Response, maximumBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("优化服务响应超过安全上限");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error("优化服务响应超过安全上限");
  return object(JSON.parse(text), "优化服务响应不是 JSON 对象");
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
