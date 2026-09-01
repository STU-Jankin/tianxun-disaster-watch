import type { DisasterEvent } from "./disasters.ts";
import type { LandslideForecastHorizon, LandslideForecastReady, LandslideTriggerLevel } from "./landslide-forecast.ts";
import type { LandslidePilotRegionId } from "./landslide-pilot-regions.ts";
import type { WorldCoverProfile } from "./worldcover.ts";

export const REGIONAL_LANDSLIDE_SCREENING_SOURCE = "天巡区域滑坡试验筛查";
export const REGIONAL_LANDSLIDE_SCREENING_PRODUCT = "tianxun-regional-landslide-screening-v2";

export type RegionalLandslidePilotCell = {
  id: string;
  regionId: LandslidePilotRegionId;
  regionLabel: string;
  focusArea: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusKm: 7.5;
  terrainRadiusKm: 3;
  mode: "sentinel" | "adaptive";
  parentCellId?: string;
};

export type RegionalLandslideCellResult = {
  cell: RegionalLandslidePilotCell;
  forecast: LandslideForecastReady;
  landCover?: WorldCoverProfile;
};

export type RegionalLandslideForecastSnapshot = {
  snapshotId: string;
  cycleAt: string;
  modelVersion: typeof REGIONAL_LANDSLIDE_SCREENING_PRODUCT;
  regionId: LandslidePilotRegionId;
  cellId: string;
  cellMode: "sentinel" | "adaptive";
  parentCellId?: string;
  leadHours: 24 | 48 | 72;
  validFrom: string;
  validTo: string;
  triggerLevel: LandslideTriggerLevel;
  screeningIndex: number | null;
  latitude: number;
  longitude: number;
  radiusKm: number;
  geometry?: DisasterEvent["geometry"];
  inputs: LandslideForecastHorizon;
  landCover?: WorldCoverProfile;
  createdAt: string;
};

export type RegionalLandslideScreeningProduct = {
  sourceEventId: string;
  title: string;
  regionId: LandslidePilotRegionId;
  regionLabel: string;
  leadHours: 24 | 48;
  severity: "yellow" | "orange";
  sourceSeverity: string;
  issuedAt: string;
  validFrom: string;
  validTo: string;
  latitude: number;
  longitude: number;
  geometry: DisasterEvent["geometry"];
  qualifyingCellCount: number;
  totalCellCount: number;
  highCellCount: number;
  elevatedCellCount: number;
  trend72HourCellCount: number;
  maximumRainfallExceedanceRatio: number;
  maximumScreeningIndex: number;
  cellLabels: string[];
  sentinelCellCount: number;
  adaptiveCellCount: number;
  landCoverReadyCellCount: number;
  dominantLandCoverLabels: string[];
  soilMoistureRisingCellCount: number;
  description: string;
};

/**
 * Phase-one pilot cells. They deliberately cover representative mountain and
 * hill belts rather than pretending to be a province-wide susceptibility map.
 * The 7.5 km weather radius matches the published ~15 km native CMA GRAPES
 * Global grid. Terrain is sampled inside a separate 3 km window so 90 m DEM
 * relief is not erased by multi-kilometre finite differences.
 */
