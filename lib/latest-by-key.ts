/**
 * Retain the newest snapshot for each stable key and return newest first.
 * Invalid timestamps are treated as oldest so a malformed update cannot
 * replace a valid authoritative snapshot.
 */
export function latestByKey<T>(items: Iterable<T>, keyOf: (item: T) => string, timestampOf: (item: T) => number): T[] {
  const newest = new Map<string, { item: T; timestamp: number }>();
  for (const item of items) {
    const timestamp = timestampOf(item);
    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    const key = keyOf(item);
    const current = newest.get(key);
    if (!current || safeTimestamp > current.timestamp) newest.set(key, { item, timestamp: safeTimestamp });
  }
  return [...newest.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .map(({ item }) => item);
}
