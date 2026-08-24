import type { DisasterEvent } from "./disasters.ts";
import type { CustomAoiGeometry } from "./task-aoi.ts";

export type LandslideEvidenceStage = "risk_model" | "official_warning" | "suspected" | "confirmed" | "followup" | "closed";

export type LandslideWorkflow = {
  stage: LandslideEvidenceStage;
  label: string;
  evidenceMeaning: string;
  dispatchRule: string;
  requiresTerrainReview: boolean;
};

export type TerrainSamplingPlan = {
  center: [number, number];
  radiusKm: number;
  gridSize: 7;
  spacingKm: number;
  points: Array<{ row: number; column: number; longitude: number; latitude: number }>;
  cacheKey: string;
};

export type TerrainCell = {
  row: number;
  column: number;
  longitude: number;
  latitude: number;
  elevationM: number;
  slopeDeg: number;
  aspectDeg: number;
  selected: boolean;
};

export type LandslideTerrainScreening = {
  state: "ready";
  provider: "Open-Meteo Elevation · Copernicus DEM";
  fetchedAt: string;
  center: [number, number];
  radiusKm: number;
  gridSize: 7;
  spacingKm: number;
  samples: Array<{ longitude: number; latitude: number; elevationM: number }>;
  cells: TerrainCell[];
  geometry: CustomAoiGeometry;
  selectedCellCount: number;
  maximumSlopeDeg: number;
  screeningThresholdDeg: number;
  sourceUrl: "https://open-meteo.com/en/docs/elevation-api";
  attribution: "Copernicus DEM GLO-90 · Open-Meteo";
  note: string;
};

export type LandslideTerrainResult = LandslideTerrainScreening | {
  state: "flat" | "unsupported" | "unavailable";
  provider: "Open-Meteo Elevation · Copernicus DEM";
  message: string;
  fetchedAt?: string;
  maximumSlopeDeg?: number;
  sourceUrl?: "https://open-meteo.com/en/docs/elevation-api";
  attribution?: "Copernicus DEM GLO-90 · Open-Meteo";
};

export type LandslideSarTemplate = {
  templateId: "landslide-sar-ascending" | "landslide-sar-descending";
  label: string;
  orbitDirectionPreference: "ascending" | "descending";
  sarAnalysisMode: "amplitude_change_and_insar_pair";
  referenceAcquisitionRequired: true;
  sensors: ["SAR"];
  incidenceAngleMinDeg: 25;
  incidenceAngleMaxDeg: 45;
  revisitCount: 3;
  spatialResolutionMeters: 10;
  observationTargets: string[];
  note: string;
};

const provider = "Open-Meteo Elevation · Copernicus DEM" as const;
const sourceUrl = "https://open-meteo.com/en/docs/elevation-api" as const;
const attribution = "Copernicus DEM GLO-90 · Open-Meteo" as const;
const gridSize = 7 as const;

export const landslideSarTemplates: LandslideSarTemplate[] = [
  {
    templateId: "landslide-sar-ascending",
    label: "升轨 SAR",
    orbitDirectionPreference: "ascending",
    sarAnalysisMode: "amplitude_change_and_insar_pair",
    referenceAcquisitionRequired: true,
    sensors: ["SAR"],
    incidenceAngleMinDeg: 25,
    incidenceAngleMaxDeg: 45,
    revisitCount: 3,
    spatialResolutionMeters: 10,
    observationTargets: ["滑坡斑块", "堆积体", "堵江", "残余形变", "灾前灾后幅度变化"],
    note: "升轨用于补充单一视线方向的盲区；是否可成像、阴影和叠掩必须由轨道与地形仿真复核。",
  },
  {
    templateId: "landslide-sar-descending",
    label: "降轨 SAR",
    orbitDirectionPreference: "descending",
    sarAnalysisMode: "amplitude_change_and_insar_pair",
    referenceAcquisitionRequired: true,
    sensors: ["SAR"],
    incidenceAngleMinDeg: 25,
    incidenceAngleMaxDeg: 45,
    revisitCount: 3,
    spatialResolutionMeters: 10,
    observationTargets: ["滑坡斑块", "堆积体", "堵江", "残余形变", "灾前灾后幅度变化"],
    note: "降轨与升轨形成互补观测；灾前参考影像只记录检索要求，不伪造历史成像任务。",
  },
];

