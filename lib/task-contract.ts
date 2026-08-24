import { validateGeoGeometry } from "./geo-geometry.ts";
import { sarImagingModeOptions } from "./satellite-payloads.ts";

export const taskStatuses = ["candidate", "reviewed", "scheduled", "submitted", "cancellation_requested", "cancel_acknowledged", "cancel_rejected", "acquired", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const operatorEditableTaskStatuses: TaskStatus[] = ["candidate", "reviewed"];

export const aoiTypes = ["source", "point", "circle", "rectangle", "corridor", "polygon", "multi"] as const;
// The current planning UI exposes only these two mission-level payload classes.
// Legacy values remain accepted so persisted drafts can be migrated without data loss.
export const sensorOptions = ["光学", "SAR", "高分辨率光学", "宽幅光学", "多光谱", "高光谱", "热红外", "微波辐射计", "激光雷达"] as const;
const sarImagingModeIds = new Set<string>(sarImagingModeOptions.map((mode) => mode.id));

const transitions: Record<TaskStatus, TaskStatus[]> = {
  candidate: ["reviewed", "cancelled"],
  reviewed: ["candidate", "scheduled", "cancelled"],
  scheduled: ["reviewed", "submitted", "cancelled"],
  submitted: ["cancellation_requested", "acquired", "failed"],
  cancellation_requested: ["cancel_acknowledged", "cancel_rejected", "failed"],
  cancel_acknowledged: [],
  cancel_rejected: ["submitted", "cancellation_requested", "failed"],
  acquired: ["completed", "failed"],
  completed: [],
  failed: ["reviewed", "cancelled"],
  cancelled: [],
};

export type TaskValidationResult = { ok: true } | { ok: false; errors: string[] };

const allowedTaskFields = new Set([
  "taskId", "eventId", "masterEventId", "entityKey", "title", "hazard", "priority", "latitude", "longitude",
  "eventOccurredAt", "eventUpdatedAt", "eventIssuedAt", "eventValidFrom", "eventValidTo", "phenomenonStage", "aoiType", "aoiRadiusKm", "aoiWidthKm", "aoiHeightKm", "aoiLengthKm",
  "aoiBearingDeg", "sourceGeometry", "customGeometry", "cycloneForecast", "minimumCoveragePercent", "maximumCloudPercent",
  "spatialResolutionMeters", "incidenceAngleMinDeg", "incidenceAngleMaxDeg", "revisitCount", "deliveryDeadline", "sarImagingModes",
  "imagingStart", "imagingEnd", "sensors", "observationTargets", "observationPhase", "source", "sourceUrl",
  "locationQuality", "locationAccuracyKm", "evidenceCount", "aoiApproval", "approvedAt", "approvedBy",
  "approvalReason", "createdAt", "updatedAt", "status", "revision", "eventRevision", "aoiHash",
  "timeIndexedAoi", "forecastAdvisoryId", "forecastIssuedAt", "forecastValidUntil",
  "cycloneTrackingTarget", "trackingValidFrom", "trackingValidTo", "trackingLeadHours", "trackingCenterLatitude", "trackingCenterLongitude", "trackingCenterBasis", "trackingThresholdKnots",
  "satelliteId", "instrumentId", "imagingMode", "opportunityId", "orbitVersion", "visibilityComputedAt",
  "opportunityLookSide", "opportunityCoveragePercent", "opportunitySpatialResolutionM", "opportunitySceneCrossTrackKm", "opportunitySceneAlongTrackKm", "sensorParameterStatus", "opportunityFootprint",
  "simulationLevel", "satelliteNoradId", "closestApproachAt", "closestSubpointLatitude", "closestSubpointLongitude",
  "minimumGroundTrackDistanceKm", "orbitSearchRadiusKm", "opportunityOrbitDirection",
  "orbitDirectionPreference", "referenceAcquisitionRequired", "sarAnalysisMode",
  "dispatchId", "dispatchAcceptedAt", "acquisitionId", "acquiredAt", "productIds", "completedAt",
  "cancellationRequestId", "cancellationRequestedAt", "cancellationAcknowledgedAt", "externalStatusReason",
]);

export function unknownTaskFields(task: Record<string, unknown>) {
  return Object.keys(task).filter((key) => !allowedTaskFields.has(key));
}

export function validateSatelliteTask(task: Record<string, unknown>, options: { requireApproved?: boolean; requirePayload?: boolean; requireProvenance?: boolean } = {}): TaskValidationResult {
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
  validateExecutionProvenance(task, errors);
  if (!aoiTypes.includes(task.aoiType as (typeof aoiTypes)[number])) errors.push("AOI 类型不在允许范围内");
  if (!Array.isArray(task.sensors) || task.sensors.length > sensorOptions.length) errors.push("载荷字段必须是受限数组");
  else if (task.sensors.some((sensor) => !sensorOptions.includes(sensor as (typeof sensorOptions)[number]))) errors.push("包含未知载荷");
  else if (task.sensors.length === 0 && (options.requirePayload || task.status !== "candidate")) errors.push("至少选择一种载荷");
  if (task.sarImagingModes !== undefined) {
    if (!Array.isArray(task.sarImagingModes) || task.sarImagingModes.length > sarImagingModeOptions.length || task.sarImagingModes.some((mode) => !sarImagingModeIds.has(String(mode))) || new Set(task.sarImagingModes).size !== task.sarImagingModes.length) {
      errors.push("SAR 成像方式必须是无重复的受限数组");
    } else if (Array.isArray(task.sensors) && task.sensors.includes("SAR") && task.sarImagingModes.length === 0) {
      errors.push("选择 SAR 后至少需要一种成像方式");
    } else if (Array.isArray(task.sensors) && !task.sensors.includes("SAR") && task.sarImagingModes.length > 0) {
      errors.push("未选择 SAR 时不能保留 SAR 成像方式");
    }
  }
  if (!Array.isArray(task.observationTargets) || task.observationTargets.length === 0) errors.push("至少需要一个观测目标");
  else if (task.observationTargets.length > 30 || task.observationTargets.some((target) => typeof target !== "string" || target.length > 120)) errors.push("观测目标数量或长度超限");
  if (task.orbitDirectionPreference !== undefined && !["ascending", "descending", "either"].includes(String(task.orbitDirectionPreference))) errors.push("轨向偏好无效");
  if (task.simulationLevel !== undefined && !["orbit_only", "assumed_sensor", "sensor_model"].includes(String(task.simulationLevel))) errors.push("仿真层级无效");
  if (["orbit_only", "assumed_sensor"].includes(String(task.simulationLevel)) && !["candidate", "reviewed"].includes(String(task.status))) errors.push("轨道粗筛或假设传感器结果不得直接排程或下发");
  if (task.simulationLevel === "assumed_sensor" && task.opportunityId !== undefined) {
    const instrumentId = String(task.instrumentId ?? "");
    const orbitVersion = String(task.orbitVersion ?? "");
    if (!/^ty-(?:c|x)sar-v\d+$/.test(instrumentId) || !orbitVersion.endsWith(`:payload:${instrumentId}`)) {
      errors.push("试算机会的载荷参数版本缺失或不匹配，请重新计算卫星任务机会");
    }
  }
  if (task.satelliteNoradId !== undefined) boundedNumber(task.satelliteNoradId, 1, 69_999, "NORAD 编号", errors, true);
  if (task.closestApproachAt !== undefined && !Number.isFinite(Date.parse(String(task.closestApproachAt)))) errors.push("最近轨道近接时间无效");
  if (task.closestSubpointLatitude !== undefined) boundedNumber(task.closestSubpointLatitude, -90, 90, "最近子星点纬度", errors);
  if (task.closestSubpointLongitude !== undefined) boundedNumber(task.closestSubpointLongitude, -180, 180, "最近子星点经度", errors);
  if (task.minimumGroundTrackDistanceKm !== undefined) boundedNumber(task.minimumGroundTrackDistanceKm, 0, 20_050, "最小地面轨迹距离", errors);
  if (task.orbitSearchRadiusKm !== undefined) boundedNumber(task.orbitSearchRadiusKm, 50, 1_000, "轨道搜索半径", errors);
  if (task.opportunityOrbitDirection !== undefined && !["ascending", "descending"].includes(String(task.opportunityOrbitDirection))) errors.push("候选机会轨向无效");
  if (task.opportunityLookSide !== undefined && !["left", "right"].includes(String(task.opportunityLookSide))) errors.push("候选机会侧视方向无效");
  if (task.opportunityCoveragePercent !== undefined) boundedNumber(task.opportunityCoveragePercent, 0, 100, "候选机会覆盖率", errors);
  if (task.opportunitySpatialResolutionM !== undefined) boundedNumber(task.opportunitySpatialResolutionM, 0.1, 10_000, "候选机会分辨率", errors);
  if (task.opportunitySceneCrossTrackKm !== undefined) boundedNumber(task.opportunitySceneCrossTrackKm, 0.1, 1_000, "候选场景横轨宽度", errors);
  if (task.opportunitySceneAlongTrackKm !== undefined) boundedNumber(task.opportunitySceneAlongTrackKm, 0.1, 3_000, "候选场景沿轨长度", errors);
  if (task.sensorParameterStatus !== undefined && !["user_provided", "provisional_assumption"].includes(String(task.sensorParameterStatus))) errors.push("传感器参数状态无效");
  if (task.opportunityFootprint !== undefined) {
    const footprint = validateGeoGeometry(task.opportunityFootprint, { maximumVertices: 20, maximumRingVertices: 20, maximumAreaKm2: 500_000, rejectUnsplitAntimeridian: true });
    if (!footprint.ok || !["Polygon", "MultiPolygon"].includes(String((task.opportunityFootprint as { type?: unknown })?.type))) errors.push("候选成像足迹无效");
  }
  if (task.referenceAcquisitionRequired !== undefined && typeof task.referenceAcquisitionRequired !== "boolean") errors.push("灾前参考影像要求必须是布尔值");
  if (task.sarAnalysisMode !== undefined && !["amplitude_change", "insar_pair", "amplitude_change_and_insar_pair"].includes(String(task.sarAnalysisMode))) errors.push("SAR 分析模式无效");
  if (task.sarAnalysisMode !== undefined && (!Array.isArray(task.sensors) || !task.sensors.includes("SAR"))) errors.push("SAR 分析模式必须选择 SAR 载荷");
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
  if (task.timeIndexedAoi !== undefined && !isValidTimeIndexedAoi(task.timeIndexedAoi, start, end)) errors.push("逐时台风 AOI 字段无效或超出任务时间窗");
  if (task.cycloneTrackingTarget !== undefined && !["center", "wind_field", "uncertainty_area"].includes(String(task.cycloneTrackingTarget))) errors.push("台风动态跟踪目标无效");
  validateCycloneTrackingSelection(task, start, end, errors);
  if (!isValidApproval(task.aoiApproval)) errors.push("AOI 审批状态无效");
  if (options.requireApproved && task.aoiApproval !== "source_verified" && task.aoiApproval !== "operator_confirmed") errors.push("任务尚未通过 AOI 审批");
  if (options.requireApproved && task.aoiApproval === "source_verified" && task.aoiType !== "source") errors.push("来源核验任务必须使用不可修改的来源几何");
  if (options.requireApproved && task.aoiApproval === "operator_confirmed" && (typeof task.approvalReason !== "string" || !task.approvalReason.trim() || task.approvalReason.length > 500)) errors.push("人工核对任务必须填写审批理由");
  const revision = Number(task.revision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) errors.push("任务 revision 必须是非负整数");
  if (options.requireProvenance) {
    if (typeof task.eventRevision !== "string" || !/^[a-f0-9]{64}$/.test(task.eventRevision)) errors.push("缺少有效事件版本指纹");
    if (typeof task.aoiHash !== "string" || !/^[a-f0-9]{64}$/.test(task.aoiHash)) errors.push("缺少有效 AOI 指纹");
    const forecast = task.cycloneForecast as Record<string, unknown> | undefined;
    if (forecast?.impactField !== undefined && task.aoiType === "source" && (!Array.isArray(task.timeIndexedAoi) || task.timeIndexedAoi.length === 0)) errors.push("台风预测 AOI 任务缺少与成像窗匹配的逐时影响场");
  }
  if (task.source === "演示数据") errors.push("演示事件禁止进入任务流");
  return errors.length ? { ok: false, errors } : { ok: true };
}

function validateCycloneTrackingSelection(task: Record<string, unknown>, taskStart: number, taskEnd: number, errors: string[]) {
  const slices = Array.isArray(task.timeIndexedAoi) ? task.timeIndexedAoi : [];
  const dynamicTask = task.hazard === "cyclone" && task.aoiType === "source" && slices.length > 0;
  const fields = ["trackingValidFrom", "trackingValidTo", "trackingLeadHours", "trackingCenterLatitude", "trackingCenterLongitude", "trackingCenterBasis", "trackingThresholdKnots"];
  const hasSelection = fields.some((field) => task[field] !== undefined);
  if (dynamicTask && task.opportunityId !== undefined && !hasSelection) {
    errors.push("已选台风机会未绑定逐时预测片，请重新计算动态跟踪机会");
    return;
  }
  if (!hasSelection) return;
  if (!dynamicTask) { errors.push("逐时跟踪字段只能用于台风来源 AOI 任务"); return; }
  const validFrom = Date.parse(String(task.trackingValidFrom ?? ""));
  const validTo = Date.parse(String(task.trackingValidTo ?? ""));
  const leadHours = Number(task.trackingLeadHours);
  const latitude = Number(task.trackingCenterLatitude);
  const longitude = Number(task.trackingCenterLongitude);
  const threshold = task.trackingThresholdKnots === undefined ? undefined : Number(task.trackingThresholdKnots);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validTo <= validFrom || validFrom < taskStart || validTo > taskEnd) errors.push("台风跟踪预测片时间无效");
  if (!Number.isInteger(leadHours) || leadHours < 0 || leadHours > 360) errors.push("台风跟踪提前时效无效");
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) errors.push("台风跟踪中心坐标无效");
  if (!["official_node", "interpolated_official_track"].includes(String(task.trackingCenterBasis))) errors.push("台风跟踪中心依据无效");
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 250)) errors.push("台风跟踪风圈阈值无效");
  const selected = slices.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const slice = candidate as Record<string, unknown>;
    const center = slice.center;
    return slice.validFrom === task.trackingValidFrom && slice.validTo === task.trackingValidTo && Number(slice.leadHours) === leadHours
      && Array.isArray(center) && Number(center[0]) === longitude && Number(center[1]) === latitude && slice.centerBasis === task.trackingCenterBasis;
  }) as Record<string, unknown> | undefined;
  if (!selected) errors.push("台风跟踪机会与当前官方逐时预测片不匹配");
  const closest = Date.parse(String(task.closestApproachAt ?? ""));
  if (Number.isFinite(closest) && Number.isFinite(validFrom) && Number.isFinite(validTo) && (closest < validFrom || closest > validTo)) errors.push("卫星最近过境时刻不在所选台风预测片内");
  if (task.cycloneTrackingTarget === "wind_field" && selected?.windGeometry === undefined) errors.push("所选预测片没有风圈几何");
  if (task.cycloneTrackingTarget === "uncertainty_area" && selected?.uncertaintyGeometry === undefined) errors.push("所选预测片没有不确定区几何");
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

