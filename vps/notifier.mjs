#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HAZARD_LABELS = {
  earthquake: "地震",
  tsunami: "海啸",
  wildfire: "火灾",
  flood: "洪水",
  cyclone: "气旋/台风",
  volcano: "火山",
  landslide: "滑坡",
  drought: "干旱",
  dust: "沙尘",
  ice: "冰雪",
};

const SEVERITY_LABELS = { red: "红色", orange: "橙色", yellow: "黄色", blue: "蓝色" };
const SEVERITY_EMOJI = { red: "🔴", orange: "🟠", yellow: "🟡", blue: "🔵" };
const LOCATION_LABELS = { precise: "精确", estimated: "估算", representative: "代表点", unknown: "未知" };
const SCOPE_LABELS = { wuxi: "无锡市", jiangsu: "江苏省", china: "中国", global: "全球" };
const PHASE_LABELS = { golden: "黄金观测期", followup: "后续观测期", archive: "已过观测期" };

export function severityRank(value) {
  return { blue: 1, yellow: 2, orange: 3, red: 4 }[value] ?? 0;
}

export function locationRank(value) {
  return { unknown: 0, representative: 1, estimated: 2, precise: 3 }[value] ?? 0;
}

export function distanceKm(latA, lonA, latB, lonB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(Number(latB) - Number(latA));
  const dLon = radians(Number(lonB) - Number(lonA));
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(Number(latA))) * Math.cos(radians(Number(latB))) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function signPayload(secret, body) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function changeNotifications(previous, event, config) {
  const changes = [];
  if (!previous) {
    if (isAlertable(event, config)) changes.push({ type: "new", label: "新灾害事件" });
    return changes;
  }

  if (severityRank(event.severity) > severityRank(previous.severity)) {
    changes.push({ type: "severity", label: `等级升级：${severityLabel(previous.severity)} → ${severityLabel(event.severity)}` });
  }
  if (Number(previous.priority) < config.minPriority && Number(event.priority) >= config.minPriority) {
    changes.push({ type: "priority", label: `优先级升至 ${number(event.priority, 0)}` });
  }
  if (Number(event.evidenceCount) > Number(previous.evidenceCount) && Number(event.priority) >= config.minPriority - 10) {
    changes.push({ type: "evidence", label: `新增独立证据，现有 ${number(event.evidenceCount, 0)} 个来源` });
  }
  if (locationRank(event.locationQuality) > locationRank(previous.locationQuality)) {
    changes.push({ type: "location", label: `定位质量提升：${locationLabel(previous.locationQuality)} → ${locationLabel(event.locationQuality)}` });
  }
  if (previous.dispatchEligibility !== "ready" && event.dispatchEligibility === "ready") {
    changes.push({ type: "dispatch", label: "坐标已达到可直接规划条件" });
  }
  if (event.hazard === "cyclone" && finiteCoordinates(previous) && finiteCoordinates(event)) {
    const moved = distanceKm(previous.latitude, previous.longitude, event.latitude, event.longitude);
    if (moved >= config.cycloneMoveKm && +new Date(event.updatedAt) > +new Date(previous.updatedAt)) {
      changes.push({ type: "track", label: `台风中心移动约 ${Math.round(moved)} km` });
    }
    const previousForecastAt = Date.parse(String(previous.cycloneForecast?.issuedAt ?? ""));
    const forecastAt = Date.parse(String(event.cycloneForecast?.issuedAt ?? ""));
    if (Number.isFinite(forecastAt) && (!Number.isFinite(previousForecastAt) || forecastAt > previousForecastAt) && Number(event.priority) >= config.minPriority - 10) {
      changes.push({ type: "forecast", label: `收到${clean(event.cycloneForecast.source, 60)}新一期官方路径/风圈` });
    }
  }
  if (config.notifyPhaseTransition && previous.observationPhase === "golden" && event.observationPhase === "followup") {
    changes.push({ type: "phase", label: "进入后续观测期" });
  }
  return changes;
}

