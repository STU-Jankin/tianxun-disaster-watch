import { canTransitionTask, type TaskStatus } from "./task-contract.ts";

export const executionReceiptStatuses = [
  "scheduled",
  "submitted",
  "cancel_acknowledged",
  "cancel_rejected",
  "acquired",
  "completed",
  "failed",
] as const satisfies readonly TaskStatus[];

export type ExecutionReceiptStatus = (typeof executionReceiptStatuses)[number];

export type MissionExecutionReceipt = {
  receiptId: string;
  taskId: string;
  masterEventId: string;
  owner: string;
  provider: string;
  externalTaskId: string;
  fromStatus: TaskStatus;
  toStatus: ExecutionReceiptStatus;
  taskRevision: number;
  occurredAt: string;
  receivedAt: string;
  actor: string;
  note: string;
  payload: Record<string, unknown>;
};

export type NormalizedExecutionReceiptInput = Omit<MissionExecutionReceipt, "receiptId" | "masterEventId" | "owner" | "fromStatus" | "taskRevision" | "receivedAt" | "actor"> & {
  receiptId?: string;
  expectedRevision: number;
};

export function normalizeExecutionReceiptInput(value: unknown): NormalizedExecutionReceiptInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("执行回执必须是对象");
  const input = value as Record<string, unknown>;
  const taskId = boundedText(input.taskId, 220, "任务 ID", true);
  const provider = boundedText(input.provider, 120, "执行机构", true);
  const externalTaskId = boundedText(input.externalTaskId, 220, "外部任务 ID", true);
  const toStatus = String(input.toStatus ?? "") as ExecutionReceiptStatus;
  if (!executionReceiptStatuses.includes(toStatus)) throw new Error("执行回执状态无效");
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("expectedRevision 必须是正整数");
  const occurredAt = normalizeIso(input.occurredAt, "回执发生时间");
  const receiptId = input.receiptId === undefined ? undefined : boundedText(input.receiptId, 220, "回执 ID", true);
  const note = boundedText(input.note, 1_000, "回执备注", false);
  const payload = normalizePayload(input.payload);
  validateReceiptPayload(toStatus, payload, occurredAt);
  return { receiptId, taskId, provider, externalTaskId, toStatus, expectedRevision, occurredAt, note, payload };
}

export function taskPatchFromExecutionReceipt(current: Record<string, unknown>, input: NormalizedExecutionReceiptInput) {
  const fromStatus = String(current.status ?? "") as TaskStatus;
  if (!canTransitionTask(fromStatus, input.toStatus)) throw new Error(`不允许的任务执行状态转换：${fromStatus} -> ${input.toStatus}`);
  const base = {
    ...current,
    status: input.toStatus,
    executionProvider: input.provider,
    externalTaskId: input.externalTaskId,
    lastExecutionReceiptAt: input.occurredAt,
  };
  if (input.toStatus === "scheduled") return { ...base, scheduledAt: input.occurredAt, scheduleId: textPayload(input.payload, "scheduleId") };
  if (input.toStatus === "submitted") return { ...base, dispatchId: textPayload(input.payload, "dispatchId"), dispatchAcceptedAt: input.occurredAt };
  if (input.toStatus === "cancel_acknowledged") return { ...base, cancellationAcknowledgedAt: input.occurredAt };
  if (input.toStatus === "cancel_rejected") return { ...base, cancellationRejectedAt: input.occurredAt, cancellationRejectionReason: textPayload(input.payload, "reason") };
  if (input.toStatus === "acquired") return { ...base, acquisitionId: textPayload(input.payload, "acquisitionId"), acquiredAt: input.occurredAt };
  if (input.toStatus === "completed") return { ...base, productIds: input.payload.productIds, completedAt: input.occurredAt };
  return { ...base, failedAt: input.occurredAt, failureCode: textPayload(input.payload, "failureCode"), failureReason: textPayload(input.payload, "reason") };
}

function validateReceiptPayload(status: ExecutionReceiptStatus, payload: Record<string, unknown>, occurredAt: string) {
  if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) throw new Error("回执发生时间不能晚于当前时间 5 分钟以上");
  if (status === "scheduled") textPayload(payload, "scheduleId");
  if (status === "submitted") textPayload(payload, "dispatchId");
  if (status === "acquired") textPayload(payload, "acquisitionId");
  if (status === "completed") {
    if (!Array.isArray(payload.productIds) || payload.productIds.length < 1 || payload.productIds.length > 100
      || payload.productIds.some((item) => typeof item !== "string" || !item.trim() || item.length > 220)) throw new Error("完成回执必须包含 1–100 个有效产品 ID");
  }
  if (status === "failed") {
    textPayload(payload, "failureCode");
    textPayload(payload, "reason");
  }
}

function normalizePayload(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回执 payload 必须是对象");
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 32 * 1024) throw new Error("回执 payload 超过 32KB");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function textPayload(payload: Record<string, unknown>, field: string) {
  return boundedText(payload[field], 220, field, true);
}

function boundedText(value: unknown, maximum: number, label: string, required: boolean) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maximum || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new Error(`${label}无效或过长`);
  return normalized;
}

function normalizeIso(value: unknown, label: string) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label}无效`);
  return new Date(parsed).toISOString();
}
