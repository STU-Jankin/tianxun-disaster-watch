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

export type EventEvidence = {
  source: string;
  sourceUrl: string;
  sourceEventId: string;
  observedAt: string;
  role: "detection" | "warning" | "verification";
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
  observationPhase: "golden" | "followup" | "archive";
  observationStatus: "actionable" | "expired";
};

export const observationWindowPolicy: Record<
  HazardType,
  { goldenHours: number; followupHours: number; label: string; rationale: string }
> = {
  earthquake: { goldenHours: 168, followupHours: 720, label: "7天 / 30天", rationale: "形变、破裂、滑坡及损毁复核" },
  tsunami: { goldenHours: 72, followupHours: 720, label: "3天 / 30天", rationale: "沿岸淹没、冲刷、漂浮物与港口损毁" },
  wildfire: { goldenHours: 168, followupHours: 1080, label: "7天 / 45天", rationale: "火场演化、过火范围及烧毁强度" },
  flood: { goldenHours: 168, followupHours: 720, label: "7天 / 30天", rationale: "洪峰、退水与持续淹没监测" },
  cyclone: { goldenHours: 168, followupHours: 720, label: "7天 / 30天", rationale: "登陆影响、内涝及灾后损毁" },
  volcano: { goldenHours: 336, followupHours: 1440, label: "14天 / 60天", rationale: "热异常、熔岩、羽流与形变" },
  landslide: { goldenHours: 336, followupHours: 1440, label: "14天 / 60天", rationale: "滑坡扩张、残余形变与堰塞湖" },
  drought: { goldenHours: 720, followupHours: 4320, label: "30天 / 180天", rationale: "按月及季节基线复核慢发过程" },
  dust: { goldenHours: 24, followupHours: 72, label: "24小时 / 72小时", rationale: "跟踪沙尘输送直至过程消散" },
  ice: { goldenHours: 720, followupHours: 4320, label: "30天 / 180天", rationale: "按季节基线监测冰雪与冰湖变化" },
};

export const severityWindowMultiplier: Record<DisasterEvent["severity"], number> = {
  red: 1.5,
  orange: 1.25,
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
) {
  const severityScore = { red: 35, orange: 30, yellow: 24, blue: 18 }[severity];
  const timeScore = calculateTimeScore(occurredAt);
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

export function calculateTimeScore(occurredAt: string) {
  const occurred = new Date(occurredAt).getTime();
  if (!Number.isFinite(occurred)) return 0;
  const ageHours = Math.max(0, (Date.now() - occurred) / 3_600_000);
  // 七天半衰期：刚发生为30分，1/3/7/14/30天约为27/22/15/8/2分。
  return Math.max(0, Math.min(30, Math.round(30 * 2 ** (-ageHours / 168))));
}

export function getObservationTimeline(
  occurredAt: string,
  activityAt: string,
  hazard: HazardType,
  severity: DisasterEvent["severity"],
) {
  const occurred = new Date(occurredAt).getTime();
  const activity = new Date(activityAt).getTime();
  const latestActivity = Math.max(
    Number.isFinite(occurred) ? occurred : 0,
    Number.isFinite(activity) ? activity : 0,
  );
  const policy = observationWindowPolicy[hazard];
  const goldenHours = policy.goldenHours;
  const followupHours = Math.max(
    goldenHours,
    Math.round(policy.followupHours * severityWindowMultiplier[severity]),
  );
  const reviewAt = latestActivity + goldenHours * 3_600_000;
  // 实质活动可以延长观测期，但不能被标题或行政性修订无限续期。
  const rollingExpiry = latestActivity + followupHours * 3_600_000;
  const hardExpiry = (Number.isFinite(occurred) ? occurred : latestActivity) + followupHours * 2 * 3_600_000;
  // 仍有实质活动时 hard cap 只触发复核，不直接删除；活动停止后仍由滚动期限归档。
  const expiresAt = rollingExpiry;
  const hardReviewAt = hardExpiry;
  const now = Date.now();
  return {
    goldenHours,
    followupHours,
    reviewAt: new Date(reviewAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    hardReviewAt: new Date(hardReviewAt).toISOString(),
    phase: now < reviewAt ? "golden" as const : now < expiresAt ? "followup" as const : "archive" as const,
  };
}