export function deriveLandslideWorkflow(event: Pick<DisasterEvent, "hazard" | "phenomenonStage" | "source" | "dispatchEligibility" | "lifecycleStatus" | "sourcePresence">): LandslideWorkflow | null {
  if (event.hazard !== "landslide") return null;
  if (event.lifecycleStatus === "resolved" || event.lifecycleStatus === "archived") {
    return { stage: "closed", label: "已解除 / 已归档", evidenceMeaning: "事件已被权威解除或超过强制复核点。", dispatchRule: "不得自动建立新任务；如需灾后复盘应另建人工任务。", requiresTerrainReview: true };
  }
  if (event.sourcePresence === "retained" || event.lifecycleStatus === "monitoring") {
    return { stage: "followup", label: "后续复核期", evidenceMeaning: "当前短时源未再次报告，系统仅按原观测期保留。", dispatchRule: "只能用于残余形变或灾后复核，必须确认事件仍具观测价值。", requiresTerrainReview: true };
  }
  if (event.phenomenonStage === "forecast" || event.phenomenonStage === "driver") {
    return { stage: "risk_model", label: "模型风险信号", evidenceMeaning: "表示降雨/易发性条件，不是已经发生滑坡的遥感或现场证据。", dispatchRule: "可生成筛查候选，但必须人工圈定 AOI，禁止标记为已确认滑坡。", requiresTerrainReview: true };
  }
  if (event.phenomenonStage === "warning") {
    return { stage: "official_warning", label: "官方风险预警", evidenceMeaning: "权威机构发布了区域风险预警，预警行政区不等于滑坡体边界。", dispatchRule: "可用于预置观测，必须以地形约束缩小 AOI 并人工核对。", requiresTerrainReview: true };
  }
  if (event.dispatchEligibility === "ready") {
    return { stage: "confirmed", label: "已核验发生信号", evidenceMeaning: "事件证据达到当前系统的可下发门槛，但边界与运动状态仍需产品确认。", dispatchRule: "可建立任务；地形 AOI 仍是筛查范围，不能替代实测滑坡边界。", requiresTerrainReview: false };
  }
  return { stage: "suspected", label: "疑似发生信号", evidenceMeaning: "已有发生线索，但来源、位置或几何尚不足以作为可靠边界。", dispatchRule: "必须人工核对事件和 AOI 后再进入任务候选。", requiresTerrainReview: true };
}

export function prepareTerrainSamplingPlan(input: { longitude: unknown; latitude: unknown; radiusKm: unknown }): TerrainSamplingPlan {
  const longitude = Number(input.longitude);
  const latitude = Number(input.latitude);
  const radiusKm = Number(input.radiusKm);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -85 || latitude > 85) throw new Error("地形筛查中心坐标无效或接近极区");
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 20) throw new Error("地形筛查半径必须在 1–20 公里之间");
  if (Math.abs(longitude) > 178) throw new Error("国际日期变更线附近暂不生成格网 AOI");
  const spacingKm = radiusKm * 2 / (gridSize - 1);
  const points: TerrainSamplingPlan["points"] = [];
  for (let row = 0; row < gridSize; row += 1) {
    const northKm = radiusKm - row * spacingKm;
    for (let column = 0; column < gridSize; column += 1) {
      const eastKm = -radiusKm + column * spacingKm;
      const point = offsetCoordinate(longitude, latitude, eastKm, northKm);
      points.push({ row, column, longitude: point[0], latitude: point[1] });
    }
  }
  return {
    center: [round(longitude, 6), round(latitude, 6)],
    radiusKm: round(radiusKm, 2),
    gridSize,
    spacingKm: round(spacingKm, 4),
    points,
    cacheKey: `${latitude.toFixed(4)}:${longitude.toFixed(4)}:${radiusKm.toFixed(1)}`,
  };
}