export const regionalLandslidePilotCells: RegionalLandslidePilotCell[] = [
  { id: "cq-wanzhou", regionId: "chongqing", regionLabel: "重庆市", focusArea: "三峡库区", label: "万州库岸试验格", latitude: 30.807, longitude: 108.408, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "cq-fengjie", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东北", label: "奉节峡谷试验格", latitude: 31.019, longitude: 109.463, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "cq-wushan", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东北", label: "巫山峡谷试验格", latitude: 31.074, longitude: 109.879, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "cq-wulong", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东南", label: "武隆峡谷试验格", latitude: 29.325, longitude: 107.76, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "cq-qianjiang", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东南", label: "黔江山地试验格", latitude: 29.533, longitude: 108.77, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "js-ningzhen", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "宁镇低山丘陵", label: "宁镇丘陵试验格", latitude: 31.78, longitude: 119.32, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "js-yili", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "环太湖低山丘陵", label: "宜兴南部丘陵试验格", latitude: 31.2, longitude: 119.72, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "js-lianyungang", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "徐连低山丘陵", label: "连云港云台山试验格", latitude: 34.65, longitude: 119.33, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
  { id: "js-xuzhou", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "徐连低山丘陵", label: "徐州云龙山试验格", latitude: 34.22, longitude: 117.19, radiusKm: 7.5, terrainRadiusKm: 3, mode: "sentinel" },
];

export function buildRegionalAdaptiveCells(seedResults: RegionalLandslideCellResult[], maximumCells = 16): RegionalLandslidePilotCell[] {
  const candidates = (["chongqing", "jiangsu"] as const).flatMap((regionId) => seedResults
    .filter((result) => result.cell.regionId === regionId && result.cell.mode === "sentinel" && refinementScore(result) >= 40)
    .sort((left, right) => refinementScore(right) - refinementScore(left))
    .slice(0, 2));
  const cells: RegionalLandslidePilotCell[] = [];
  const directions = [
    { id: "n", label: "北侧", eastKm: 0, northKm: 15 },
    { id: "e", label: "东侧", eastKm: 15, northKm: 0 },
    { id: "s", label: "南侧", eastKm: 0, northKm: -15 },
    { id: "w", label: "西侧", eastKm: -15, northKm: 0 },
  ];
  for (const result of candidates) {
    for (const direction of directions) {
      if (cells.length >= maximumCells) return cells;
      const [longitude, latitude] = offsetCoordinate(result.cell.longitude, result.cell.latitude, direction.eastKm, direction.northKm);
      if ([...regionalLandslidePilotCells, ...cells].some((cell) => distanceKm(latitude, longitude, cell.latitude, cell.longitude) < 7)) continue;
      cells.push({
        ...result.cell,
        id: `${result.cell.id}-adaptive-${direction.id}`,
        label: `${result.cell.label.replace("试验格", "")}${direction.label}加密格`,
        latitude,
        longitude,
        mode: "adaptive",
        parentCellId: result.cell.id,
      });
    }
  }
  return cells;
}

export function isRegionalLandslideScreeningSource(source: string | null | undefined) {
  return String(source ?? "").split(" · ")[0].trim() === REGIONAL_LANDSLIDE_SCREENING_SOURCE;
}

export function buildRegionalLandslideScreeningProducts(
  results: RegionalLandslideCellResult[],
  issuedAt: string,
): RegionalLandslideScreeningProduct[] {
  const normalizedIssuedAt = validIso(issuedAt);
  const products: RegionalLandslideScreeningProduct[] = [];
  for (const regionId of ["chongqing", "jiangsu"] as const) {
    const regionResults = results.filter((result) => result.cell.regionId === regionId && result.forecast.state === "ready");
    if (!regionResults.length) continue;
    const trend72HourCellCount = regionResults.filter((result) => qualifies(horizon(result.forecast, 72))).length;
    for (const leadHours of [24, 48] as const) {
      const qualifying = regionResults.flatMap((result) => {
        const period = horizon(result.forecast, leadHours);
        return period && qualifies(period) && result.forecast.terrain.state === "ready"
          ? [{ result, period }]
          : [];
      });
      if (!qualifying.length) continue;
      // The scheduler attaches geometry only after the shared DEM topology and
      // slope checks succeed; it is intentionally not part of the public point
      // forecast response contract.
      const geometryParts = qualifying.flatMap(({ result }) => polygonParts(regionalTerrainGeometry(result.forecast)));
      if (!geometryParts.length) continue;
      const highCellCount = qualifying.filter(({ period }) => period.triggerLevel === "high").length;
      const elevatedCellCount = qualifying.length - highCellCount;
      const ratios = qualifying.map(({ period }) => period.rainfallExceedanceRatio).filter((value): value is number => value !== null);
      const maximumRainfallExceedanceRatio = ratios.length ? round(Math.max(...ratios), 2) : 0;
      const indices = qualifying.map(({ period }) => period.screeningIndex).filter((value): value is number => value !== null);
      const maximumScreeningIndex = indices.length ? Math.max(...indices) : 0;
      const regionLabel = regionResults[0].cell.regionLabel;
      const cellLabels = qualifying.map(({ result }) => result.cell.label);
      const sentinelCellCount = regionResults.filter((result) => result.cell.mode === "sentinel").length;
      const adaptiveCellCount = regionResults.filter((result) => result.cell.mode === "adaptive").length;
      const landCoverReadyCellCount = qualifying.filter(({ result }) => result.landCover?.state === "ready").length;
      const dominantLandCoverLabels = [...new Set(qualifying.flatMap(({ result }) => result.landCover?.dominantClassLabel ? [result.landCover.dominantClassLabel] : []))].slice(0, 4);
      const soilMoistureRisingCellCount = qualifying.filter(({ period }) => period.soilMoistureSupport === "rising").length;
      const validFrom = qualifying.map(({ period }) => period.validFrom).sort()[0];
      const validTo = qualifying.map(({ period }) => period.validTo).sort().at(-1)!;
      const severity = highCellCount > 0 ? "orange" as const : "yellow" as const;
      const sourceSeverity = `${severity === "orange" ? "试验高触发信号" : "试验加强关注"} · ${qualifying.length}/${regionResults.length} 个已计算格网`;
      products.push({
        sourceEventId: `regional-landslide-${regionId}-h${leadHours}`,
        title: `${regionLabel}未来${leadHours}小时滑坡降雨触发试验筛查`,
        regionId,
        regionLabel,
        leadHours,
        severity,
        sourceSeverity,
        issuedAt: normalizedIssuedAt,
        validFrom,
        validTo,
        latitude: round(average(qualifying.map(({ result }) => result.cell.latitude)), 6),
        longitude: round(average(qualifying.map(({ result }) => result.cell.longitude)), 6),
        geometry: { type: "MultiPolygon", coordinates: geometryParts },
        qualifyingCellCount: qualifying.length,
        totalCellCount: regionResults.length,
        highCellCount,
        elevatedCellCount,
        trend72HourCellCount,
        maximumRainfallExceedanceRatio,
        maximumScreeningIndex,
        cellLabels,
        sentinelCellCount,
        adaptiveCellCount,
        landCoverReadyCellCount,
        dominantLandCoverLabels,
        soilMoistureRisingCellCount,
        description: `${REGIONAL_LANDSLIDE_SCREENING_PRODUCT}：${regionLabel}${leadHours}小时自适应格网中，${highCellCount}格为高触发信号、${elevatedCellCount}格为加强关注；本轮计算${sentinelCellCount}个哨点格和${adaptiveCellCount}个条件触发加密格。最大未来24小时雨量/本地日雨P95比值 ${maximumRainfallExceedanceRatio.toFixed(2)}，最高筛查指数${maximumScreeningIndex}/100（不是概率），${soilMoistureRisingCellCount}格出现模式土壤湿度上升。${landCoverReadyCellCount ? `ESA WorldCover已为${landCoverReadyCellCount}个命中格提供2021年静态地表背景${dominantLandCoverLabels.length ? `（${dominantLandCoverLabels.join("、")}）` : ""}，但不直接改变触发等级。` : "土地覆盖输入本轮不可用，未据此降低风险。"}命中格网：${cellLabels.join("、")}。风险面只保留DEM坡度筛查单元，表示降雨、湿度趋势与地形共同命中的候选范围，不是滑坡概率、滑坡体边界、官方预警或省域完整覆盖。72小时另有${trend72HourCellCount}格仅作趋势监视。产品禁止自动告警、自动计算和自动下发；只能保存卫星候选草稿，等待地方官方预警、隐患点和人工AOI复核。`,
      });
    }
  }
  return products;
}

export function buildRegionalForecastSnapshots(results: RegionalLandslideCellResult[], cycleAt: string): RegionalLandslideForecastSnapshot[] {
  const normalizedCycle = validIso(cycleAt);
  return results.flatMap((result) => result.forecast.horizons.map((period) => ({
    snapshotId: `regional-landslide:${normalizedCycle}:${result.cell.id}:h${period.leadHours}`,
    cycleAt: normalizedCycle,
    modelVersion: REGIONAL_LANDSLIDE_SCREENING_PRODUCT,
    regionId: result.cell.regionId,
    cellId: result.cell.id,
    cellMode: result.cell.mode,
    parentCellId: result.cell.parentCellId,
    leadHours: period.leadHours,
    validFrom: period.validFrom,
    validTo: period.validTo,
    triggerLevel: period.triggerLevel,
    screeningIndex: period.screeningIndex,
    latitude: result.cell.latitude,
    longitude: result.cell.longitude,
    radiusKm: result.cell.radiusKm,
    geometry: regionalTerrainGeometry(result.forecast),
    inputs: period,
    landCover: result.landCover,
    createdAt: normalizedCycle,
  })));
}

/** Attach the validated DEM screening geometry without changing the public forecast contract. */
export function attachRegionalTerrainGeometry(forecast: LandslideForecastReady, geometry: DisasterEvent["geometry"]): LandslideForecastReady {
  return Object.assign(forecast, { terrainGeometry: geometry });
}

function regionalTerrainGeometry(forecast: LandslideForecastReady) {
  return (forecast as LandslideForecastReady & { terrainGeometry?: DisasterEvent["geometry"] }).terrainGeometry;
}

function polygonParts(geometry: DisasterEvent["geometry"] | undefined): unknown[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) return geometry.coordinates;
  return [];
}

