export const taskStatuses = ["candidate", "reviewed", "scheduled", "submitted", "acquired", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const aoiTypes = ["source", "point", "circle", "rectangle", "corridor"] as const;
export const sensorOptions = ["高分辨率光学", "宽幅光学", "多光谱", "高光谱", "SAR", "热红外", "微波辐射计", "激光雷达"] as const;

const transitions: Record<TaskStatus, TaskStatus[]> = {
  candidate: ["reviewed", "cancelled"],
  reviewed: ["candidate", "scheduled", "cancelled"],
  scheduled: ["reviewed", "submitted", "cancelled"],
  submitted: ["acquired", "failed", "cancelled"],
  acquired: ["completed", "failed"],
  completed: [],
  failed: ["reviewed", "cancelled"],
  cancelled: [],
};

export type TaskValidationResult = { ok: true } | { ok: false; errors: string[] };

const allowedTaskFields = new Set([
  "taskId", "eventId", "masterEventId", "entityKey", "title", "hazard", "priority", "latitude", "longitude",
  "eventOccurredAt", "eventUpdatedAt", "aoiType", "aoiRadiusKm", "aoiWidthKm", "aoiHeightKm", "aoiLengthKm",
  "aoiBearingDeg", "sourceGeometry", "cycloneForecast", "minimumCoveragePercent", "maximumCloudPercent",
  "spatialResolutionMeters", "incidenceAngleMinDeg", "incidenceAngleMaxDeg", "revisitCount", "deliveryDeadline",
  "imagingStart", "imagingEnd", "sensors", "observationTargets", "observationPhase", "source", "sourceUrl",
  "locationQuality", "locationAccuracyKm", "evidenceCount", "aoiApproval", "approvedAt", "approvedBy",
  "approvalReason", "createdAt", "updatedAt", "status", "revision", "eventRevision", "aoiHash",
]);

export function unknownTaskFields(task: Record<string, unknown>) {
  return Object.keys(task).filter((key) => !allowedTaskFields.has(key));
}

export function validateSatelliteTask(task: Record<string, unknown>, options: { requireApproved?: boolean; requireProvenance?: boolean } = {}): TaskValidationResult {
  const errors: string[] = [];
  for (const key of ["taskId", "eventId", "masterEventId", "title", "status", "aoiType", "imagingStart", "imagingEnd", "aoiApproval", "createdAt"]) {
    if (typeof task[key] !== "string" || !String(task[key]).trim()) errors.push(`缺少或无效字段：${key}`);
    else if (String(task[key]).length > (key === "title" ? 500 : 220)) errors.push(`字段过长：${key}`);
  }
  const latitude = Number(task.latitude);
  const longitude = Number(task.longitude);
  const priority = Number(task.priority);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) errors.push("纬度必须在 -90 到 90 之间");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) errors.push("经度必须在 -180 到 180 之间");
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) errors.push("优先级必须是 0 到 100 的整数");

  const start = Date.parse(String(task.imagingStart ?? ""));
  const end = Date.parse(String(task.imagingEnd ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) errors.push("成像时间必须是有效日期");
  else if (end <= start) errors.push("最晚成像时间必须晚于最早成像时间");
  else if (end <= Date.now()) errors.push("成像窗口已经过期");
  else if (end - start > 366 * 86_400_000) errors.push("单个成像窗口不能超过 366 天");

  if (!taskStatuses.includes(task.status as TaskStatus)) errors.push("任务状态不在允许范围内");
  if (!aoiTypes.includes(task.aoiType as (typeof aoiTypes)[number])) errors.push("AOI 类型不在允许范围内");
  if (!Array.isArray(task.sensors) || task.sensors.length > sensorOptions.length) errors.push("载荷字段必须是受限数组");
  else if (task.sensors.some((sensor) => !sensorOptions.includes(sensor as (typeof sensorOptions)[number]))) errors.push("包含未知载荷");
  else if (task.sensors.length === 0 && (options.requireApproved || task.status !== "candidate")) errors.push("至少选择一种载荷");
  if (!Array.isArray(task.observationTargets) || task.observationTargets.length === 0) errors.push("至少需要一个观测目标");
  else if (task.observationTargets.length > 30 || task.observationTargets.some((target) => typeof target !== "string" || target.length > 120)) errors.push("观测目标数量或长度超限");
  boundedNumber(task.minimumCoveragePercent, 1, 100, "最低覆盖率", errors);
  boundedNumber(task.maximumCloudPercent, 0, 100, "最大云量", errors);
  boundedNumber(task.spatialResolutionMeters, 0.1, 10_000, "空间分辨率", errors);
  const incidenceMin = boundedNumber(task.incidenceAngleMinDeg, 0, 80, "最小入射角", errors);
  const incidenceMax = boundedNumber(task.incidenceAngleMaxDeg, 0, 80, "最大入射角", errors);
  if (incidenceMin !== null && incidenceMax !== null && incidenceMax < incidenceMin) errors.push("最大入射角不能小于最小入射角");
  boundedNumber(task.revisitCount, 1, 50, "重访次数", errors, true);
  const delivery = Date.parse(String(task.deliveryDeadline ?? ""));
  if (!Number.isFinite(delivery) || (Number.isFinite(end) && delivery < end)) errors.push("交付期限必须是有效时间且不早于成像窗口结束");
  if (!isValidAoi(task)) errors.push("AOI 参数无效或超出安全范围");
  if (task.cycloneForecast !== undefined && !isValidCycloneForecast(task.cycloneForecast)) errors.push("台风官方预报字段无效或超出安全范围");
  if (!isValidApproval(task.aoiApproval)) errors.push("AOI 审批状态无效");
  if (options.requireApproved && task.aoiApproval !== "source_verified" && task.aoiApproval !== "operator_confirmed") errors.push("任务尚未通过 AOI 审批");
  if (options.requireApproved && task.aoiApproval === "source_verified" && task.aoiType !== "source") errors.push("来源核验任务必须使用不可修改的来源几何");
  if (options.requireApproved && task.aoiApproval === "operator_confirmed" && (typeof task.approvalReason !== "string" || !task.approvalReason.trim() || task.approvalReason.length > 500)) errors.push("人工核对任务必须填写审批理由");
  const revision = Number(task.revision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) errors.push("任务 revision 必须是非负整数");
  if (options.requireProvenance) {
    if (typeof task.eventRevision !== "string" || !/^[a-f0-9]{16}$/.test(task.eventRevision)) errors.push("缺少有效事件版本指纹");
    if (typeof task.aoiHash !== "string" || !/^[a-f0-9]{16}$/.test(task.aoiHash)) errors.push("缺少有效 AOI 指纹");
  }
  if (task.source === "演示数据") errors.push("演示事件禁止进入任务流");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function canTransitionTask(from: string | null, to: string) {
  if (!from) return to === "candidate";
  if (from === to) return true;
  return taskStatuses.includes(from as TaskStatus) && taskStatuses.includes(to as TaskStatus)
    && transitions[from as TaskStatus].includes(to as TaskStatus);
}

export function allowedTaskStatuses(from: string): TaskStatus[] {
  if (!taskStatuses.includes(from as TaskStatus)) return ["candidate"];
  return [from as TaskStatus, ...transitions[from as TaskStatus]];
}

export function safeHttpUrl(value: unknown, fallback = "#") {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function isValidApproval(value: unknown) {
  return value === "source_verified" || value === "operator_confirmed";
}

function boundedNumber(value: unknown, min: number, max: number, label: string, errors: string[], integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    errors.push(`${label}必须在 ${min} 到 ${max} 之间`);
    return null;
  }
  return parsed;
}

function isValidAoi(task: Record<string, unknown>) {
  const type = task.aoiType;
  if (type === "source") return isGeometry(task.sourceGeometry);
  const radius = Number(task.aoiRadiusKm);
  const width = Number(task.aoiWidthKm);
  const height = Number(task.aoiHeightKm);
  const length = Number(task.aoiLengthKm);
  const bearing = Number(task.aoiBearingDeg);
  if (type === "point") return Number.isFinite(radius) && radius >= 0 && radius <= 100;
  if (type === "circle") return Number.isFinite(radius) && radius >= 1 && radius <= 1000;
  if (type === "rectangle") return Number.isFinite(width) && width >= 1 && width <= 2000 && Number.isFinite(height) && height >= 1 && height <= 2000;
  if (type === "corridor") return Number.isFinite(width) && width >= 1 && width <= 500 && Number.isFinite(length) && length >= 1 && length <= 3000 && Number.isFinite(bearing) && bearing >= 0 && bearing < 360;
  return false;
}

function isGeometry(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (!["Point", "LineString", "Polygon", "MultiPolygon"].includes(String(geometry.type)) || !Array.isArray(geometry.coordinates)) return false;
  let vertices = 0;
  const validate = (node: unknown, depth: number): boolean => {
    if (depth > 5 || !Array.isArray(node)) return false;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      vertices += 1;
      return vertices <= 10_000 && Number.isFinite(node[0]) && Number.isFinite(node[1]) && node[0] >= -180 && node[0] <= 180 && node[1] >= -90 && node[1] <= 90;
    }
    return node.length > 0 && node.length <= 10_000 && node.every((child) => validate(child, depth + 1));
  };
  if (!validate(geometry.coordinates, 0)) return false;
  if (geometry.type === "Point") return Array.isArray(geometry.coordinates) && typeof geometry.coordinates[0] === "number";
  if (geometry.type === "LineString") return geometry.coordinates.length >= 2;
  if (geometry.type === "Polygon") return validPolygon(geometry.coordinates);
  return geometry.coordinates.every((polygon) => validPolygon(polygon));
}