export function buildEventMessage(event, changeLabel) {
  const coordinate = `${number(event.latitude, 5)}, ${number(event.longitude, 5)}`;
  const accuracy = Number.isFinite(Number(event.locationAccuracyKm)) ? `（约 ±${number(event.locationAccuracyKm, 0)} km）` : "";
  const sourceUrl = safeUrl(event.sourceUrl);
  const source = sourceUrl ? `[${clean(event.source, 120)}](${sourceUrl})` : clean(event.source, 120);
  const sensors = Array.isArray(event.recommendedSensors) && event.recommendedSensors.length
    ? event.recommendedSensors.map((item) => clean(item, 40)).join(" / ")
    : "待卫星系统匹配";
  const targets = Array.isArray(event.observationTargets) && event.observationTargets.length
    ? event.observationTargets.slice(0, 5).map((item) => clean(item, 50)).join("、")
    : "待判定";
  const review = event.aoiApprovalRequired ? "⚠️ AOI 需人工复核" : "✅ AOI 可直接进入仿真规划";
  const forecast = event.hazard === "cyclone" && event.cycloneForecast
    ? `- 官方预报：${clean(event.cycloneForecast.source, 80)} · ${number(event.cycloneForecast.track?.length, 0)} 个中心节点 · 有效至 ${formatTime(event.cycloneForecast.forecastValidUntil)} · ${clean(event.cycloneForecast.impactThreshold || "本报次无官方风圈", 100)}`
    : "";

  return [
    `${SEVERITY_EMOJI[event.severity] ?? "⚪"} **${clean(changeLabel, 160)}｜${clean(event.title, 220)}**`,
    `- 类型/等级：${hazardLabel(event.hazard)} · ${severityLabel(event.severity)} · 优先级 **${number(event.priority, 0)}**`,
    `- 范围/坐标：${SCOPE_LABELS[event.scope] ?? "全球"} · \`${coordinate}\``,
    `- 定位质量：${locationLabel(event.locationQuality)}${accuracy} · ${review}`,
    `- 发生/更新：${formatTime(event.occurredAt)} / ${formatTime(event.updatedAt)}`,
    `- 观测阶段：${PHASE_LABELS[event.observationPhase] ?? clean(event.observationPhase, 40)}，截止 ${formatTime(event.observationExpiresAt)}`,
    `- AOI/目标：${clean(event.geometryType || "Point", 30)} · ${targets}`,
    forecast,
    `- 可选载荷：${sensors}`,
    `- 证据/来源：${number(event.evidenceCount, 0)} 个独立来源，过程更新 ${number(event.updateCount, 0)} 次 · ${source}`,
    `- 事件键：\`${clean(event.entityKey || event.masterEventId || event.id, 180)}\``,
  ].filter(Boolean).join("\n");
}

export function defaultConfig(env = process.env) {
  return {
    engineUrl: env.TIANXUN_ENGINE_URL || "http://127.0.0.1:3000/api/events",
    engineToken: env.TIANXUN_API_TOKEN || "",
    dbPath: resolve(env.TIANXUN_NOTIFY_DB || ".data/notifier.sqlite"),
    webhookUrl: env.HERMES_WEBHOOK_URL || "http://127.0.0.1:8644/webhooks/tianxun-alerts",
    webhookSecret: env.HERMES_WEBHOOK_SECRET || "",
    minPriority: boundedNumber(env.MIN_NOTIFY_PRIORITY, 0, 100, 65),
    cycloneMoveKm: boundedNumber(env.CYCLONE_MOVE_ALERT_KM, 10, 2000, 150),
    sourceFailureThreshold: boundedNumber(env.SOURCE_FAILURE_THRESHOLD, 1, 20, 3),
    maxDeliveryAttempts: boundedNumber(env.MAX_DELIVERY_ATTEMPTS, 1, 30, 8),
    maxBatchSize: boundedNumber(env.MAX_ALERT_BATCH_SIZE, 1, 10, 5),
    requestTimeoutMs: boundedNumber(env.REQUEST_TIMEOUT_MS, 1000, 120000, 45000),
    bootstrapNotify: booleanValue(env.BOOTSTRAP_NOTIFY, true),
    notifyPhaseTransition: booleanValue(env.NOTIFY_PHASE_TRANSITION, true),
  };
}

