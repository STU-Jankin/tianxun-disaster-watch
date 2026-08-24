import type { DisasterEvent } from "./disasters";

export function applyEventSourcePresence(event: DisasterEvent, presentInCurrentFeeds: boolean): DisasterEvent {
  if (presentInCurrentFeeds) return { ...event, sourcePresence: "current" };
  return {
    ...event,
    sourcePresence: "retained",
    lifecycleStatus: "monitoring",
    dispatchEligibility: event.dispatchEligibility === "ready" ? "review_required" : event.dispatchEligibility,
    aoiApprovalRequired: true,
  };
}
