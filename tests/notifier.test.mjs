import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildEventMessage,
  changeNotifications,
  defaultConfig,
  distanceKm,
  runOnce,
  signPayload,
} from "../vps/notifier.mjs";

test("engine API token is forwarded to backend collection requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tianxun-token-"));
  let headers;
  try {
    const tokenConfig = defaultConfig({
      TIANXUN_API_TOKEN: "test-secret",
      TIANXUN_NOTIFY_DB: join(directory, "notifier.sqlite"),
      HERMES_WEBHOOK_SECRET: "webhook-secret",
      BOOTSTRAP_NOTIFY: "false",
    });
    await runOnce(tokenConfig, async (url, options = {}) => {
      if (String(url).includes("api/events")) {
        headers = options.headers;
        return new Response(JSON.stringify({ fallback: false, events: [], sourceStatus: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("ok", { status: 200 });
    });
    assert.equal(headers.Authorization, "Bearer test-secret");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const config = {
  minPriority: 65,
  cycloneMoveKm: 150,
  notifyPhaseTransition: true,
};

function event(overrides = {}) {
  return {
    id: "event-1",
    masterEventId: "ME-event-1",
    entityKey: "cyclone:wp:example",
    title: "示例台风",
    hazard: "cyclone",
    severity: "yellow",
    priority: 60,
    latitude: 20,
    longitude: 120,
    occurredAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T01:00:00.000Z",
    source: "JMA",
    sourceUrl: "https://example.com/event-1",
    evidenceCount: 1,
    updateCount: 1,
    locationQuality: "estimated",
    locationAccuracyKm: 50,
    dispatchEligibility: "review_required",
    observationPhase: "golden",
    observationExpiresAt: "2026-09-12T00:00:00.000Z",
    observationStatus: "actionable",
    scope: "global",
    geometryType: "Point",
    recommendedSensors: ["SAR", "红外"],
    observationTargets: ["台风眼", "外围雨带"],
    aoiApprovalRequired: true,
    ...overrides,
  };
}

test("generic Hermes signature is raw HMAC-SHA256 hex", () => {
  assert.equal(
    signPayload("secret", '{"message":"test"}'),
    "4ea9ef31c1909837f58cfce4def4c79b46fa2a844fa50154bb9e7a480d368513",
  );
});

test("new events below the threshold are silent", () => {
  assert.deepEqual(changeNotifications(null, event(), config), []);
  assert.equal(changeNotifications(null, event({ priority: 70 }), config)[0].type, "new");
});

test("ordinary source updates do not duplicate a continuing process", () => {
  const previous = event();
  const current = event({ updatedAt: "2026-08-12T04:00:00.000Z", updateCount: 2 });
  assert.deepEqual(changeNotifications(previous, current, config), []);
});

test("material upgrades and task-readiness create notifications", () => {
  const previous = event();
  const current = event({
    severity: "orange",
    priority: 70,
    evidenceCount: 2,
    locationQuality: "precise",
    dispatchEligibility: "ready",
    aoiApprovalRequired: false,
  });
  const types = changeNotifications(previous, current, config).map((item) => item.type);
  assert.deepEqual(types, ["severity", "priority", "evidence", "location", "dispatch"]);
});

test("cyclone movement is measured and significant movement is reported", () => {
  assert.ok(distanceKm(20, 120, 22, 120) > 200);
  const changes = changeNotifications(
    event(),
    event({ latitude: 22, updatedAt: "2026-08-12T06:00:00.000Z" }),
    config,
  );
  assert.equal(changes.at(-1).type, "track");
});

test("Feishu message includes task-planning fields and coordinates", () => {
  const message = buildEventMessage(event({ priority: 75 }), "新灾害事件");
  assert.match(message, /20\.00000, 120\.00000/);
  assert.match(message, /AOI 需人工复核/);
  assert.match(message, /SAR \/ 红外/);
  assert.match(message, /发生\/更新/);
  assert.match(message, /事件键/);
});

test("end-to-end baseline is delivered once and only material changes repeat", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "tianxun-notifier-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  let currentEvent = event({ priority: 70 });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/events")) {
      return Response.json({
        events: [currentEvent],
        sourceStatus: [{ name: "JMA", state: "online", online: true }],
        fallback: false,
        fetchedAt: "2026-08-13T00:00:00.000Z",
      });
    }
    sent.push({ body: options.body, signature: options.headers["X-Webhook-Signature"] });
    return Response.json({ status: "delivered" });
  };
  const runtime = {
    ...config,
    dbPath: join(directory, "notifier.sqlite"),
    engineUrl: "http://engine/api/events",
    webhookUrl: "http://hermes/webhooks/tianxun-alerts",
    webhookSecret: "test-secret",
    sourceFailureThreshold: 3,
    maxDeliveryAttempts: 8,
    maxBatchSize: 5,
    requestTimeoutMs: 5000,
    bootstrapNotify: true,
  };

  const baseline = await runOnce(runtime, fetchImpl);
  assert.equal(baseline.delivered, 1);
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(sent[0].body).message, /已建立运行基线/);
  assert.equal(sent[0].signature, signPayload("test-secret", sent[0].body));

  const unchanged = await runOnce(runtime, fetchImpl);
  assert.equal(unchanged.delivered, 0);
  assert.equal(sent.length, 1);

  currentEvent = event({ priority: 76, severity: "orange", updatedAt: "2026-08-13T03:00:00.000Z" });
  const upgraded = await runOnce(runtime, fetchImpl);
  assert.equal(upgraded.delivered, 1);
  assert.equal(sent.length, 2);
  assert.match(JSON.parse(sent[1].body).message, /等级升级/);
});

test("failed Hermes delivery remains queued for retry", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "tianxun-retry-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/events")) {
      return Response.json({
        events: [event({ priority: 75 })],
        sourceStatus: [],
        fallback: false,
        fetchedAt: "2026-08-13T00:00:00.000Z",
      });
    }
    return new Response("delivery unavailable", { status: 502 });
  };
  const result = await runOnce({
    ...config,
    dbPath: join(directory, "notifier.sqlite"),
    engineUrl: "http://engine/api/events",
    webhookUrl: "http://hermes/webhooks/tianxun-alerts",
    webhookSecret: "test-secret",
    sourceFailureThreshold: 3,
    maxDeliveryAttempts: 8,
    maxBatchSize: 5,
    requestTimeoutMs: 5000,
    bootstrapNotify: true,
  }, fetchImpl);
  assert.equal(result.delivered, 0);
  assert.equal(result.pending, 1);
  assert.match(result.error, /Hermes HTTP 502/);
});
