export type SourceTier = "中国第一批" | "中国第二批" | "基础" | "第一优先级" | "第二优先级";
export type SourceRole = "事件" | "预报" | "核验";

export type SourceGovernance = {
  sourceId: string;
  authorityClass: "official" | "scientific" | "humanitarian" | "aggregator";
  pollIntervalMinutes: number;
  latencySloMinutes: number;
  updateSemantics: string;
  geometrySemantics: string;
  licenseNote: string;
};

const governanceOverrides: Record<string, Partial<SourceGovernance>> = {
  "NASA FIRMS": {
    pollIntervalMinutes: 10,
    latencySloMinutes: 180,
    updateSemantics: "同一传感器热点按时间与空间聚合；新过境可更新活跃火情，不等于火场边界。",
    geometrySemantics: "热异常像元中心点；不是过火区或火线边界。",
  },
  "NOAA NHC": {
    pollIntervalMinutes: 10,
    latencySloMinutes: 30,
    updateSemantics: "按官方风暴编号与报次更新；新报次替代旧预测，但保留历史路径。",
    geometrySemantics: "官方中心路径、风圈和概率锥分别保存，不互相冒充。",
  },
  "日本气象厅 JMA 台风": {
    pollIntervalMinutes: 10,
    latencySloMinutes: 30,
    updateSemantics: "按台风编号和官方报次更新；报次失效后不得自行外推。",
    geometrySemantics: "官方中心、预报圆和强风警戒域。",
  },
  "NASA LHASA": {
    pollIntervalMinutes: 60,
    latencySloMinutes: 180,
    updateSemantics: "按官方栅格批次更新，超过产品有效期自动失效。",
    geometrySemantics: "模型风险区，不是已发生滑坡或泥石流边界。",
  },
  "Copernicus EMS Rapid Mapping": {
    pollIntervalMinutes: 30,
    latencySloMinutes: 180,
    geometrySemantics: "制图激活 AOI；不是最终灾害影响范围。",
  },
  "中国气象数据网 CMA · 地面观测": {
    pollIntervalMinutes: 180,
    latencySloMinutes: 4_320,
    updateSemantics: "按资料时次更新，只作既有事件核验，不单独创建灾害。",
    geometrySemantics: "气象站点位置，不代表灾害中心或影响边界。",
  },
  "OCHA ReliefWeb": {
    authorityClass: "humanitarian",
    pollIntervalMinutes: 60,
    latencySloMinutes: 720,
  },
  "EONET": { authorityClass: "aggregator", pollIntervalMinutes: 30, latencySloMinutes: 360 },
  "GDACS": { authorityClass: "aggregator", pollIntervalMinutes: 15, latencySloMinutes: 120 },
  "WMO SWIC/CAP": { authorityClass: "aggregator", pollIntervalMinutes: 10, latencySloMinutes: 30 },
  "WMO Alert Hub · 中国": { authorityClass: "aggregator", pollIntervalMinutes: 10, latencySloMinutes: 30 },
};

export function sourceGovernance(name: string, tier: SourceTier, role: SourceRole): SourceGovernance {
  const scientific = /USGS|NASA|Smithsonian|EMSC|GeoNet/i.test(name);
  const defaults: SourceGovernance = {
    sourceId: sourceIdForName(name),
    authorityClass: scientific ? "scientific" : "official",
    pollIntervalMinutes: role === "事件" ? 5 : role === "预报" ? 15 : 60,
    latencySloMinutes: role === "事件" ? 60 : role === "预报" ? 120 : 720,
    updateSemantics: role === "核验"
      ? "作为独立证据更新，不单独生成任务坐标；撤销或失效按来源语义处理。"
      : "按来源事件编号或灾害实体键更新；权威撤销、取消或过期进入生命周期处理。",
    geometrySemantics: role === "预报"
      ? "预报/预警适用区，不默认等同于已发生灾害边界。"
      : role === "核验" ? "核验几何或代表位置，不覆盖主事件权威几何。" : "来源提供的事件几何；非精确位置须人工复核。",
    licenseNote: tier.startsWith("中国") ? "按来源服务条款和获批权限使用" : "公开数据仍须保留来源归属并遵守各源条款",
  };
  return { ...defaults, ...governanceOverrides[name], sourceId: sourceIdForName(name) };
}

export function sourceIdForName(name: string) {
  let hash = 2_166_136_261;
  for (const character of name.normalize("NFKC")) hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const urlRules: Array<[RegExp, string]> = [
  [/earthquake\.usgs\.gov\/earthquakes/i, "USGS"],
  [/earthquake\.usgs\.gov\/fdsnws/i, "USGS Ground Failure"],
  [/seismicportal\.eu/i, "EMSC SeismicPortal"],
  [/firms\.modaps\.eosdis\.nasa\.gov/i, "NASA FIRMS"],
  [/eonet\.gsfc\.nasa\.gov/i, "EONET"],
  [/gdacs\.org/i, "GDACS"],
  [/nhc\.noaa\.gov/i, "NOAA NHC"],
  [/api\.weather\.gov/i, "NOAA/NWS Alerts"],
  [/api\.weather\.gc\.ca/i, "ECCC GeoMet Alerts"],
  [/api01\.nve\.no/i, "NVE Jordskredvarsling"],
  [/tsunami\.gov\/events\/xml\/PAAQCAP/i, "NOAA NTWC 海啸"],
  [/tsunami\.gov\/events\/xml\/PHEBCAP/i, "NOAA PTWC 海啸"],
  [/jma\.go\.jp\/bosai\/typhoon/i, "日本气象厅 JMA 台风"],
  [/severeweather\.wmo\.int/i, "WMO Alert Hub · 中国"],
  [/rapidmapping\.emergency\.copernicus\.eu/i, "Copernicus EMS Rapid Mapping"],
  [/volcanoes\.usgs\.gov/i, "USGS HANS"],
  [/api\.geonet\.org\.nz\/volcano/i, "GeoNet 火山警戒"],
  [/volcano\.si\.edu/i, "Smithsonian GVP"],
  [/pmmpublisher\.pps\.eosdis\.nasa\.gov/i, "NASA LHASA"],
  [/api\.reliefweb\.int/i, "OCHA ReliefWeb"],
  [/mem\.gov\.cn/i, "应急管理部地质灾害快报"],
  [/data\.earthquake\.cn/i, "中国地震台网"],
  [/tba\.gov\.cn/i, "太湖流域管理局"],
  [/jswater\.jiangsu\.gov\.cn/i, "江苏省水利厅"],
];

export function sourceNameForUrl(value: string, explicitName?: string) {
  if (explicitName) return explicitName;
  const match = urlRules.find(([pattern]) => pattern.test(value));
  if (match) return match[1];
  try { return new URL(value).hostname; } catch { return "unknown-source"; }
}

export function sanitizeSnapshotUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [key] of [...url.searchParams]) {
      if (/key|token|secret|pwd|pass|user(?:id)?|appname|credential/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.pathname = url.pathname.replace(/(\/api\/area\/csv\/)[^/]+/i, "$1[redacted]");
    return url.toString();
  } catch {
    return "invalid-url";
  }
}
