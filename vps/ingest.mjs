#!/usr/bin/env node

const endpoint = process.env.TIANXUN_ENGINE_URL || "http://127.0.0.1:3000/api/events";
const token = String(process.env.TIANXUN_VIEWER_TOKEN || process.env.TIANXUN_API_TOKEN || "").trim();

if (token.length < 32) throw new Error("TIANXUN_VIEWER_TOKEN is not configured");

const response = await fetch(endpoint, {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Tianxun-Ingestion-Scheduler/1.0",
  },
  signal: AbortSignal.timeout(90_000),
  cache: "no-store",
});
if (!response.ok) throw new Error(`ingestion HTTP ${response.status}`);
const payload = await response.json();
if (!payload || !Array.isArray(payload.events) || !Array.isArray(payload.sourceStatus)) throw new Error("invalid ingestion payload");
if (payload.fallback) throw new Error("all configured upstream event sources are unavailable");
if (payload.persistenceAvailable === false) throw new Error("operational event persistence is unavailable");

const online = payload.sourceStatus.filter((source) => source?.online).length;
console.log(JSON.stringify({
  status: "ok",
  fetchedAt: payload.fetchedAt,
  events: payload.events.length,
  onlineSources: online,
  totalSources: payload.sourceStatus.length,
  retained: Number(payload.retainedCount || 0),
}));
