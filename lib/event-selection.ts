import type { DisasterEvent } from "./disasters";

const severityOrder: Record<DisasterEvent["severity"], number> = { blue: 1, yellow: 2, orange: 3, red: 4 };

export function selectFirmsEvents(events: DisasterEvent[], limit: number) {
  if (events.length <= limit) return events;
  const sorted = [...events].sort((a, b) =>
    severityOrder[b.severity] - severityOrder[a.severity]
    || (b.magnitude ?? 0) - (a.magnitude ?? 0)
    || b.confidenceScore - a.confidenceScore
    || +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const selected: DisasterEvent[] = [];
  const selectedIds = new Set<string>();
  const coveredTiles = new Set<string>();
  const add = (event: DisasterEvent) => {
    if (selected.length >= limit || selectedIds.has(event.id)) return;
    selected.push(event);
    selectedIds.add(event.id);
  };
  for (const event of sorted) {
    if (selected.length >= limit) break;
    const tile = `${Math.floor((event.latitude + 90) / 5)},${Math.floor((event.longitude + 180) / 5)}`;
    if (coveredTiles.has(tile)) continue;
    coveredTiles.add(tile);
    add(event);
  }
  for (const event of sorted) add(event);
  return selected;
}