export function analyzeTerrainElevations(plan: TerrainSamplingPlan, elevations: unknown, fetchedAt = new Date().toISOString()): LandslideTerrainResult {
  if (!Array.isArray(elevations) || elevations.length !== plan.points.length) throw new Error("高程返回点数与请求格网不一致");
  const values = elevations.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value) || value < -500 || value > 9_500)) throw new Error("高程返回包含无效值");
  const at = (row: number, column: number) => values[row * gridSize + column];
  const spacingMeters = plan.spacingKm * 1_000;
  const candidates: Omit<TerrainCell, "selected">[] = [];
  for (let row = 1; row < gridSize - 1; row += 1) {
    for (let column = 1; column < gridSize - 1; column += 1) {
      const dzdx = (at(row, column + 1) - at(row, column - 1)) / (2 * spacingMeters);
      const dzdyNorth = (at(row - 1, column) - at(row + 1, column)) / (2 * spacingMeters);
      const slopeDeg = Math.atan(Math.hypot(dzdx, dzdyNorth)) * 180 / Math.PI;
      const aspectDeg = normalizeBearing(Math.atan2(-dzdx, -dzdyNorth) * 180 / Math.PI);
      const point = plan.points[row * gridSize + column];
      candidates.push({ row, column, longitude: point.longitude, latitude: point.latitude, elevationM: round(at(row, column), 1), slopeDeg: round(slopeDeg, 1), aspectDeg: round(aspectDeg, 1) });
    }
  }
  const maximumSlopeDeg = round(Math.max(...candidates.map((cell) => cell.slopeDeg)), 1);
  if (maximumSlopeDeg < 8) {
    return { state: "flat", provider, message: "该格网的 DEM 最大近似坡度低于 8°，未自动生成滑坡地形 AOI；可扩大范围或人工圈定。", fetchedAt, maximumSlopeDeg, sourceUrl, attribution };
  }
  const sortedSlopes = candidates.map((cell) => cell.slopeDeg).sort((left, right) => left - right);
  const percentile = sortedSlopes[Math.floor((sortedSlopes.length - 1) * 0.7)];
  const screeningThresholdDeg = round(Math.max(12, percentile), 1);
  const selectedKeys = new Set(candidates
    .filter((cell) => cell.slopeDeg >= screeningThresholdDeg)
    .sort((left, right) => right.slopeDeg - left.slopeDeg)
    .slice(0, 12)
    .map((cell) => `${cell.row}:${cell.column}`));
  if (!selectedKeys.size) {
    return { state: "flat", provider, message: "DEM 未检出达到保守筛查阈值的格网，未生成 AOI。", fetchedAt, maximumSlopeDeg, sourceUrl, attribution };
  }
  const cells = candidates.map((cell) => ({ ...cell, selected: selectedKeys.has(`${cell.row}:${cell.column}`) }));
  const polygons = cells.filter((cell) => cell.selected).map((cell) => [squareRing(cell.longitude, cell.latitude, plan.spacingKm * 0.8)]);
  const geometry: CustomAoiGeometry = { type: "MultiPolygon", coordinates: polygons };
  return {
    state: "ready",
    provider,
    fetchedAt,
    center: plan.center,
    radiusKm: plan.radiusKm,
    gridSize,
    spacingKm: plan.spacingKm,
    samples: plan.points.map((point, index) => ({ longitude: point.longitude, latitude: point.latitude, elevationM: round(values[index], 1) })),
    cells,
    geometry,
    selectedCellCount: polygons.length,
    maximumSlopeDeg,
    screeningThresholdDeg,
    sourceUrl,
    attribution,
    note: "90 m DEM 派生的地形筛查网格，仅用于缩小卫星候选范围；未使用土层、含水量、植被、工程扰动或现场位移，不代表滑坡概率、影响边界或稳定性结论，须人工复核。",
  };
}

function squareRing(longitude: number, latitude: number, sizeKm: number): [number, number][] {
  const half = sizeKm / 2;
  const corners = [offsetCoordinate(longitude, latitude, -half, -half), offsetCoordinate(longitude, latitude, half, -half), offsetCoordinate(longitude, latitude, half, half), offsetCoordinate(longitude, latitude, -half, half)];
  return [...corners, corners[0]].map(([lon, lat]) => [round(lon, 6), round(lat, 6)] as [number, number]);
}

function offsetCoordinate(longitude: number, latitude: number, eastKm: number, northKm: number): [number, number] {
  const lat = latitude + northKm / 110.574;
  const lon = longitude + eastKm / (111.32 * Math.max(0.15, Math.cos(latitude * Math.PI / 180)));
  return [round(lon, 7), round(lat, 7)];
}

function normalizeBearing(value: number) {
  return ((value % 360) + 360) % 360;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}