function horizon(forecast: LandslideForecastReady, leadHours: 24 | 48 | 72) {
  return forecast.horizons.find((candidate) => candidate.leadHours === leadHours);
}

function qualifies(period: LandslideForecastHorizon | undefined) {
  return Boolean(period && triggerRank(period.triggerLevel) >= triggerRank("elevated"));
}

function triggerRank(level: LandslideTriggerLevel) {
  return ({ unclassified: 0, outside_slope_scope: 0, low_signal: 1, watch: 2, elevated: 3, high: 4 } as const)[level];
}

function refinementScore(result: RegionalLandslideCellResult) {
  return Math.max(...result.forecast.horizons.filter((item) => item.leadHours <= 48).map((item) => item.screeningIndex ?? 0));
}

function offsetCoordinate(longitude: number, latitude: number, eastKm: number, northKm: number): [number, number] {
  const nextLatitude = latitude + northKm / 110.574;
  const nextLongitude = longitude + eastKm / (111.32 * Math.max(0.15, Math.cos(latitude * Math.PI / 180)));
  return [round(nextLongitude, 6), round(nextLatitude, 6)];
}

function distanceKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitudeA * radians) * Math.cos(latitudeB * radians) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validIso(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("区域滑坡筛查发布时间无效");
  return parsed.toISOString();
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}
