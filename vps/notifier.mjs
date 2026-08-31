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
const HAZARD_SUBTYPE_LABELS = { landslide: "滑坡", debris_flow: "泥石流", rockfall: "崩塌/落石", slope_failure: "边坡失稳", mass_movement: "地表物质运动" };

const SEVERITY_LABELS = { red: "红色", orange: "橙色", yellow: "黄色", blue: "蓝色" };
const SEVERITY_EMOJI = { red: "🔴", orange: "🟠", yellow: "🟡", blue: "🔵" };
const LOCATION_LABELS = { precise: "精确", estimated: "估算", representative: "代表点", unknown: "未知" };
const SCOPE_LABELS = { wuxi: "无锡市", jiangsu: "江苏省", china: "中国", global: "全球" };
const PHASE_LABELS = { golden: "黄金观测期", followup: "后续观测期", archive: "已过观测期" };
const PHENOMENON_LABELS = { observed: "灾害实况", warning: "权威预警", forecast: "灾害预报" };

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

export function signPayload(secret, body, timestamp = "") {
  const signed = timestamp ? `${timestamp}.${body}` : body;
  return createHmac("sha256", secret).update(signed).digest("hex");
}

export function changeNotifications(previous, event, config) {
  const changes = [];
  if (!previous) {
    if (isAlertable(event, config)) changes.push({ type: "new", label: newEventLabel(event, config) });
    return changes;
  }

  const alertable = isAlertable(event, config);
  if (alertable && severityRank(event.severity) > severityRank(previous.severity)) {
    const verification = isLowConfidenceHighSeverity(event) ? "（低可信高等级信号，待核验）" : "";
    changes.push({ type: "severity", label: `等级升级：${severityLabel(previous.severity)} → ${severityLabel(event.severity)}${verification}` });
  }
  // 黄、蓝事件仍进入状态基线，但普通同级变化不打扰值守人员。
  // 一旦升至红/橙或命中明确的黄色重点例外，再汇报本轮实质变化。
  if (!alertable) return changes;

  if (Number(previous.priority) < config.minPriority && Number(event.priority) >= config.minPriority) {
    changes.push({ type: "priority", label: `优先级升至 ${number(event.priority, 0)}` });
  }
  if (sourceEvidenceCount(event) > sourceEvidenceCount(previous)) {
    changes.push({ type: "evidence", label: `新增独立来源，现有 ${number(sourceEvidenceCount(event), 0)} 个来源` });
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
    if (Number.isFinite(forecastAt) && (!Number.isFinite(previousForecastAt) || forecastAt > previousForecastAt)) {
      changes.push({ type: "forecast", label: `收到${clean(event.cycloneForecast.source, 60)}新一期官方路径/风圈` });
    }
  }
  if (config.notifyPhaseTransition && previous.observationPhase === "golden" && event.observationPhase === "followup") {
    changes.push({ type: "phase", label: "进入后续观测期" });
  }
  return changes;
}

