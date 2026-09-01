import type { DisasterEvent } from "./disasters.ts";
import type { PublicEventCandidate } from "./public-event-sources.ts";

export type LhasaCoarseRiskRaster = {
  sourceWidth: number;
  sourceHeight: number;
  groupPixels: number;
  width: number;
  height: number;
  values: Uint8Array;
};

export type LhasaRiskCluster = {
  clusterId: string;
  maximumRiskPercent: number;
  cellCount: number;
  latitude: number;
  longitude: number;
  geometry: { type: "Polygon"; coordinates: number[][][] };
};

export type LhasaRiskRasterSummary = {
  cellCount: number;
  minimumRiskPercent: number;
  maximumRiskPercent: number;
  meanRiskPercent: number;
  histogram: number[];
  thresholdCellCounts: Record<string, number>;
};

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const officialViewerUrl = "https://pmmpublisher.pps.eosdis.nasa.gov/precip-apps/";

export async function decodeLhasaRiskPng(input: ArrayBuffer | Uint8Array, groupPixels = 5): Promise<LhasaCoarseRiskRaster> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 33 || !pngSignature.every((value, index) => bytes[index] === value)) throw new Error("LHASA PNG 签名无效");
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  if (width < 360 || height < 180 || width * height > 60_000_000) throw new Error("LHASA PNG 栅格尺寸超出安全范围");
  if (bytes[24] !== 8 || bytes[25] !== 0 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    throw new Error("LHASA PNG 必须是非隔行 8 位灰度栅格");
  }
  if (!Number.isInteger(groupPixels) || groupPixels < 1 || groupPixels > 50) throw new Error("LHASA 聚合像素参数无效");

  const idatChunks: Uint8Array[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    if (length > 2_000_000 || offset + 12 + length > bytes.length) throw new Error("LHASA PNG 数据块无效");
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { ended = true; break; }
    offset += 12 + length;
  }
  if (!ended || !idatChunks.length) throw new Error("LHASA PNG 缺少完整影像数据");
  const compressedLength = idatChunks.reduce((total, chunk) => total + chunk.length, 0);
  if (compressedLength > 2_000_000) throw new Error("LHASA PNG 压缩数据超过安全上限");
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const chunk of idatChunks) { compressed.set(chunk, compressedOffset); compressedOffset += chunk.length; }

  const expectedLength = (width + 1) * height;
  const raw = await inflateBounded(compressed, expectedLength);
  if (raw.length !== expectedLength) throw new Error("LHASA PNG 解压尺寸与栅格元数据不一致");

  const coarseWidth = Math.ceil(width / groupPixels);
  const coarseHeight = Math.ceil(height / groupPixels);
  const values = new Uint8Array(coarseWidth * coarseHeight);
  let previous = new Uint8Array(width);
  let current = new Uint8Array(width);
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * (width + 1);
    const filter = raw[rowOffset];
    if (filter > 4) throw new Error("LHASA PNG 使用了不支持的滤波器");
    const coarseRowOffset = Math.floor(row / groupPixels) * coarseWidth;
    for (let column = 0; column < width; column += 1) {
      const encoded = raw[rowOffset + 1 + column];
      const left = column ? current[column - 1] : 0;
      const above = previous[column];
      const upperLeft = column ? previous[column - 1] : 0;
      const decoded = filter === 0 ? encoded
        : filter === 1 ? encoded + left
          : filter === 2 ? encoded + above
            : filter === 3 ? encoded + Math.floor((left + above) / 2)
              : encoded + paeth(left, above, upperLeft);
      const encodedRisk = decoded & 255;
      current[column] = encodedRisk;
      // NASA 查看器按 WebGL 归一化红通道（0..1）与百分比阈值比较，
      // 因此 PNG 字节 255 才表示 100%，不能把原始字节直接当百分数。
      const risk = Math.round(encodedRisk * 100 / 255);
      const coarseIndex = coarseRowOffset + Math.floor(column / groupPixels);
      if (risk > values[coarseIndex]) values[coarseIndex] = risk;
    }
    const swap = previous; previous = current; current = swap;
  }
  return { sourceWidth: width, sourceHeight: height, groupPixels, width: coarseWidth, height: coarseHeight, values };
}

