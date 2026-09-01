import type { DisasterEvent } from "./disasters.ts";
import type { LandslideForecastHorizon, LandslideForecastReady, LandslideTriggerLevel } from "./landslide-forecast.ts";
import type { LandslidePilotRegionId } from "./landslide-pilot-regions.ts";

export const REGIONAL_LANDSLIDE_SCREENING_SOURCE = "天巡区域滑坡试验筛查";
export const REGIONAL_LANDSLIDE_SCREENING_PRODUCT = "tianxun-regional-landslide-screening-v1";

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
};

export type RegionalLandslideCellResult = {
  cell: RegionalLandslidePilotCell;
  forecast: LandslideForecastReady;
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
  cellLabels: string[];
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
  { id: "cq-wanzhou", regionId: "chongqing", regionLabel: "重庆市", focusArea: "三峡库区", label: "万州库岸试验格", latitude: 30.807, longitude: 108.408, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "cq-fengjie", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东北", label: "奉节峡谷试验格", latitude: 31.019, longitude: 109.463, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "cq-wushan", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东北", label: "巫山峡谷试验格", latitude: 31.074, longitude: 109.879, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "cq-wulong", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东南", label: "武隆峡谷试验格", latitude: 29.325, longitude: 107.76, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "cq-qianjiang", regionId: "chongqing", regionLabel: "重庆市", focusArea: "渝东南", label: "黔江山地试验格", latitude: 29.533, longitude: 108.77, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "js-ningzhen", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "宁镇低山丘陵", label: "宁镇丘陵试验格", latitude: 31.78, longitude: 119.32, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "js-yili", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "环太湖低山丘陵", label: "宜兴南部丘陵试验格", latitude: 31.2, longitude: 119.72, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "js-lianyungang", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "徐连低山丘陵", label: "连云港云台山试验格", latitude: 34.65, longitude: 119.33, radiusKm: 7.5, terrainRadiusKm: 3 },
  { id: "js-xuzhou", regionId: "jiangsu", regionLabel: "江苏省", focusArea: "徐连低山丘陵", label: "徐州云龙山试验格", latitude: 34.22, longitude: 117.19, radiusKm: 7.5, terrainRadiusKm: 3 },
];

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
      const regionLabel = regionResults[0].cell.regionLabel;
      const cellLabels = qualifying.map(({ result }) => result.cell.label);
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
        cellLabels,
        description: `${REGIONAL_LANDSLIDE_SCREENING_PRODUCT}：${regionLabel}${leadHours}小时固定试验格网中，${highCellCount}格为高触发信号、${elevatedCellCount}格为加强关注；最大未来24小时雨量/本地日雨P95比值 ${maximumRainfallExceedanceRatio.toFixed(2)}。命中格网：${cellLabels.join("、")}。风险面只保留DEM坡度筛查单元，表示降雨与地形条件共同命中的候选范围，不是滑坡概率、滑坡体边界、官方预警或省域完整覆盖。72小时另有${trend72HourCellCount}格仅作趋势监视。产品禁止自动告警、自动计算和自动下发；只能保存卫星候选草稿，等待地方官方预警、隐患点和人工AOI复核。`,
      });
    }
  }
  return products;
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