export async function runOnce(config = defaultConfig(), fetchImpl = fetch) {
  const db = openDatabase(config.dbPath);
  const startedAt = new Date().toISOString();
  try {
    const payload = await fetchEvents(config, fetchImpl);
    processSourceHealth(db, Array.isArray(payload.sourceStatus) ? payload.sourceStatus : [], config);
    if (!payload.fallback) {
      processEvents(db, Array.isArray(payload.events) ? payload.events : [], payload, config);
      setMeta(db, "consecutive_collection_failures", "0");
      recordRun(db, startedAt, "ok", Array.isArray(payload.events) ? payload.events.length : 0, "");
    } else {
      const message = "全部上游源不可用，API 返回了演示回退数据；未更新事件基线。";
      recordCollectionProblem(db, message, config);
      recordRun(db, startedAt, "degraded", 0, message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordCollectionProblem(db, `采集请求失败：${clean(message, 300)}`, config);
    recordRun(db, startedAt, "failed", 0, message);
  }

  const result = await deliverPending(db, config, fetchImpl);
  db.close();
  return result;
}

function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_state (
      entity_key TEXT PRIMARY KEY,
      master_event_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      priority REAL NOT NULL,
      evidence_count INTEGER NOT NULL,
      update_count INTEGER NOT NULL,
      location_quality TEXT NOT NULL,
      dispatch_eligibility TEXT NOT NULL,
      observation_phase TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_queue (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notification_queue_status_idx
      ON notification_queue (status, next_attempt_at, created_at);
    CREATE TABLE IF NOT EXISTS source_state (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      outage_id TEXT NOT NULL DEFAULT '',
      offline_notified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT ''
    );
  `);
  const queueColumns = db.prepare("PRAGMA table_info(notification_queue)").all().map((column) => column.name);
  if (!queueColumns.includes("lease_owner")) db.exec("ALTER TABLE notification_queue ADD COLUMN lease_owner TEXT NOT NULL DEFAULT ''");
  return db;
}

async function fetchEvents(config, fetchImpl) {
  const authorization = config.engineToken ? { Authorization: `Bearer ${config.engineToken}` } : {};
  const response = await fetchImpl(config.engineUrl, {
    headers: { Accept: "application/json", "User-Agent": "Tianxun-VPS-Notifier/1.0", ...authorization },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`灾害引擎 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.events)) throw new Error("灾害引擎响应缺少 events 数组");
  return payload;
}

function processEvents(db, events, payload, config) {
  const initialized = getMeta(db, "events_initialized") === "1";
  const upsert = db.prepare(`INSERT INTO event_state (
    entity_key, master_event_id, severity, priority, evidence_count, update_count,
    location_quality, dispatch_eligibility, observation_phase, latitude, longitude,
    updated_at, payload_json, seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(entity_key) DO UPDATE SET
    master_event_id=excluded.master_event_id, severity=excluded.severity,
    priority=excluded.priority, evidence_count=excluded.evidence_count,
    update_count=excluded.update_count, location_quality=excluded.location_quality,
    dispatch_eligibility=excluded.dispatch_eligibility,
    observation_phase=excluded.observation_phase, latitude=excluded.latitude,
    longitude=excluded.longitude, updated_at=excluded.updated_at,
    payload_json=excluded.payload_json, seen_at=excluded.seen_at`);
  const select = db.prepare("SELECT payload_json FROM event_state WHERE entity_key = ?");
  const now = new Date().toISOString();
  const pending = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events) {
      if (!validEvent(event)) continue;
      const key = eventKey(event);
      const row = select.get(key);
      const previous = row ? safeJson(row.payload_json) : null;
      if (initialized) {
        const changes = changeNotifications(previous, event, config);
        if (changes.length) {
          const version = changes.map((change) => `${change.type}:${changeVersion(event, change.type)}`).sort().join("|");
          pending.push({
            dedupeKey: `${key}:material:${version}`,
            kind: "event_material_change",
            entityKey: key,
            message: buildEventMessage(event, changes.map((change) => change.label).join("；")),
          });
        }
      }
      upsert.run(
        key,
        String(event.masterEventId || event.id || key),
        String(event.severity || "blue"),
        Number(event.priority || 0),
        Number(event.evidenceCount || 0),
        Number(event.updateCount || 0),
        String(event.locationQuality || "unknown"),
        String(event.dispatchEligibility || "review_required"),
        String(event.observationPhase || "golden"),
        Number(event.latitude),
        Number(event.longitude),
        String(event.updatedAt || now),
        JSON.stringify(event),
        now,
      );
    }

    if (!initialized) {
      setMeta(db, "events_initialized", "1");
      if (config.bootstrapNotify) {
        const online = (payload.sourceStatus || []).filter((source) => source.online).length;
        const actionable = events.filter((event) => event.observationStatus === "actionable").length;
        const high = events.filter((event) => isAlertable(event, config)).length;
        pending.push({
          dedupeKey: "system:bootstrap:v1",
          kind: "system_bootstrap",
          entityKey: "system",
          message: [
            "✅ **天巡灾害后台已建立运行基线**",
            `- 当前有效主事件：${actionable} 个`,
            `- 达到通知阈值：${high} 个（基线事件不逐条轰炸）`,
            `- 在线数据源：${online}/${(payload.sourceStatus || []).length}`,
            `- 首次采集：${formatTime(payload.fetchedAt || now)}`,
            "- 后续仅推送新事件、等级升级、证据增强、定位改善、重要台风位移及系统故障。",
          ].join("\n"),
        });
      }
    }
    for (const notification of pending) enqueue(db, notification);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function processSourceHealth(db, sourceStatus, config) {
  const select = db.prepare("SELECT * FROM source_state WHERE name = ?");
  const upsert = db.prepare(`INSERT INTO source_state (name, state, consecutive_failures, outage_id, offline_notified, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET state=excluded.state,
      consecutive_failures=excluded.consecutive_failures, outage_id=excluded.outage_id,
      offline_notified=excluded.offline_notified, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();

  for (const source of sourceStatus) {
    const name = clean(source.name, 160);
    if (!name) continue;
    const previous = select.get(name);
    const state = String(source.state || (source.online ? "online" : "offline"));
    if (state === "needs_config") {
      upsert.run(name, state, 0, "", 0, now);
      continue;
    }
    if (state === "online") {
      if (previous?.offline_notified) {
        enqueue(db, {
          dedupeKey: `source:recovered:${name}:${previous.outage_id}`,
          kind: "source_recovered",
          entityKey: `source:${name}`,
          message: `✅ **数据源恢复：${name}**\n- 状态：重新在线\n- 时间：${formatTime(now)}\n- 说明：灾害引擎已恢复采集，后续事件将正常进入聚合与判定。`,
        });
      }
      upsert.run(name, state, 0, "", 0, now);
      continue;
    }

    const failures = previous?.state === "offline" ? Number(previous.consecutive_failures) + 1 : 1;
    const outageId = previous?.state === "offline" && previous.outage_id ? previous.outage_id : compactTimestamp(now);
    let notified = Number(previous?.offline_notified || 0);
    if (failures >= config.sourceFailureThreshold && !notified) {
      enqueue(db, {
        dedupeKey: `source:offline:${name}:${outageId}`,
        kind: "source_offline",
        entityKey: `source:${name}`,
        message: `⚠️ **数据源连续离线：${name}**\n- 连续失败：${failures} 次\n- 时间：${formatTime(now)}\n- 原因：${clean(source.message || "接口连接失败", 300)}\n- 影响：仅该源暂不可用；系统继续使用其他来源，并等待自动恢复。`,
      });
      notified = 1;
    }
    upsert.run(name, "offline", failures, outageId, notified, now);
  }
}

function recordCollectionProblem(db, message, config) {
  const failures = Number(getMeta(db, "consecutive_collection_failures") || 0) + 1;
  setMeta(db, "consecutive_collection_failures", String(failures));
  if (failures === config.sourceFailureThreshold) {
    enqueue(db, {
      dedupeKey: `system:collection-failure:${compactTimestamp(new Date().toISOString())}`,
      kind: "collection_failure",
      entityKey: "system",
      message: `🚨 **灾害后台连续采集异常**\n- 连续失败：${failures} 次\n- 时间：${formatTime(new Date().toISOString())}\n- 详情：${clean(message, 500)}\n- 处置：通知队列仍保留并重试，需检查引擎日志与 VPS 出站网络。`,
    });
  }
}

async function deliverPending(db, config, fetchImpl) {
  if (!config.webhookSecret) {
    const pending = db.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status IN ('pending', 'retry')").get();
    return { delivered: 0, pending: Number(pending.count), error: "HERMES_WEBHOOK_SECRET 未配置" };
  }
  const nowIso = new Date().toISOString();
  const leaseOwner = createHash("sha256").update(`${nowIso}:${Math.random()}`).digest("hex").slice(0, 24);
  const leaseUntil = new Date(Date.now() + Math.max(60_000, config.requestTimeoutMs * 2)).toISOString();
  let rows = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    rows = db.prepare(`SELECT * FROM notification_queue
      WHERE (status IN ('pending', 'retry') OR (status = 'in_flight' AND next_attempt_at <= ?)) AND next_attempt_at <= ?
      ORDER BY created_at, id LIMIT ?`).all(nowIso, nowIso, config.maxBatchSize);
    const claim = db.prepare("UPDATE notification_queue SET status='in_flight', lease_owner=?, next_attempt_at=? WHERE id=? AND status=?");
    rows = rows.filter((row) => Number(claim.run(leaseOwner, leaseUntil, row.id, row.status).changes) === 1);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!rows.length) return { delivered: 0, pending: 0 };

  const requestId = createHash("sha256").update(rows.map((row) => row.id).join("|")).digest("hex").slice(0, 40);
  const body = JSON.stringify({
    event_type: "tianxun.notification_batch",
    generated_at: new Date().toISOString(),
    alert_count: rows.length,
    message: rows.map((row) => row.message).join("\n\n---\n\n"),
  });
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signPayload(config.webhookSecret, body),
        "X-Request-ID": requestId,
        "User-Agent": "Tianxun-VPS-Notifier/1.0",
      },
      body,
      signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 20000)),
    });
    if (!response.ok) throw new Error(`Hermes HTTP ${response.status}: ${clean(await response.text(), 300)}`);
    const deliveredAt = new Date().toISOString();
    const update = db.prepare("UPDATE notification_queue SET status='delivered', delivered_at=?, last_error='', lease_owner='' WHERE id=? AND lease_owner=?");
    for (const row of rows) update.run(deliveredAt, row.id, leaseOwner);
    setMeta(db, "last_delivery_success_at", deliveredAt);
    return { delivered: rows.length, pending: 0, requestId };
  } catch (error) {
    const update = db.prepare("UPDATE notification_queue SET status=?, attempts=?, next_attempt_at=?, last_error=?, lease_owner='' WHERE id=? AND lease_owner=?");
    const now = Date.now();
    for (const row of rows) {
      const attempts = Number(row.attempts) + 1;
      const status = attempts >= config.maxDeliveryAttempts ? "dead_letter" : "retry";
      const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1) * 5);
      update.run(status, attempts, new Date(now + delayMinutes * 60_000).toISOString(), clean(error instanceof Error ? error.message : error, 500), row.id, leaseOwner);
    }
    return { delivered: 0, pending: rows.length, error: error instanceof Error ? error.message : String(error) };
  }
}

function enqueue(db, notification) {
  const now = new Date().toISOString();
  const id = createHash("sha256").update(notification.dedupeKey).digest("hex").slice(0, 32);
  db.prepare(`INSERT OR IGNORE INTO notification_queue
    (id, dedupe_key, kind, entity_key, message, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
    .run(id, notification.dedupeKey, notification.kind, notification.entityKey, notification.message, now, now);
}

function recordRun(db, startedAt, status, eventCount, error) {
  db.prepare("INSERT INTO collection_runs (started_at, completed_at, status, event_count, error) VALUES (?, ?, ?, ?, ?)")
    .run(startedAt, new Date().toISOString(), status, eventCount, clean(error, 500));
  db.prepare("DELETE FROM collection_runs WHERE id NOT IN (SELECT id FROM collection_runs ORDER BY id DESC LIMIT 1000)").run();
}

function setMeta(db, key, value) {
  db.prepare(`INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

function getMeta(db, key) {
  return db.prepare("SELECT value FROM metadata WHERE key = ?").get(key)?.value;
}

function isAlertable(event, config) {
  if (event.observationStatus === "expired" || event.dispatchEligibility === "blocked") return false;
  return Number(event.priority) >= config.minPriority || ["red", "orange"].includes(event.severity);
}

function validEvent(event) {
  return event && finiteCoordinates(event) && eventKey(event);
}

function finiteCoordinates(event) {
  return Number.isFinite(Number(event?.latitude)) && Number.isFinite(Number(event?.longitude));
}

function eventKey(event) {
  return clean(event.entityKey || event.masterEventId || event.id, 220);
}

function changeVersion(event, type) {
  if (type === "severity") return String(event.severity);
  if (type === "priority") return String(Math.floor(Number(event.priority) / 5) * 5);
  if (type === "evidence") return String(event.evidenceCount || 0);
  if (type === "location" || type === "dispatch") return `${event.locationQuality}:${event.dispatchEligibility}`;
  if (type === "track") return `${Number(event.latitude).toFixed(1)}:${Number(event.longitude).toFixed(1)}`;
  if (type === "forecast") return String(event.cycloneForecast?.issuedAt || event.updatedAt);
  if (type === "phase") return String(event.observationPhase);
  return String(event.masterEventId || event.id || event.updatedAt);
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function clean(value, limit = 200) {
  return [...String(value ?? "")]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function compactTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
}

function number(value, digits) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function hazardLabel(value) {
  return HAZARD_LABELS[value] ?? (clean(value, 40) || "未知灾害");
}

function severityLabel(value) {
  return SEVERITY_LABELS[value] ?? (clean(value, 40) || "未知");
}

function locationLabel(value) {
  return LOCATION_LABELS[value] ?? (clean(value, 40) || "未知");
}

const isMain = process.argv[1] && executablePath(process.argv[1]) === executablePath(fileURLToPath(import.meta.url));
if (isMain) {
  runOnce().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.error) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

function executablePath(value) {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