export function allowedOperatorTaskStatuses(from: string): TaskStatus[] {
  if (!operatorEditableTaskStatuses.includes(from as TaskStatus)) return taskStatuses.includes(from as TaskStatus) ? [from as TaskStatus] : ["candidate"];
  return [from as TaskStatus, ...transitions[from as TaskStatus].filter((status) => operatorEditableTaskStatuses.includes(status))];
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

function validateExecutionProvenance(task: Record<string, unknown>, errors: string[]) {
  const status = task.status as TaskStatus;
  const requireText = (field: string, label: string) => {
    if (typeof task[field] !== "string" || !String(task[field]).trim() || String(task[field]).length > 220) errors.push(`${label}缺失或无效`);
  };
  if (["scheduled", "submitted", "cancellation_requested", "cancel_acknowledged", "cancel_rejected", "acquired", "completed"].includes(status)) {
    for (const [field, label] of [["satelliteId", "卫星ID"], ["instrumentId", "载荷ID"], ["imagingMode", "成像模式"], ["opportunityId", "成像机会ID"], ["orbitVersion", "轨道版本"], ["visibilityComputedAt", "可见性计算时间"]]) requireText(field, label);
  }
  if (["submitted", "cancellation_requested", "cancel_acknowledged", "cancel_rejected", "acquired", "completed"].includes(status)) {
    requireText("dispatchId", "下发回执ID");
    requireText("dispatchAcceptedAt", "下发确认时间");
  }
  if (["cancellation_requested", "cancel_acknowledged", "cancel_rejected"].includes(status)) {
    requireText("cancellationRequestId", "撤回请求ID");
    requireText("cancellationRequestedAt", "撤回请求时间");
  }
  if (status === "cancel_acknowledged") requireText("cancellationAcknowledgedAt", "撤回确认时间");
  if (["acquired", "completed"].includes(status)) {
    requireText("acquisitionId", "成像回执ID");
    requireText("acquiredAt", "成像回执时间");
  }
  if (status === "completed") {
    if (!Array.isArray(task.productIds) || task.productIds.length === 0 || task.productIds.length > 100 || task.productIds.some((value) => typeof value !== "string" || !value.trim() || value.length > 220)) errors.push("完成状态必须包含有效产品ID");
    requireText("completedAt", "产品完成时间");
  }
  for (const field of ["visibilityComputedAt", "dispatchAcceptedAt", "cancellationRequestedAt", "cancellationAcknowledgedAt", "acquiredAt", "completedAt"]) {
    if (task[field] !== undefined && !Number.isFinite(Date.parse(String(task[field])))) errors.push(`${field} 必须是有效时间`);
  }
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
  if (type === "source") return isGeometry(task.sourceGeometry, 25_000_000)
    && ["Polygon", "MultiPolygon"].includes(String((task.sourceGeometry as { type?: unknown })?.type));
  const radius = Number(task.aoiRadiusKm);
  const width = Number(task.aoiWidthKm);
  const height = Number(task.aoiHeightKm);
  const length = Number(task.aoiLengthKm);
  const bearing = Number(task.aoiBearingDeg);
  if (type === "point") return Number.isFinite(radius) && radius >= 0 && radius <= 100;
  if (type === "circle") return Number.isFinite(radius) && radius >= 1 && radius <= 1000;
  if (type === "rectangle") return Number.isFinite(width) && width >= 1 && width <= 2000 && Number.isFinite(height) && height >= 1 && height <= 2000;
  if (type === "corridor") return Number.isFinite(width) && width >= 1 && width <= 500 && Number.isFinite(length) && length >= 1 && length <= 3000 && Number.isFinite(bearing) && bearing >= 0 && bearing < 360;
  if (type === "polygon") return isGeometry(task.customGeometry, 2_000_000) && (task.customGeometry as { type?: unknown }).type === "Polygon";
  if (type === "multi") return isGeometry(task.customGeometry, 2_000_000) && (task.customGeometry as { type?: unknown }).type === "MultiPolygon";
  return false;
}

function isGeometry(value: unknown, maximumAreaKm2 = 25_000_000) {
  return validateGeoGeometry(value, {
    maximumVertices: 10_000,
    maximumRingVertices: 2_000,
    maximumAreaKm2,
    rejectUnsplitAntimeridian: true,
  }).ok;
}

function isValidCycloneForecast(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const forecast = value as Record<string, unknown>;
  if (forecast.official !== true || typeof forecast.source !== "string" || forecast.source.length > 120 || !safeHttpUrl(forecast.sourceUrl, "")) return false;
  if (!Number.isFinite(Date.parse(String(forecast.issuedAt ?? ""))) || !Number.isFinite(Date.parse(String(forecast.forecastValidUntil ?? "")))) return false;
  if (!Array.isArray(forecast.track) || forecast.track.length < 2 || forecast.track.length > 30 || !isGeometry(forecast.trackGeometry)) return false;
  // Official forecast circles may overlap by design. They are display/evidence
  // geometry, not an operator-authored AOI, so overlap is acceptable while
  // every individual polygon must still be topologically valid and bounded.
  if (forecast.uncertaintyGeometry !== undefined && !isForecastUncertaintyGeometry(forecast.uncertaintyGeometry)) return false;
  if (forecast.impactGeometry !== undefined && !isGeometry(forecast.impactGeometry)) return false;
  if (forecast.impactField !== undefined && !isValidCycloneImpactField(forecast.impactField)) return false;
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

function isValidCycloneImpactField(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  if (field.temporalResolutionHours !== 1 || !Array.isArray(field.frames) || field.frames.length < 2 || field.frames.length > 361) return false;
  return field.frames.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const frame = item as Record<string, unknown>;
    const latitude = Number(frame.latitude);
    const longitude = Number(frame.longitude);
    const leadHours = Number(frame.leadHours);
    const uncertaintyRadiusKm = frame.uncertaintyRadiusKm === undefined ? undefined : Number(frame.uncertaintyRadiusKm);
    if (!Number.isFinite(Date.parse(String(frame.forecastAt ?? ""))) || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isInteger(leadHours) || leadHours < 0 || leadHours > 360) return false;
    if (uncertaintyRadiusKm !== undefined && (!Number.isFinite(uncertaintyRadiusKm) || uncertaintyRadiusKm <= 0 || uncertaintyRadiusKm > 3000)) return false;
    if (frame.uncertaintyGeometry !== undefined && !isGeometry(frame.uncertaintyGeometry)) return false;
    if (!Array.isArray(frame.windFields) || frame.windFields.length > 8) return false;
    return frame.windFields.every((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const wind = candidate as Record<string, unknown>;
      const quadrants = wind.quadrantsKm as Record<string, unknown> | undefined;
      return Number.isFinite(Number(wind.thresholdKnots)) && Number(wind.thresholdKnots) > 0 && Number(wind.thresholdKnots) <= 250
        && Boolean(quadrants) && ["northeast", "southeast", "southwest", "northwest"].every((key) => Number.isFinite(Number(quadrants?.[key])) && Number(quadrants?.[key]) >= 0 && Number(quadrants?.[key]) <= 3000);
    });
  });
}

