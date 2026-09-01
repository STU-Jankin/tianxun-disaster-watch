export type LandslidePilotRegionId = "chongqing" | "jiangsu";

export type LandslidePilotRegion = {
  id: LandslidePilotRegionId;
  label: string;
  matchBasis: "event_location_text";
  applicability: string;
  focusAreas: string[];
  observationTargets: string[];
  forecastModel: {
    id: "cma_grapes_global";
    label: "CMA GRAPES Global";
    nativeResolutionKm: 15;
    updateIntervalHours: 6;
  };
  calibrationStatus: "regional_routing_only";
  calibrationLabel: string;
  officialReferenceLabel: string;
  officialReferenceUrl: string;
  officialReviewRule: string;
  limitation: string;
};

const jiangsuFocusedArea = /南京|镇江|句容|徐州|连云港|常州|溧阳|无锡|宜兴|苏州|环太湖|宁镇|徐连/i;

export function matchLandslidePilotRegion(regionHint: string | null | undefined): LandslidePilotRegion | null {
  const hint = normalizeRegionHint(regionHint);
  if (!hint) return null;
  if (/重庆|chongqing/i.test(hint)) {
    return {
      id: "chongqing",
      label: "重庆区域试验",
      matchBasis: "event_location_text",
      applicability: "重庆全市筛查；必须按区县、乡镇级24小时官方预警图复核",
      focusAreas: ["渝东北", "渝东南", "三峡库区与高陡峡谷区"],
      observationTargets: ["高陡斜坡", "峡谷岸坡", "道路切坡", "泥石流沟道与堵江风险"],
      forecastModel: {
        id: "cma_grapes_global",
        label: "CMA GRAPES Global",
        nativeResolutionKm: 15,
        updateIntervalHours: 6,
      },
      calibrationStatus: "regional_routing_only",
      calibrationLabel: "已启用中国模式与重庆业务对照，尚未完成区县阈值校准",
      officialReferenceLabel: "重庆市24小时地质灾害预警图",
      officialReferenceUrl: "https://www.cq.gov.cn/zwgk/zfxxgkzl/fdzdgknr/yjgl/yjt/",
      officialReviewRule: "任何试验等级都不得覆盖重庆市规划自然资源、气象部门联合发布的区县/乡镇级官方等级；任务预置前必须人工对照。",
      limitation: "当前仅使用事件点附近降雨、粗分辨率土壤湿度和DEM坡度，尚未接入重庆隐患点、岩性、库岸变形与短临雷达降雨。",
    };
  }
  if (/江苏|jiangsu/i.test(hint)) {
    const focused = jiangsuFocusedArea.test(hint);
    return {
      id: "jiangsu",
      label: "江苏区域试验",
      matchBasis: "event_location_text",
      applicability: focused
        ? "命中宁镇、徐连或环太湖低山丘陵重点带，仍需核对在册隐患点"
        : "江苏全省入口；只有DEM和隐患资料确认的低山丘陵/人工切坡进入滑坡重点筛查",
      focusAreas: ["宁镇低山丘陵", "徐连低山丘陵", "环太湖低山丘陵"],
      observationTargets: ["下蜀土斜坡", "城镇与道路切坡", "矿山边坡", "崩塌与地面变形"],
      forecastModel: {
        id: "cma_grapes_global",
        label: "CMA GRAPES Global",
        nativeResolutionKm: 15,
        updateIntervalHours: 6,
      },
      calibrationStatus: "regional_routing_only",
      calibrationLabel: "已启用中国模式与江苏丘陵区口径，尚未接入省级本地预警模型参数",
      officialReferenceLabel: "江苏典型地质灾害气象风险预警模型说明",
      officialReferenceUrl: "https://jsgzw.jiangsu.gov.cn/art/2025/5/13/art_61475_11563000.html",
      officialReviewRule: "平原区降雨信号不得直接解释为滑坡风险；必须先通过DEM坡度，并核对宁镇、徐连、环太湖等易发区和在册隐患点。",
      limitation: "江苏现阶段不得套用重庆山区经验阈值；省级模型的孕灾地质条件、隐患点和地区参数尚无公开结构化接口。",
    };
  }
  return null;
}

function normalizeRegionHint(value: string | null | undefined) {
  if (!value) return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}