function isValidCycloneForecast(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const forecast = value as Record<string, unknown>;
  if (forecast.official !== true || typeof forecast.source !== "string" || forecast.source.length > 120 || !safeHttpUrl(forecast.sourceUrl, "")) return false;
  if (!Number.isFinite(Date.parse(String(forecast.issuedAt ?? ""))) || !Number.isFinite(Date.parse(String(forecast.forecastValidUntil ?? "")))) return false;
  if (!Array.isArray(forecast.track) || forecast.track.length < 2 || forecast.track.length > 30 || !isGeometry(forecast.trackGeometry)) return false;
  if (forecast.uncertaintyGeometry !== undefined && !isGeometry(forecast.uncertaintyGeometry)) return false;
  if (forecast.impactGeometry !== undefined && !isGeometry(forecast.impactGeometry)) return false;
  if (!["forecast_wind_radii", "current_wind_extent", "uncertainty_only"].includes(String(forecast.impactBasis))) return false;
  return forecast.track.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const point = item as Record<string, unknown>;
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    const leadHours = Number(point.leadHours);
    return Number.isFinite(Date.parse(String(point.forecastAt ?? "")))
      && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && Number.isFinite(leadHours) && leadHours >= 0 && leadHours <= 360;
  });
}

function validPolygon(value: unknown) {
  if (!Array.isArray(value) || !value.length) return false;
  return value.every((ring) => Array.isArray(ring) && ring.length >= 4 && coordinatesEqual(ring[0], ring[ring.length - 1]));
}

function coordinatesEqual(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right) && Number(left[0]) === Number(right[0]) && Number(left[1]) === Number(right[1]);
}

export function validateTaskAoi(task: Record<string, unknown>, aoi: unknown) {
  if (!isGeometry(aoi)) return false;
  if (task.aoiType === "source") return JSON.stringify(aoi) === JSON.stringify(task.sourceGeometry);
  return true;
}