function isForecastUncertaintyGeometry(value: unknown) {
  return validateGeoGeometry(value, {
    maximumVertices: 10_000,
    maximumRingVertices: 2_000,
    maximumAreaKm2: 25_000_000,
    rejectUnsplitAntimeridian: true,
    allowOverlappingMultiPolygon: true,
  }).ok;
}

function isValidTimeIndexedAoi(value: unknown, taskStart: number, taskEnd: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 361) return false;
  let priorStart = Number.NEGATIVE_INFINITY;
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const slice = item as Record<string, unknown>;
    const validFrom = Date.parse(String(slice.validFrom ?? ""));
    const validTo = Date.parse(String(slice.validTo ?? ""));
    const center = slice.center;
    const leadHours = Number(slice.leadHours);
    const threshold = slice.thresholdKnots === undefined ? undefined : Number(slice.thresholdKnots);
    const valid = Number.isFinite(validFrom) && Number.isFinite(validTo) && validTo > validFrom
      && validFrom >= taskStart && validTo <= taskEnd && validFrom >= priorStart
      && Number.isInteger(leadHours) && leadHours >= 0 && leadHours <= 360
      && Array.isArray(center) && center.length === 2
      && Number.isFinite(Number(center[0])) && Number(center[0]) >= -180 && Number(center[0]) <= 180
      && Number.isFinite(Number(center[1])) && Number(center[1]) >= -90 && Number(center[1]) <= 90
      && (slice.centerBasis === "official_node" || slice.centerBasis === "interpolated_official_track")
      && (threshold === undefined || (Number.isFinite(threshold) && threshold > 0 && threshold <= 250))
      && (slice.windGeometry === undefined || isGeometry(slice.windGeometry, 25_000_000))
      && (slice.uncertaintyGeometry === undefined || isGeometry(slice.uncertaintyGeometry, 25_000_000))
      && (slice.windGeometry !== undefined || slice.uncertaintyGeometry !== undefined);
    priorStart = validFrom;
    return valid;
  });
}

export function validateTaskAoi(task: Record<string, unknown>, aoi: unknown) {
  if (!isGeometry(aoi)) return false;
  if (task.aoiType === "source") return JSON.stringify(aoi) === JSON.stringify(task.sourceGeometry);
  if (task.aoiType === "polygon" || task.aoiType === "multi") return JSON.stringify(aoi) === JSON.stringify(task.customGeometry);
  return true;
}
