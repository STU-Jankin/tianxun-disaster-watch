type OperationalChange = {
  id: string;
  type: string;
  masterEventId: string;
  payload: unknown;
  createdAt: string;
};

const viewerTaskFields = new Set([
  "taskId", "previousStatus", "status", "revision", "cancellationRequestId", "reason",
]);

/** Remove operator-only task metadata while retaining the lifecycle facts used
 * by the read-only alerting service. */
export function changesVisibleToViewer(changes: OperationalChange[]): OperationalChange[] {
  return changes.map((change) => {
    if (!change.type.startsWith("task_")) return change;
    if (!change.payload || typeof change.payload !== "object" || Array.isArray(change.payload)) return { ...change, payload: {} };
    return {
      ...change,
      payload: Object.fromEntries(Object.entries(change.payload).filter(([key]) => viewerTaskFields.has(key))),
    };
  });
}