export function buildEventMessage(event, changeLabel, publicUrl = "") {
  const coordinate = `${number(event.latitude, 5)}, ${number(event.longitude, 5)}`;
  const accuracy = Number.isFinite(Number(event.locationAccuracyKm)) ? `（约 ±${number(event.locationAccuracyKm, 0)} km）` : "";
  const sourceUrl = safeUrl(event.sourceUrl);
  const sourceLabel = markdownText(event.source, 120);
  const source = sourceUrl ? `[${sourceLabel}](${sourceUrl})` : sourceLabel;
  const sensors = Array.isArray(event.recommendedSensors) && event.recommendedSensors.length
    ? event.recommendedSensors.map((item) => markdownText(item, 40)).join(" / ")
    : "待卫星系统匹配";
  const targets = Array.isArray(event.observationTargets) && event.observationTargets.length
    ? event.observationTargets.slice(0, 5).map((item) => markdownText(item, 50)).join("、")
    : "待判定";
  const review = event.aoiApprovalRequired ? "⚠️ AOI 需人工复核" : "✅ 来源几何已核验，可建立规划候选";
  const forecast = event.hazard === "cyclone" && event.cycloneForecast
    ? `- 官方预报：${clean(event.cycloneForecast.source, 80)} · ${number(event.cycloneForecast.track?.length, 0)} 个中心节点 · 有效至 ${formatTime(event.cycloneForecast.forecastValidUntil)} · ${clean(event.cycloneForecast.impactThreshold || "本报次无官方风圈", 100)}`
    : "";
  const referenceTime = event.phenomenonStage === "observed"
    ? `- 发生时间：${formatTime(event.occurredAt)} · 最新更新 ${formatTime(event.updatedAt)}`
    : `- 发布时间：${formatTime(event.issuedAt || event.updatedAt)}${event.validFrom ? ` · 生效 ${formatTime(event.validFrom)}` : ""}${event.validTo ? ` · 有效至 ${formatTime(event.validTo)}` : ""}`;
  const nextStep = event.aoiApprovalRequired
    ? "请在系统中核对事件位置和观测范围，再建立卫星任务候选。"
    : "可进入系统查看详情，并建立卫星任务候选后进行机会计算。";
  const systemLink = safeUrl(publicUrl) ? `- 打开系统：[查看事件与规划任务](${safeUrl(publicUrl)})` : "";
  const confidenceWarning = isLowConfidenceHighSeverity(event)
    ? "- 核验提示：⚠️ 当前为低可信高等级信号，不得写成已确认灾害；请等待权威来源或独立证据复核。"
    : "";

  return [
    `${SEVERITY_EMOJI[event.severity] ?? "⚪"} **${markdownText(changeLabel, 160)}｜${markdownText(event.title, 220)}**`,
    `- 信息性质：${PHENOMENON_LABELS[event.phenomenonStage] ?? "待核验信息"}`,
    `- 类型/等级：${hazardLabel(event.hazard, event.hazardSubtype)} · ${severityLabel(event.severity)} · 优先级 **${number(event.priority, 0)}**`,
    `- 范围/坐标：${SCOPE_LABELS[event.scope] ?? "全球"} · \`${coordinate}\``,
    event.crossBorder ? `- 跨境影响：起源 ${clean(event.originCountry, 40) || "待核验"} · 受影响 ${Array.isArray(event.affectedCountries) ? event.affectedCountries.map((item) => clean(item, 40)).filter(Boolean).join("、") : "待核验"}` : "",
    `- 定位质量：${locationLabel(event.locationQuality)}${accuracy} · ${review}`,
    referenceTime,
    `- 观测阶段：${PHASE_LABELS[event.observationPhase] ?? clean(event.observationPhase, 40)}，截止 ${formatTime(event.observationExpiresAt)}`,
    `- AOI/目标：${clean(event.geometryType || "Point", 30)} · ${targets}`,
    forecast,
    `- 可选载荷：${sensors}`,
    `- 证据/来源：${number(sourceEvidenceCount(event), 0)} 个独立来源，过程公告 ${number(event.bulletinCount ?? event.updateCount, 0)} 期 · ${source}`,
    confidenceWarning,
    `- 事件编号：\`${clean(event.entityKey || event.masterEventId || event.id, 180)}\``,
    `- 建议下一步：${nextStep}`,
    systemLink,
  ].filter(Boolean).join("\n");
}

export function defaultConfig(env = process.env) {
  return {
    engineUrl: env.TIANXUN_ENGINE_URL || "http://127.0.0.1:3000/api/events",
    changesUrl: env.TIANXUN_CHANGES_URL || new URL("/api/changes", env.TIANXUN_ENGINE_URL || "http://127.0.0.1:3000/api/events").toString(),
    engineToken: env.TIANXUN_VIEWER_TOKEN || env.TIANXUN_API_TOKEN || "",
    dbPath: resolve(env.TIANXUN_NOTIFY_DB || ".data/notifier.sqlite"),
    webhookUrl: env.HERMES_WEBHOOK_URL || "http://127.0.0.1:8644/webhooks/tianxun-alerts",
    webhookSecret: env.HERMES_WEBHOOK_SECRET || "",
    webhookSignatureVersion: normalizeSignatureVersion(env.HERMES_SIGNATURE_VERSION),
    minSeverity: normalizeSeverityThreshold(env.MIN_NOTIFY_SEVERITY),
    minPriority: boundedNumber(env.MIN_NOTIFY_PRIORITY, 0, 100, 65),
    notifyYellowExceptions: booleanValue(env.NOTIFY_YELLOW_EXCEPTIONS, true),
    yellowExceptionPriority: boundedNumber(env.YELLOW_NOTIFY_MIN_PRIORITY, 0, 100, 80),
    yellowExceptionScopes: csvValues(env.YELLOW_NOTIFY_SCOPES || "wuxi,jiangsu"),
    cycloneMoveKm: boundedNumber(env.CYCLONE_MOVE_ALERT_KM, 10, 2000, 150),
    sourceFailureThreshold: boundedNumber(env.SOURCE_FAILURE_THRESHOLD, 1, 20, 3),
    maxDeliveryAttempts: boundedNumber(env.MAX_DELIVERY_ATTEMPTS, 1, 30, 8),
    maxBatchSize: boundedNumber(env.MAX_ALERT_BATCH_SIZE, 1, 10, 5),
    requestTimeoutMs: boundedNumber(env.REQUEST_TIMEOUT_MS, 1000, 120000, 45000),
    bootstrapNotify: booleanValue(env.BOOTSTRAP_NOTIFY, true),
    notifyPhaseTransition: booleanValue(env.NOTIFY_PHASE_TRANSITION, false),
    publicUrl: safeUrl(env.TIANXUN_PUBLIC_URL || ""),
  };
}

