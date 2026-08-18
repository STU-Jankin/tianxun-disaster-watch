export type HazardType =
  | "earthquake"
  | "tsunami"
  | "wildfire"
  | "flood"
  | "cyclone"
  | "volcano"
  | "landslide"
  | "drought"
  | "dust"
  | "ice";

export type ScopeId = "wuxi" | "jiangsu" | "china" | "global";
export type PhenomenonStage = "observed" | "forecast" | "warning" | "driver" | "context";

export type EventEvidence = {
  source: string;
  sourceUrl: string;
  sourceEventId: string;
  observedAt: string;
  role: "detection" | "warning" | "verification" | "driver" | "context";
};

export type EventUpdate = {
  source: string;
  sourceUrl: string;
  sourceEventId: string;
  title: string;
  observedAt: string;
  sourceSeverity: string;
};

export type EventGeometry = {
  type: "Point" | "LineString" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type CycloneForecastPoint = {
  forecastAt: string;
  latitude: number;
  longitude: number;
  leadHours: number;
  windSpeedKnots?: number;
  pressureHpa?: number;
  category?: string;
};

export type CycloneQuadrantRadiiKm = {
  northeast: number;
  southeast: number;
  southwest: number;
  northwest: number;
};

export type CycloneWindField = {
  thresholdKnots: number;
  quadrantsKm: CycloneQuadrantRadiiKm;
  basis: "official_quadrants" | "derived_official_polygon" | "official_circular_extent" | "interpolated_official_fields";
};

export type CycloneImpactFrame = {
  forecastAt: string;
  leadHours: number;
  latitude: number;
  longitude: number;
  centerBasis: "official_node" | "interpolated_official_track";
  uncertaintyRadiusKm?: number;
  uncertaintyGeometry?: EventGeometry;
  windFields: CycloneWindField[];
};

export type CycloneImpactField = {
  temporalResolutionHours: 1;
  frames: CycloneImpactFrame[];
  interpolation: "linear_between_official_nodes";
  uncertaintyBasis: "time_sliced_official" | "official_advisory_envelope" | "not_available";
  note: string;
};

export type CycloneForecast = {
  official: true;
  source: string;
  sourceUrl: string;
  advisory?: string;
  issuedAt: string;
  forecastValidUntil: string;
  track: CycloneForecastPoint[];
  trackGeometry: EventGeometry;
  uncertaintyGeometry?: EventGeometry;
  uncertaintyLabel?: string;
  impactGeometry?: EventGeometry;
  impactField?: CycloneImpactField;
  impactBasis: "forecast_wind_radii" | "current_wind_extent" | "uncertainty_only";
  impactThreshold?: string;
  note: string;
};

export type DisasterEvent = {
  id: string;
  masterEventId: string;
  entityKey: string;
  title: string;
  hazard: HazardType;
  latitude: number;
  longitude: number;
  occurredAt: string;
  updatedAt: string;
  activityAt: string;
  issuedAt: string;
  validFrom?: string;
  validTo?: string;
  phenomenonStage: PhenomenonStage;
  source: string;
  sourceUrl: string;
  sourceSeverity: string;
  severity: "red" | "orange" | "yellow" | "blue";
  magnitude?: number;
  magnitudeUnit?: string;
  country?: string;
  description?: string;
  lifecycleStatus: "active" | "monitoring" | "resolved" | "archived";
  sourcePresence: "current" | "retained";
  evidence: EventEvidence[];
  evidenceCount: number;
  updateHistory: EventUpdate[];
  updateCount: number;
  confidenceScore: number;
  confidenceLevel: "high" | "medium" | "low";
  geometryType: "Point" | "LineString" | "Polygon" | "MultiPolygon";
  geometry: EventGeometry;
  cycloneForecast?: CycloneForecast;
  locationQuality: "precise" | "estimated" | "representative" | "unknown";
  locationAccuracyKm: number;
  aoiApprovalRequired: boolean;
  dispatchEligibility: "ready" | "review_required" | "blocked";
  observable: "direct" | "consequence" | "conditional";
  observationTargets: string[];
  recommendedSensors: string[];
  scope: ScopeId;
  priority: number;
  priorityBreakdown: {
    severity: number;
    scope: number;
    observability: number;
    time: number;
    confidence: number;
  };
  observationGoldenHours: number;
  observationWindowHours: number;
  observationReviewAt: string;
  observationExpiresAt: string;
  observationHardReviewAt: string;
  observationReferenceAt: string;
  observationRationale: string;
  observationPolicyVersion: string;
  observationPhase: "forecast" | "golden" | "followup" | "archive";
  observationStatus: "actionable" | "review_required" | "expired";
};

export const observationWindowPolicy: Record<
  HazardType,
  { goldenHours: number; followupHours: number; hardReviewHours: number; forecastHorizonHours: number; label: string; rationale: string }
> = {
  earthquake: { goldenHours: 72, followupHours: 720, hardReviewHours: 2160, forecastHorizonHours: 72, label: "72小时 / 30天", rationale: "前3天优先损毁与滑坡；SAR形变依轨道重访可延至30天，90天强制重审" },
  tsunami: { goldenHours: 24, followupHours: 336, hardReviewHours: 720, forecastHorizonHours: 72, label: "24小时 / 14天", rationale: "首日优先沿岸淹没与港口；岸线冲刷与漂浮物复核至14天" },
  wildfire: { goldenHours: 24, followupHours: 720, hardReviewHours: 2160, forecastHorizonHours: 168, label: "24小时 / 30天", rationale: "活跃火点和火线按小时级复访；过火面与烧毁强度保留30天" },
  flood: { goldenHours: 72, followupHours: 336, hardReviewHours: 720, forecastHorizonHours: 240, label: "72小时 / 14天", rationale: "洪峰和淹没前3天优先；退水与堤防复核至14天，流域慢洪需人工延长" },
  cyclone: { goldenHours: 24, followupHours: 336, hardReviewHours: 720, forecastHorizonHours: 240, label: "24小时 / 14天", rationale: "路径与风圈严格服从官方报次有效期；登陆后损毁复核至14天" },
  volcano: { goldenHours: 72, followupHours: 2160, hardReviewHours: 8760, forecastHorizonHours: 336, label: "72小时 / 90天", rationale: "热异常、火山灰与熔岩前3天密集观测；形变序列至90天" },
  landslide: { goldenHours: 72, followupHours: 720, hardReviewHours: 2160, forecastHorizonHours: 168, label: "72小时 / 30天", rationale: "滑坡范围、堵江与应急通道前3天优先；残余形变至30天" },
  drought: { goldenHours: 720, followupHours: 8760, hardReviewHours: 17520, forecastHorizonHours: 2160, label: "30天 / 365天", rationale: "慢发过程以月度和季节基线判定；每30天复核，不使用快灾时效逻辑" },
  dust: { goldenHours: 6, followupHours: 36, hardReviewHours: 72, forecastHorizonHours: 72, label: "6小时 / 36小时", rationale: "宽幅高频跟踪输送过程；连续36小时无实质更新则归档" },
  ice: { goldenHours: 168, followupHours: 2160, hardReviewHours: 8760, forecastHorizonHours: 720, label: "7天 / 90天", rationale: "冰湖、海冰与雪崩以周度复访起步；季节变化至90天后重审" },
};

export const severityWindowMultiplier: Record<DisasterEvent["severity"], number> = {
  red: 1.35,
  orange: 1.2,
  yellow: 1.1,
  blue: 1,
};

export const scopes = {
  wuxi: {
    id: "wuxi" as const,
    label: "无锡市",
    short: "无锡",
    weight: 25,
    bbox: [119.5, 31.1, 120.75, 32.05] as const,
  },
  jiangsu: {
    id: "jiangsu" as const,
    label: "江苏省",
    short: "江苏",
    weight: 17,
    bbox: [116.3, 30.7, 122.1, 35.25] as const,
  },
  china: {
    id: "china" as const,
    label: "中国",
    short: "中国",
    weight: 9,
    bbox: [73.4, 18.0, 135.2, 53.7] as const,
  },
  global: {
    id: "global" as const,
    label: "全球",
    short: "全球",
    weight: 0,
    bbox: [-180, -78, 180, 78] as const,
  },
};

export const hazardMeta: Record<
  HazardType,
  { label: string; symbol: string; targets: string[]; sensors: string[]; observable: DisasterEvent["observable"] }
> = {
  earthquake: { label: "地震", symbol: "震", targets: ["地表破裂", "形变", "次生滑坡", "建筑损毁"], sensors: ["SAR", "高分光学"], observable: "consequence" },
  tsunami: { label: "海啸", symbol: "啸", targets: ["沿岸淹没", "岸线冲刷", "漂浮物", "港口损毁"], sensors: ["SAR", "宽幅光学", "高分光学"], observable: "consequence" },
  wildfire: { label: "火灾", symbol: "火", targets: ["火点", "火线", "烟羽", "过火区"], sensors: ["热红外", "多光谱"], observable: "direct" },
  flood: { label: "洪水", symbol: "洪", targets: ["淹没范围", "河道扩张", "堤坝异常"], sensors: ["SAR", "多光谱"], observable: "direct" },
  cyclone: { label: "气旋", symbol: "风", targets: ["云系结构", "台风眼", "外围雨带"], sensors: ["宽幅光学", "红外"], observable: "direct" },
  volcano: { label: "火山", symbol: "山", targets: ["热异常", "熔岩", "火山灰", "羽流"], sensors: ["热红外", "高光谱"], observable: "direct" },
  landslide: { label: "滑坡", symbol: "滑", targets: ["滑坡斑块", "堆积体", "堵江"], sensors: ["高分光学", "SAR"], observable: "consequence" },
  drought: { label: "干旱", symbol: "旱", targets: ["植被异常", "水体萎缩", "地表温度"], sensors: ["多光谱", "热红外"], observable: "direct" },
  dust: { label: "沙尘", symbol: "尘", targets: ["沙尘范围", "移动方向"], sensors: ["宽幅多光谱"], observable: "direct" },
  ice: { label: "冰雪", symbol: "冰", targets: ["海冰", "冰湖", "雪崩堆积"], sensors: ["SAR", "多光谱"], observable: "direct" },
};

export function classifyScope(latitude: number, longitude: number, locationText = ""): ScopeId {
  const location = locationText.toLowerCase();
  const inWuxi = /无锡|wuxi|太湖|taihu/.test(location);
  const inJiangsu = inWuxi || /江苏|jiangsu|南京|nanjing|苏州|suzhou|常州|changzhou|南通|nantong|扬州|yangzhou|镇江|zhenjiang|泰州|taizhou|盐城|yancheng|淮安|huai'an|huaian|宿迁|suqian|徐州|xuzhou|连云港|lianyungang/.test(location);
  const inChina = inJiangsu || /中国|china|北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门/.test(location);
  if (inWuxi && inside(latitude, longitude, scopes.wuxi.bbox)) return "wuxi";
  if (inJiangsu && inside(latitude, longitude, scopes.jiangsu.bbox)) return "jiangsu";
  if (inChina && inside(latitude, longitude, scopes.china.bbox)) return "china";
  return "global";
}

export function isVisibleInScope(eventScope: ScopeId, selected: ScopeId) {
  if (selected === "global") return true;
  const rank: Record<ScopeId, number> = { wuxi: 0, jiangsu: 1, china: 2, global: 3 };
  return rank[eventScope] <= rank[selected];
}

function inside(lat: number, lon: number, bbox: readonly number[]) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

export function normalizeSeverity(value: string, magnitude?: number): DisasterEvent["severity"] {
  const normalized = value.toLowerCase();
  if (/red|extreme|红色|特别严重/.test(normalized) || (magnitude ?? 0) >= 7) return "red";
  if (/orange|severe|橙色|严重/.test(normalized) || (magnitude ?? 0) >= 6) return "orange";
  if (/yellow|moderate|黄色|较重/.test(normalized) || (magnitude ?? 0) >= 5) return "yellow";
  return "blue";
}

export function normalizeEarthquakeSeverity(magnitude?: number): DisasterEvent["severity"] {
  if ((magnitude ?? 0) >= 7) return "red";
  if ((magnitude ?? 0) >= 6) return "orange";
  if ((magnitude ?? 0) >= 5) return "yellow";
  return "blue";
}

export function normalizeCapSeverity(severity: string, urgency = "", certainty = ""): DisasterEvent["severity"] {
  const combined = `${severity} ${urgency} ${certainty}`.toLowerCase();
  if (/extreme|红色/.test(combined) && /immediate|expected|observed|立即|已发生/.test(combined)) return "red";
  if (/extreme|severe|橙色|严重/.test(combined)) return "orange";
  if (/moderate|yellow|黄色|较重/.test(combined)) return "yellow";
  return "blue";
}

export function calculatePriority(
  severity: DisasterEvent["severity"],
  scope: ScopeId,
  hazard: HazardType,
  occurredAt: string,
  observable: DisasterEvent["observable"] = hazardMeta[hazard].observable,
  confidenceScore = 100,
  temporal: { phenomenonStage?: PhenomenonStage; issuedAt?: string; validFrom?: string } = {},
) {
  const severityScore = { red: 35, orange: 30, yellow: 24, blue: 18 }[severity];
  const timeScore = calculateTimeScore(occurredAt, temporal);
  const observability = observable === "direct" ? 10 : observable === "consequence" ? 8 : 6;
  const confidence = confidenceScore >= 85 ? 0 : confidenceScore >= 70 ? -8 : -20;
  const breakdown = {
    severity: severityScore,
    scope: scopes[scope].weight,
    observability,
    time: timeScore,
    confidence,
  };
  return {
    total: Math.min(100, Object.values(breakdown).reduce((sum, value) => sum + value, 0)),
    ...breakdown,
  };
}

export function calculateTimeScore(occurredAt: string, temporal: { phenomenonStage?: PhenomenonStage; issuedAt?: string; validFrom?: string } = {}) {
  const occurred = new Date(occurredAt).getTime();
  if (!Number.isFinite(occurred)) return 0;
  const now = Date.now();
  const stage = temporal.phenomenonStage ?? "observed";
  if (stage === "driver" || stage === "context") return stage === "driver" ? 0 : 4;
  if (stage === "warning" || stage === "forecast") {
    const issued = new Date(temporal.issuedAt ?? occurredAt).getTime();
    const validFrom = new Date(temporal.validFrom ?? occurredAt).getTime();
    if (!Number.isFinite(issued) || !Number.isFinite(validFrom)) return 0;
    const issueAgeHours = Math.max(0, (now - issued) / 3_600_000);
    const leadHours = Math.max(0, (validFrom - now) / 3_600_000);
    const ceiling = stage === "warning" ? 18 : 15;
    return Math.max(0, Math.round(ceiling * 2 ** (-issueAgeHours / 72) * 2 ** (-leadHours / 120)));
  }
  if (occurred > now + 5 * 60_000) return 0;
  const ageHours = Math.max(0, (now - occurred) / 3_600_000);
  // 七天半衰期：刚发生为30分，1/3/7/14/30天约为27/22/15/8/2分。
  return Math.max(0, Math.min(30, Math.round(30 * 2 ** (-ageHours / 168))));
}

export function getObservationTimeline(
  occurredAt: string,
  activityAt: string,
  hazard: HazardType,
  severity: DisasterEvent["severity"],
  context: {
    phenomenonStage?: PhenomenonStage;
    issuedAt?: string;
    validFrom?: string;
    validTo?: string;
    forecastValidUntil?: string;
    targets?: string[];
    sensors?: string[];
  } = {},
) {
  const occurred = new Date(occurredAt).getTime();
  const activity = new Date(activityAt).getTime();
  const issued = new Date(context.issuedAt ?? activityAt).getTime();
  const validFrom = new Date(context.validFrom ?? occurredAt).getTime();
  const declaredEnds = [context.validTo, context.forecastValidUntil]
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  const latestActivity = Math.max(
    Number.isFinite(occurred) ? occurred : 0,
    Number.isFinite(activity) ? activity : 0,
  );
  const policy = observationWindowPolicy[hazard];
  const stage = context.phenomenonStage ?? "observed";
  const goldenHours = policy.goldenHours;
  const now = Date.now();
  if (stage === "forecast" || stage === "warning") {
    const referenceAt = Number.isFinite(validFrom) ? validFrom : Number.isFinite(issued) ? issued : latestActivity;
    const horizonEnd = (Number.isFinite(issued) ? issued : latestActivity) + policy.forecastHorizonHours * 3_600_000;
    const declaredEnd = declaredEnds.length ? Math.min(...declaredEnds) : horizonEnd;
    const expiresAt = Math.min(declaredEnd, horizonEnd);
    const reviewAt = Math.min(referenceAt + goldenHours * 3_600_000, expiresAt);
    const hardReviewAt = expiresAt;
    const phase = now < referenceAt ? "forecast" as const : now < reviewAt ? "golden" as const : now < expiresAt ? "followup" as const : "archive" as const;
    return {
      goldenHours,
      followupHours: Math.max(0, Math.round((expiresAt - referenceAt) / 3_600_000)),
      reviewAt: new Date(reviewAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      hardReviewAt: new Date(hardReviewAt).toISOString(),
      referenceAt: new Date(referenceAt).toISOString(),
      phase,
      requiresReview: !declaredEnds.length,
      rationale: `${stage === "forecast" ? "预报" : "预警"}任务严格截止于权威有效期；严重度不延长官方报次。${policy.rationale}`,
    };
  }
  const longTermTarget = (context.targets ?? []).some((target) => /形变|过火|烧毁|植被|水体|岸线|堆积|退水|损毁|冰|雪/.test(target));
  const persistentSensor = (context.sensors ?? []).some((sensor) => /SAR|多光谱|高分/.test(sensor));
  const scienceMultiplier = Math.min(1.5, 1 + (longTermTarget ? 0.2 : 0) + (persistentSensor ? 0.1 : 0));
  const followupHours = Math.max(goldenHours, Math.round(policy.followupHours * severityWindowMultiplier[severity] * scienceMultiplier));
  const referenceAt = Number.isFinite(occurred) ? occurred : latestActivity;
  const reviewAt = referenceAt + goldenHours * 3_600_000;
  // 只有实质活动时间可以推迟归档；达到硬复核点后必须重新确认AOI和观测价值。
  const expiresAt = latestActivity + followupHours * 3_600_000;
  const hardReviewAt = referenceAt + policy.hardReviewHours * 3_600_000;
  const phase = now < reviewAt ? "golden" as const : now < expiresAt ? "followup" as const : "archive" as const;
  return {
    goldenHours,
    followupHours,
    reviewAt: new Date(reviewAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    hardReviewAt: new Date(hardReviewAt).toISOString(),
    referenceAt: new Date(referenceAt).toISOString(),
    phase,
    requiresReview: stage === "driver" || stage === "context" || now >= hardReviewAt,
    rationale: `${policy.rationale}；${longTermTarget ? "包含长期变化目标" : "以快速应急目标为主"}${persistentSensor ? "，且载荷支持持续复访" : ""}。`,
  };
}
