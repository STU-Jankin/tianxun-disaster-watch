import type { DisasterEvent } from "./disasters.ts";
import { assessImpactRisk, type ImpactRiskAssessment } from "./impact-risk.ts";

export const eventReviewStatuses = ["pending", "reviewing", "monitoring", "verified", "rejected", "closed"] as const;
export type EventReviewStatus = (typeof eventReviewStatuses)[number];

export type ReviewRiskInput = { index: number; basis: string };

export type EventReviewRecord = {
  masterEventId: string;
  status: EventReviewStatus;
  assignee: string;
  conclusion: string;
  exposure: ReviewRiskInput | null;
  vulnerability: ReviewRiskInput | null;
  alertAcknowledgedAt: string | null;
  alertAcknowledgedBy: string | null;
  alertAcknowledgedVersion: string | null;
  eventRevision: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

export type EventReviewSummary = EventReviewRecord & {
  stale: boolean;
  alertAcknowledgedCurrent: boolean;
  impactRisk: ImpactRiskAssessment;
};

export type EventReviewHistoryEntry = {
  revision: number;
  actor: string;
  action: string;
  fromStatus: EventReviewStatus | null;
  toStatus: EventReviewStatus;
  changedAt: string;
  snapshot: EventReviewRecord;
};

const transitions: Record<EventReviewStatus, ReadonlySet<EventReviewStatus>> = {
  pending: new Set(["pending", "reviewing", "monitoring", "verified", "rejected"]),
  reviewing: new Set(["reviewing", "pending", "monitoring", "verified", "rejected"]),
  monitoring: new Set(["monitoring", "reviewing", "verified", "rejected", "closed"]),
  verified: new Set(["verified", "reviewing", "monitoring", "closed"]),
  rejected: new Set(["rejected", "reviewing", "closed"]),
  closed: new Set(["closed", "reviewing"]),
};

export function canTransitionEventReview(from: EventReviewStatus | null, to: EventReviewStatus) {
  return from === null ? to !== "closed" : transitions[from].has(to);
}

export function eventAlertVersion(event: Pick<DisasterEvent, "severity" | "sourceSeverity" | "peakSeverity">) {
  return [event.severity, event.sourceSeverity.trim().slice(0, 160), event.peakSeverity ?? event.severity].join("|");
}

export function reviewImpactRisk(event: DisasterEvent, review: EventReviewRecord | null | undefined) {
  return assessImpactRisk({
    ...event,
    exposure: review?.exposure ?? event.exposureAssessment?.riskInput ?? undefined,
    vulnerability: review?.vulnerability ?? undefined,
  });
}

export function summarizeEventReview(event: DisasterEvent, review: EventReviewRecord, currentEventRevision: string): EventReviewSummary {
  const alertVersion = eventAlertVersion(event);
  return {
    ...review,
    stale: review.eventRevision !== currentEventRevision,
    alertAcknowledgedCurrent: Boolean(review.alertAcknowledgedAt && review.alertAcknowledgedVersion === alertVersion),
    impactRisk: reviewImpactRisk(event, review),
  };
}

export function eventReviewStatusLabel(status: EventReviewStatus) {
  return {
    pending: "待研判",
    reviewing: "研判中",
    monitoring: "持续监测",
    verified: "已确认",
    rejected: "已驳回",
    closed: "已结束",
  }[status];
}