export function coarsenLhasaRiskRaster(raster: LhasaCoarseRiskRaster, groupPixels: number): LhasaCoarseRiskRaster {
  if (raster.groupPixels !== 1 || raster.width !== raster.sourceWidth || raster.height !== raster.sourceHeight || raster.values.length !== raster.sourceWidth * raster.sourceHeight) {
    throw new Error("LHASA 风险栅格必须从原始分辨率开始聚合");
  }
  if (!Number.isInteger(groupPixels) || groupPixels < 1 || groupPixels > 50) throw new Error("LHASA 聚合像素参数无效");
  if (groupPixels === 1) return raster;
  const width = Math.ceil(raster.sourceWidth / groupPixels);
  const height = Math.ceil(raster.sourceHeight / groupPixels);
  const values = new Uint8Array(width * height);
  for (let sourceY = 0; sourceY < raster.sourceHeight; sourceY += 1) {
    const targetRow = Math.floor(sourceY / groupPixels) * width;
    const sourceRow = sourceY * raster.sourceWidth;
    for (let sourceX = 0; sourceX < raster.sourceWidth; sourceX += 1) {
      const target = targetRow + Math.floor(sourceX / groupPixels);
      const risk = raster.values[sourceRow + sourceX];
      if (risk > values[target]) values[target] = risk;
    }
  }
  return { sourceWidth: raster.sourceWidth, sourceHeight: raster.sourceHeight, groupPixels, width, height, values };
}

export function lhasaRiskClusters(raster: LhasaCoarseRiskRaster, thresholdPercent = 80, limit = 60): LhasaRiskCluster[] {
  const threshold = Math.max(50, Math.min(100, Math.round(thresholdPercent)));
  const maximum = Math.max(1, Math.min(100, Math.round(limit)));
  if (raster.values.length !== raster.width * raster.height || raster.sourceWidth < 1 || raster.sourceHeight < 1) throw new Error("LHASA 粗栅格结构无效");
  const visited = new Uint8Array(raster.values.length);
  const clusters: LhasaRiskCluster[] = [];
  for (let start = 0; start < raster.values.length; start += 1) {
    if (visited[start] || raster.values[start] < threshold) continue;
    visited[start] = 1;
    const stack = [start];
    let minimumX = raster.width;
    let maximumX = 0;
    let minimumY = raster.height;
    let maximumY = 0;
    let maximumRiskPercent = 0;
    let cellCount = 0;
    while (stack.length) {
      const index = stack.pop()!;
      const y = Math.floor(index / raster.width);
      const x = index - y * raster.width;
      minimumX = Math.min(minimumX, x); maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y); maximumY = Math.max(maximumY, y);
      maximumRiskPercent = Math.max(maximumRiskPercent, raster.values[index]);
      cellCount += 1;
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        if (!xOffset && !yOffset) continue;
        const neighborX = x + xOffset;
        const neighborY = y + yOffset;
        if (neighborX < 0 || neighborX >= raster.width || neighborY < 0 || neighborY >= raster.height) continue;
        const neighbor = neighborY * raster.width + neighborX;
        if (!visited[neighbor] && raster.values[neighbor] >= threshold) { visited[neighbor] = 1; stack.push(neighbor); }
      }
    }
    const longitudeMinimum = pixelLongitude(minimumX * raster.groupPixels, raster.sourceWidth);
    const longitudeMaximum = pixelLongitude(Math.min(raster.sourceWidth, (maximumX + 1) * raster.groupPixels), raster.sourceWidth);
    const latitudeMaximum = pixelLatitude(minimumY * raster.groupPixels, raster.sourceHeight);
    const latitudeMinimum = pixelLatitude(Math.min(raster.sourceHeight, (maximumY + 1) * raster.groupPixels), raster.sourceHeight);
    if (latitudeMaximum < -60 || latitudeMinimum > 60) continue;
    clusters.push({
      clusterId: `${minimumX}-${minimumY}-${maximumX}-${maximumY}`,
      maximumRiskPercent,
      cellCount,
      latitude: (latitudeMinimum + latitudeMaximum) / 2,
      longitude: (longitudeMinimum + longitudeMaximum) / 2,
      geometry: { type: "Polygon", coordinates: [[
        [longitudeMinimum, latitudeMinimum], [longitudeMaximum, latitudeMinimum],
        [longitudeMaximum, latitudeMaximum], [longitudeMinimum, latitudeMaximum],
        [longitudeMinimum, latitudeMinimum],
      ]] },
    });
  }
  return clusters
    .sort((left, right) => right.maximumRiskPercent - left.maximumRiskPercent || right.cellCount - left.cellCount || left.clusterId.localeCompare(right.clusterId))
    .slice(0, maximum);
}

/**
 * Returns the decoded risk value at a geographic point. The raster follows the
 * global north-to-south, west-to-east layout used by the official LHASA PNG.
 * Keeping this operation independent from the alert threshold is essential for
 * retrospective calibration: a 62% forecast must remain observable even when
 * the operational map only surfaces regions at or above 80%.
 */
