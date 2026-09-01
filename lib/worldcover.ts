import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";

export const ESA_WORLDCOVER_SOURCE = "ESA WorldCover 2021 v200";
export const ESA_WORLDCOVER_DOCUMENTATION = "https://esa-worldcover.org/en/data-access";

export type WorldCoverClassCode = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 95 | 100;

export type WorldCoverSamplePoint = {
  id: string;
  longitude: number;
  latitude: number;
};

export type WorldCoverPointSample = WorldCoverSamplePoint & {
  classCode: WorldCoverClassCode;
  classLabel: string;
  tileId: string;
};

export type WorldCoverProfile = {
  state: "ready";
  provider: typeof ESA_WORLDCOVER_SOURCE;
  productYear: 2021;
  sampledAt: string;
  sampleCount: number;
  dominantClassCode: WorldCoverClassCode;
  dominantClassLabel: string;
  classCounts: Array<{ classCode: WorldCoverClassCode; classLabel: string; count: number; percent: number }>;
  engineeredOrExposedPercent: number;
  vegetatedPercent: number;
  nonSlopeSurfacePercent: number;
  interpretation: string;
  sourceUrl: typeof ESA_WORLDCOVER_DOCUMENTATION;
};

export type WorldCoverResult = WorldCoverProfile | {
  state: "unavailable";
  provider: typeof ESA_WORLDCOVER_SOURCE;
  message: string;
  sourceUrl: typeof ESA_WORLDCOVER_DOCUMENTATION;
};

type CachedTiff = { expiresAt: number; value: Promise<{ tiff: GeoTIFF; image: GeoTIFFImage }> };
const tileCache = new Map<string, CachedTiff>();
const tileCacheMs = 6 * 60 * 60_000;

const classes: Record<WorldCoverClassCode, string> = {
  10: "树木覆盖",
  20: "灌木地",
  30: "草地",
  40: "耕地",
  50: "建设用地",
  60: "裸地/稀疏植被",
  70: "冰雪",
  80: "永久水体",
  90: "草本湿地",
  95: "红树林",
  100: "苔藓/地衣",
};

export function worldCoverClassLabel(value: number) {
  return classes[value as WorldCoverClassCode] ?? null;
}

export function worldCoverTileId(longitude: number, latitude: number) {
  validateCoordinate(longitude, latitude);
  const west = Math.floor(longitude / 3) * 3;
  const south = Math.floor(latitude / 3) * 3;
  const latitudeLabel = `${south >= 0 ? "N" : "S"}${String(Math.abs(south)).padStart(2, "0")}`;
  const longitudeLabel = `${west >= 0 ? "E" : "W"}${String(Math.abs(west)).padStart(3, "0")}`;
  return `${latitudeLabel}${longitudeLabel}`;
}

export function worldCoverTileUrl(tileId: string) {
  if (!/^[NS]\d{2}[EW]\d{3}$/.test(tileId)) throw new Error("WorldCover瓦片编号无效");
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tileId}_Map.tif`;
}

export async function sampleWorldCover(points: WorldCoverSamplePoint[], sampledAt = new Date().toISOString()): Promise<WorldCoverPointSample[]> {
  if (!Array.isArray(points) || !points.length || points.length > 160) throw new Error("WorldCover采样点数必须为1–160");
  const unique = new Map<string, WorldCoverSamplePoint>();
  for (const point of points) {
    validateCoordinate(point.longitude, point.latitude);
    if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(point.id)) throw new Error("WorldCover采样点编号无效");
    unique.set(point.id, point);
  }
  const groups = new Map<string, WorldCoverSamplePoint[]>();
  for (const point of unique.values()) {
    const tileId = worldCoverTileId(point.longitude, point.latitude);
    groups.set(tileId, [...(groups.get(tileId) ?? []), point]);
  }
  if (groups.size > 12) throw new Error("WorldCover单次采样跨越瓦片过多");
  const output: WorldCoverPointSample[] = [];
  for (const [tileId, tilePoints] of groups) {
    const { image } = await cachedTile(tileId);
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    if (!Number.isFinite(resolution[0]) || !Number.isFinite(resolution[1]) || resolution[0] <= 0 || resolution[1] >= 0) throw new Error("WorldCover栅格参考系无效");
    const samples = await mapWithConcurrency(tilePoints, 4, async (point) => {
      const x = Math.max(0, Math.min(image.getWidth() - 1, Math.floor((point.longitude - origin[0]) / resolution[0])));
      const y = Math.max(0, Math.min(image.getHeight() - 1, Math.floor((point.latitude - origin[1]) / resolution[1])));
      const raster = await image.readRasters({ window: [x, y, x + 1, y + 1], samples: [0] });
      const classCode = Number(raster[0][0]);
      const classLabel = worldCoverClassLabel(classCode);
      if (!classLabel) throw new Error(`WorldCover返回未知类别${classCode}`);
      return { ...point, classCode: classCode as WorldCoverClassCode, classLabel, tileId };
    });
    output.push(...samples);
  }
  // Force timestamp validation here so callers cannot archive malformed cycles.
  if (!Number.isFinite(Date.parse(sampledAt))) throw new Error("WorldCover采样时间无效");
  return output;
}

export function summarizeWorldCover(samples: WorldCoverPointSample[], sampledAt = new Date().toISOString()): WorldCoverProfile {
  if (!samples.length) throw new Error("WorldCover没有可汇总样本");
  const counts = new Map<WorldCoverClassCode, number>();
  samples.forEach((sample) => counts.set(sample.classCode, (counts.get(sample.classCode) ?? 0) + 1));
  const classCounts = [...counts].map(([classCode, count]) => ({
    classCode,
    classLabel: classes[classCode],
    count,
    percent: round(count / samples.length * 100, 1),
  })).sort((left, right) => right.count - left.count || left.classCode - right.classCode);
  const dominant = classCounts[0];
  const percentFor = (codes: WorldCoverClassCode[]) => round(classCounts.filter((item) => codes.includes(item.classCode)).reduce((sum, item) => sum + item.count, 0) / samples.length * 100, 1);
  return {
    state: "ready",
    provider: ESA_WORLDCOVER_SOURCE,
    productYear: 2021,
    sampledAt: new Date(sampledAt).toISOString(),
    sampleCount: samples.length,
    dominantClassCode: dominant.classCode,
    dominantClassLabel: dominant.classLabel,
    classCounts,
    engineeredOrExposedPercent: percentFor([40, 50, 60]),
    vegetatedPercent: percentFor([10, 20, 30]),
    nonSlopeSurfacePercent: percentFor([70, 80, 90, 95]),
    interpretation: "土地覆盖只用于描述坡面环境和识别明显非坡面地表，不直接提高或降低滑坡触发等级；10米类别来自2021年静态制图，不代表当前植被、施工或灾后状态。",
    sourceUrl: ESA_WORLDCOVER_DOCUMENTATION,
  };
}

async function cachedTile(tileId: string) {
  const current = tileCache.get(tileId);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = fromUrl(worldCoverTileUrl(tileId), { allowFullFile: false, maxRanges: 8 }, AbortSignal.timeout(25_000))
    .then(async (tiff) => ({ tiff, image: await tiff.getImage() }));
  tileCache.set(tileId, { value, expiresAt: Date.now() + tileCacheMs });
  try { return await value; }
  catch (error) { tileCache.delete(tileId); throw error; }
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function validateCoordinate(longitude: number, latitude: number) {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude >= 180 || !Number.isFinite(latitude) || latitude < -90 || latitude >= 90) throw new Error("WorldCover坐标无效");
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}