export async function runOnce(config = defaultConfig(), fetchImpl = fetch) {
  const db = openDatabase(config.dbPath);
  const startedAt = new Date().toISOString();
  let runError = "";
  try {
    const payload = await fetchEvents(config, fetchImpl);
    let operationalChangeError = "";
    processSourceHealth(db, Array.isArray(payload.sourceStatus) ? payload.sourceStatus : [], config);
    if (!payload.fallback && payload.persistenceAvailable !== false) {
      processEvents(db, Array.isArray(payload.events) ? payload.events : [], payload, config);
      try {
        const changePayload = await fetchChanges(config, db, fetchImpl);
        processOperationalChanges(db, changePayload.changes, changePayload.cursor);
        setMeta(db, "operational_change_error", "");
      } catch (changeError) {
        operationalChangeError = clean(changeError instanceof Error ? changeError.message : changeError, 300);
        runError = `变更流处理失败：${operationalChangeError}`;
        setMeta(db, "operational_change_error", operationalChangeError);
      }
      setMeta(db, "consecutive_collection_failures", "0");
      recordRun(db, startedAt, operationalChangeError ? "degraded" : "ok", Array.isArray(payload.events) ? payload.events.length : 0, operationalChangeError);
    } else {
      const message = payload.persistenceAvailable === false
        ? "灾害引擎持久化不可用；本轮内存事件未进入通知基线，也不会触发灾害告警。"
        : "全部上游源不可用，API 返回了演示回退数据；未更新事件基线。";
      runError = message;
      recordCollectionProblem(db, message, config);
      recordRun(db, startedAt, "degraded", 0, message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runError = message;
    recordCollectionProblem(db, `采集请求失败：${clean(message, 300)}`, config);
    recordRun(db, startedAt, "failed", 0, message);
  }

  const result = await deliverPending(db, config, fetchImpl);
  db.close();
  return runError && !result.error ? { ...result, error: runError } : result;
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

async function fetchChanges(config, db, fetchImpl) {
  const after = getMeta(db, "operational_change_cursor") || "1970-01-01T00:00:00.000Z";
  const url = new URL(config.changesUrl);
  url.searchParams.set("after", after);
  url.searchParams.set("limit", "200");
  const authorization = config.engineToken ? { Authorization: `Bearer ${config.engineToken}` } : {};
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "Tianxun-VPS-Notifier/1.0", ...authorization }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error(`灾害变更流 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.changes)) throw new Error("灾害变更流响应无效");
  return { changes: payload.changes.slice(0, 200), cursor: String(payload.cursor || after) };
}

function processOperationalChanges(db, changes, cursor) {
  for (const change of changes) {
    if (!change || typeof change.id !== "string" || typeof change.type !== "string") continue;
    const event = change.payload?.event;
    if (change.type === "event_merged") {
      enqueue(db, {
        dedupeKey: `change:${change.id}`,
        kind: change.type,
        entityKey: clean(change.masterEventId, 220),
        message: `🔗 **重复灾害过程已聚合**\n- 原事件：${markdownText(change.payload?.event?.title || change.payload?.fromMasterEventId, 220)}\n- 主事件：${markdownText(change.payload?.toMasterEventId || change.masterEventId, 220)}\n- 处置：旧候选任务不会静默迁移，需基于主事件重新核对 AOI\n- 时间：${formatTime(change.createdAt)}`,
      });
    } else if (change.type === "event_resolved" || change.type === "event_quarantined") {
      enqueue(db, {
        dedupeKey: `change:${change.id}`,
        kind: change.type,
        entityKey: clean(change.masterEventId, 220),
        message: change.type === "event_quarantined"
          ? `⛔ **事件已隔离，禁止任务下发**\n- 事件：${markdownText(event?.title || change.masterEventId, 220)}\n- 原因：${markdownText(change.payload?.reason || "事件身份或证据冲突", 300)}\n- 时间：${formatTime(change.createdAt)}`
          : `✅ **灾害事件已解除**\n- 事件：${markdownText(event?.title || change.masterEventId, 220)}\n- 原因：${markdownText(change.payload?.reason || "权威来源撤销或全部证据失效", 300)}\n- 时间：${formatTime(change.createdAt)}`,
      });
    } else if (change.type === "task_cancelled") {
      enqueue(db, {
        dedupeKey: `change:${change.id}`,
        kind: change.type,
        entityKey: clean(change.masterEventId, 220),
        message: `🛑 **关联卫星任务已自动取消**\n- 任务：${markdownText(change.payload?.taskId, 220)}\n- 原状态：${markdownText(change.payload?.previousStatus, 80)}\n- 原因：${markdownText(change.payload?.reason, 300)}\n- 时间：${formatTime(change.createdAt)}`,
      });
    }
  }
  if (cursor) {
    const separator = cursor.indexOf("|");
    const timePart = separator >= 0 ? cursor.slice(0, separator) : cursor;
    const idPart = separator >= 0 ? cursor.slice(separator + 1) : "";
    if (Number.isFinite(Date.parse(timePart)) && idPart.length <= 300 && ![...idPart].some((character) => character.charCodeAt(0) < 32)) {
      setMeta(db, "operational_change_cursor", separator >= 0 ? `${new Date(timePart).toISOString()}|${idPart}` : new Date(timePart).toISOString());
    }
  }
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
            message: buildEventMessage(event, changes.map((change) => change.label).join("；"), config.publicUrl),
          });
        }
      }
      upsert.run(
        key,
        String(event.masterEventId || event.id || key),
        String(event.severity || "blue"),
        Number(event.priority || 0),
        sourceEvidenceCount(event),
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
            `- 红橙及黄色重点例外：${high} 个（首次启动只记录现状，不逐条发送旧事件）`,
            `- 在线数据源：${online}/${(payload.sourceStatus || []).length}`,
            `- 首次采集：${formatTime(payload.fetchedAt || now)}`,
            "- 后续仅推送红橙新事件、升至红橙、黄色重点例外、重大态势变化及系统故障。",
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
    const signaturePreference = normalizeSignatureVersion(config.webhookSignatureVersion);
    const signatureVersions = signaturePreference === "auto" ? ["v2", "v1"] : [signaturePreference];
    let deliveredWith = signatureVersions[0];
    for (const signatureVersion of signatureVersions) {
      const webhookTimestamp = Math.floor(Date.now() / 1000).toString();
      const signatureHeaders = signatureVersion === "v2"
        ? { "X-Webhook-Signature-V2": signPayload(config.webhookSecret, body, webhookTimestamp), "X-Webhook-Timestamp": webhookTimestamp }
        : { "X-Webhook-Signature": signPayload(config.webhookSecret, body) };
      const response = await fetchImpl(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...signatureHeaders,
          "X-Request-ID": requestId,
          "User-Agent": "Tianxun-VPS-Notifier/1.0",
        },
        body,
        signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 20000)),
      });
      if (response.ok) {
        deliveredWith = signatureVersion;
        break;
      }
      const responseText = clean(await response.text(), 300);
      const canUseLegacyCompatibility = signaturePreference === "auto" && signatureVersion === "v2" && response.status === 401 && /invalid signature/i.test(responseText);
      if (!canUseLegacyCompatibility) throw new Error(`Hermes HTTP ${response.status}: ${responseText}`);
    }
    const deliveredAt = new Date().toISOString();
    const update = db.prepare("UPDATE notification_queue SET status='delivered', delivered_at=?, last_error='', lease_owner='' WHERE id=? AND lease_owner=?");
    for (const row of rows) update.run(deliveredAt, row.id, leaseOwner);
    setMeta(db, "last_delivery_success_at", deliveredAt);
    return { delivered: rows.length, pending: 0, requestId, signatureVersion: deliveredWith };
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
  const now = new Date();
  const deliveredCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const stateCutoff = new Date(now.getTime() - 180 * 86_400_000).toISOString();
  db.prepare("INSERT INTO collection_runs (started_at, completed_at, status, event_count, error) VALUES (?, ?, ?, ?, ?)")
    .run(startedAt, now.toISOString(), status, eventCount, clean(error, 500));
  db.prepare("DELETE FROM collection_runs WHERE id NOT IN (SELECT id FROM collection_runs ORDER BY id DESC LIMIT 1000)").run();
  db.prepare("DELETE FROM notification_queue WHERE status='delivered' AND delivered_at < ?").run(deliveredCutoff);
  db.prepare("DELETE FROM event_state WHERE seen_at < ?").run(stateCutoff);
  db.prepare("DELETE FROM source_state WHERE updated_at < ?").run(stateCutoff);
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
  const minimumRank = severityRank(config.minSeverity || "orange");
  if (severityRank(event.severity) >= minimumRank) return true;
  return Boolean(yellowExceptionReason(event, config));
}

function yellowExceptionReason(event, config) {
  if (event.severity !== "yellow" || config.notifyYellowExceptions === false) return "";
  const scopes = Array.isArray(config.yellowExceptionScopes) && config.yellowExceptionScopes.length
    ? config.yellowExceptionScopes
    : ["wuxi", "jiangsu"];
  const focusScope = scopes.includes(String(event.scope));
  const priorityThreshold = Number.isFinite(Number(config.yellowExceptionPriority)) ? Number(config.yellowExceptionPriority) : 80;
  if (Number(event.priority) >= priorityThreshold) return focusScope ? "重点区域且任务优先级较高" : "任务优先级达到黄色例外阈值";
  const confidence = Number(event.confidenceScore);
  const sufficientlyTrusted = Number.isFinite(confidence) ? confidence >= 70 : event.confidenceLevel !== "low";
  if (focusScope && sufficientlyTrusted && ["warning", "forecast"].includes(event.phenomenonStage)) {
    return "重点区域的权威预警或预报，需保留灾前观测机会";
  }
  return "";
}

function newEventLabel(event, config) {
  const yellowReason = yellowExceptionReason(event, config);
  if (yellowReason) return `黄色事件条件触发：${yellowReason}`;
  if (isLowConfidenceHighSeverity(event)) return "发现待核验的高等级灾害信号";
  return event.phenomenonStage === "observed"
    ? "发现新的红橙灾害实况"
    : event.phenomenonStage === "warning"
      ? "收到新的红橙权威预警"
      : "收到新的红橙灾害预报";
}

function isLowConfidenceHighSeverity(event) {
  if (!["red", "orange"].includes(event.severity)) return false;
  const score = Number(event.confidenceScore);
  return event.confidenceLevel === "low" || (Number.isFinite(score) && score < 70);
}

function validEvent(event) {
  if (!event || !finiteCoordinates(event)) return false;
  const latitude = Number(event.latitude);
  const longitude = Number(event.longitude);
  const key = eventKey(event);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && Boolean(key) && !/(?:^|[-_:])(undefined|null|nan|unknown)(?:$|[-_:])/i.test(key);
}

function finiteCoordinates(event) {
  return Number.isFinite(Number(event?.latitude)) && Number.isFinite(Number(event?.longitude));
}

function eventKey(event) {
  return clean(event.entityKey || event.masterEventId || event.id, 220);
}

function sourceEvidenceCount(event) {
  const explicit = Number(event?.independentSourceCount);
  if (Number.isFinite(explicit)) return explicit;
  if (Array.isArray(event?.evidence)) return new Set(event.evidence.map((item) => clean(item?.source, 160).split(" · ")[0])).size;
  return Number(event?.evidenceCount || 0);
}

function changeVersion(event, type) {
  if (type === "severity") return String(event.severity);
  if (type === "priority") return String(Math.floor(Number(event.priority) / 5) * 5);
  if (type === "evidence") return String(sourceEvidenceCount(event));
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

function markdownText(value, limit = 200) {
  return clean(value, limit).replace(/[\\`*_[\]()#+.!>|~-]/g, "\\$&");
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return url.protocol === "https:" || localHttp ? url.toString() : "";
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

function normalizeSignatureVersion(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return ["auto", "v1", "v2"].includes(normalized) ? normalized : "auto";
}

function normalizeSeverityThreshold(value) {
  const normalized = String(value || "orange").trim().toLowerCase();
  return ["blue", "yellow", "orange", "red"].includes(normalized) ? normalized : "orange";
}

function csvValues(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function hazardLabel(value, subtype) {
  return HAZARD_SUBTYPE_LABELS[subtype] ?? HAZARD_LABELS[value] ?? (clean(value, 40) || "未知灾害");
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
