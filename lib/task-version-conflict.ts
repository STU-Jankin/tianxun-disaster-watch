const serverManagedFields = new Set([
  "revision",
  "updatedAt",
  "eventRevision",
  "aoiHash",
  "approvedAt",
  "approvedBy",
]);

export type TaskVersionMerge<T extends Record<string, unknown>> = {
  merged: T;
  conflictingFields: string[];
  hasCommonBase: boolean;
};

/**
 * Rebase operator edits onto the newest persisted task without silently
 * discarding changes made by another tab. Fields changed on only one side are
 * merged automatically; fields changed differently on both sides retain the
 * current tab's value but require an explicit retry from the operator.
 */
export function mergeTaskVersions<T extends Record<string, unknown>>(
  base: T | undefined,
  local: T,
  remote: T,
): TaskVersionMerge<T> {
  const hasCommonBase = Boolean(base && Number(base.revision) === Number(local.revision));
  const merged: Record<string, unknown> = { ...remote };
  const conflictingFields: string[] = [];
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of keys) {
    if (serverManagedFields.has(key)) continue;
    const localValue = local[key];
    const remoteValue = remote[key];
    if (!hasCommonBase) {
      if (!equalValue(localValue, remoteValue)) conflictingFields.push(key);
      assign(merged, key, localValue);
      continue;
    }
    const baseValue = base![key];
    const localChanged = !equalValue(localValue, baseValue);
    const remoteChanged = !equalValue(remoteValue, baseValue);
    if (!localChanged) continue;
    if (!remoteChanged || equalValue(localValue, remoteValue)) {
      assign(merged, key, localValue);
      continue;
    }
    conflictingFields.push(key);
    assign(merged, key, localValue);
  }

  for (const field of serverManagedFields) assign(merged, field, remote[field]);
  return { merged: merged as T, conflictingFields: [...new Set(conflictingFields)].sort(), hasCommonBase };
}

/** True when a persisted version is the result of this tab's superseded write. */
export function sameOperatorTaskContent<T extends Record<string, unknown>>(left: T, right: T): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (serverManagedFields.has(key)) continue;
    if (!equalValue(left[key], right[key])) return false;
  }
  return true;
}

function assign(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function equalValue(left: unknown, right: unknown) {
  return stableValue(left) === stableValue(right);
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}