export function lhasaRiskAtLocation(raster: LhasaCoarseRiskRaster, latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (raster.values.length !== raster.width * raster.height || raster.width < 1 || raster.height < 1) return null;
  const normalizedLongitude = longitude === 180 ? 180 - Number.EPSILON : longitude;
  const normalizedLatitude = latitude === -90 ? -90 + Number.EPSILON : latitude;
  const sourceX = Math.floor((normalizedLongitude + 180) / 360 * raster.sourceWidth);
  const sourceY = Math.floor((90 - normalizedLatitude) / 180 * raster.sourceHeight);
  const x = Math.max(0, Math.min(raster.width - 1, Math.floor(sourceX / raster.groupPixels)));
  const y = Math.max(0, Math.min(raster.height - 1, Math.floor(sourceY / raster.groupPixels)));
  return raster.values[y * raster.width + x];
}

export function summarizeLhasaRiskRaster(raster: LhasaCoarseRiskRaster): LhasaRiskRasterSummary {
  if (raster.values.length !== raster.width * raster.height || !raster.values.length) throw new Error("LHASA 粗栅格结构无效");
  const histogram = Array.from({ length: 101 }, () => 0);
  let minimumRiskPercent = 100;
  let maximumRiskPercent = 0;
  let total = 0;
  for (const value of raster.values) {
    const risk = Math.max(0, Math.min(100, value));
    histogram[risk] += 1;
    minimumRiskPercent = Math.min(minimumRiskPercent, risk);
    maximumRiskPercent = Math.max(maximumRiskPercent, risk);
    total += risk;
  }
  const thresholdCellCounts: Record<string, number> = {};
  for (let threshold = 50; threshold <= 100; threshold += 5) {
    thresholdCellCounts[String(threshold)] = histogram.slice(threshold).reduce((sum, count) => sum + count, 0);
  }
  return {
    cellCount: raster.values.length,
    minimumRiskPercent,
    maximumRiskPercent,
    meanRiskPercent: Math.round(total / raster.values.length * 100) / 100,
    histogram,
    thresholdCellCounts,
  };
}

export function lhasaCandidatesFromRaster(
  raster: LhasaCoarseRiskRaster,
  productTime: string,
  sourceRasterUrl: string,
  now = Date.now(),
): PublicEventCandidate[] {
  const productTimestamp = Date.parse(productTime);
  if (!Number.isFinite(productTimestamp) || productTimestamp > now + 10 * 60_000 || now - productTimestamp > 30 * 3_600_000) return [];
  const validTo = new Date(productTimestamp + 24 * 3_600_000).toISOString();
  if (Date.parse(validTo) <= now) return [];
  return lhasaRiskClusters(raster).map((cluster): PublicEventCandidate => ({
    sourceEventId: `lhasa-${productTime.replace(/\D/g, "").slice(0, 12)}-${cluster.clusterId}`,
    title: `NASA LHASA 高滑坡风险区 · ${cluster.maximumRiskPercent}%`,
    hazard: "landslide",
    hazardSubtype: "landslide",
    geometry: cluster.geometry,
    occurredAt: productTime,
    updatedAt: productTime,
    activityAt: productTime,
    issuedAt: productTime,
    validFrom: productTime,
    validTo,
    phenomenonStage: "forecast",
    sourceUrl: officialViewerUrl,
    sourceSeverity: `LHASA ${cluster.maximumRiskPercent}% · ${cluster.cellCount} 个约 ${coarseCellLabel(raster)} 风险格`,
    severity: riskSeverity(cluster.maximumRiskPercent),
    magnitude: cluster.maximumRiskPercent,
    magnitudeUnit: "%",
    description: `NASA LHASA 降雨触发滑坡 nowcast；本系统仅保留风险值不低于 80% 的连通高风险格，并用外包矩形展示。该范围是模型风险筛查区，不是已发生滑坡或泥石流的边界，也不能替代地方地质灾害预警。产品批次 ${productTime}，原始栅格 ${sourceRasterUrl}；任何任务均需人工复核 AOI。`,
    requiresReview: true,
  }));
}

function riskSeverity(value: number): DisasterEvent["severity"] {
  if (value >= 95) return "red";
  if (value >= 88) return "orange";
  return "yellow";
}

function coarseCellLabel(raster: LhasaCoarseRiskRaster) {
  const longitudeDegrees = 360 * raster.groupPixels / raster.sourceWidth;
  const latitudeDegrees = 180 * raster.groupPixels / raster.sourceHeight;
  return `${longitudeDegrees.toFixed(2)}°×${latitudeDegrees.toFixed(2)}°`;
}

function pixelLongitude(pixel: number, width: number) {
  return Number((-180 + 360 * pixel / width).toFixed(6));
}

function pixelLatitude(pixel: number, height: number) {
  return Number((90 - 180 * pixel / height).toFixed(6));
}

async function inflateBounded(compressed: Uint8Array, expectedLength: number) {
  const source = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedLength) { await reader.cancel(); throw new Error("LHASA PNG 解压数据超过栅格声明上限"); }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function uint32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function paeth(left: number, above: number, upperLeft: number) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}
