import { fromArrayBuffer } from "geotiff";

export const lhasaV1MaximumGeoTiffBytes = 12 * 1024 * 1024;
export const lhasaV1MaximumBatchProducts = 2;

export type LhasaV1ReadStatus = "not_started" | "ready" | "credential_required" | "download_error" | "parse_error" | "outside_coverage" | "no_data";

export type LhasaV1CaseReadResult = {
  pointValue: 0 | 1 | 2 | null;
  neighborhoodMaximum: 0 | 1 | 2 | null;
  neighborhoodRadiusCells: [number, number];
  validCellCount: number;
  moderateCellCount: number;
  highCellCount: number;
  window: [number, number, number, number];
  rasterWidth: number;
  rasterHeight: number;
  boundingBox: [number, number, number, number];
  resolutionDegrees: [number, number];
  noDataValue: number;
  interpretation: "same_day_nowcast";
};

export type LhasaV1ReplayCase = {
  caseId: string;
  latitude: number;
  longitude: number;
  locationToleranceKm: number;
};

export type LhasaV1DownloadedGeoTiff = {
  bytes: ArrayBuffer;
  byteLength: number;
  payloadSha256: string;
  contentType: string;
};

type GeoTiffImageLike = {
  getWidth(): number;
  getHeight(): number;
  getSamplesPerPixel(): number;
  getBitsPerSample(sample?: number): number;
  getSampleFormat(sample?: number): number;
  getBlockWidth(): number;
  getBlockHeight(y: number): number;
  getBoundingBox(): number[];
  getOrigin(): number[];
  getResolution(): number[];
  getGeoKeys(): Partial<Record<string, unknown>> | null;
  getGDALNoData(): number | null;
  readRasters(options: { window: number[]; samples: number[]; interleave: true }): Promise<ArrayLike<number> & { width?: number; height?: number }>;
};

export async function downloadLhasaV1GeoTiff(downloadUrl: string, bearerToken: string, fetcher: typeof fetch = fetch): Promise<LhasaV1DownloadedGeoTiff> {
  const url = trustedLhasaDownloadUrl(downloadUrl);
  const token = bearerToken.trim();
  if (token.length < 16 || token.length > 4_096 || Array.from(token).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127;
  })) throw new Error("Earthdata bearer token is missing or malformed");
  const response = await fetcher(url, {
    headers: {
      "Accept": "image/tiff,application/geotiff,application/octet-stream;q=0.9",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "tianxun-disaster-watch/1.0",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(45_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("Earthdata returned an authentication redirect; credentials were not forwarded");
  if (response.status === 401 || response.status === 403) throw new Error(`Earthdata rejected the credential with HTTP ${response.status}`);
  if (!response.ok || response.status !== 200) throw new Error(`Earthdata GeoTIFF request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && (declared < 4_096 || declared > lhasaV1MaximumGeoTiffBytes)) throw new Error("Earthdata GeoTIFF size is outside the safety bounds");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
  if (contentType === "text/html" || contentType === "application/json") throw new Error("Earthdata returned a document instead of a GeoTIFF");
  const bytes = await readBoundedBinary(response, lhasaV1MaximumGeoTiffBytes);
  if (bytes.byteLength < 4_096 || !isTiff(bytes)) throw new Error("Earthdata response does not have a valid TIFF signature");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { bytes, byteLength: bytes.byteLength, payloadSha256: hex(new Uint8Array(digest)), contentType };
}

export async function readLhasaV1CaseWindows(bytes: ArrayBuffer, cases: LhasaV1ReplayCase[]) {
  if (!cases.length || cases.length > 20) throw new Error("LHASA replay case batch is empty or too large");
  const tiff = await fromArrayBuffer(bytes, AbortSignal.timeout(30_000));
  const image = await tiff.getImage();
  return readLhasaV1CaseWindowsFromImage(image as unknown as GeoTiffImageLike, cases);
}

export async function readLhasaV1CaseWindowsFromImage(image: GeoTiffImageLike, cases: LhasaV1ReplayCase[]) {
  const geometry = validateOfficialRasterGeometry(image);
  const results = new Map<string, LhasaV1CaseReadResult>();
  for (const sample of cases) {
    if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude) || !Number.isFinite(sample.locationToleranceKm)) throw new Error("LHASA replay case coordinates are invalid");
    if (sample.longitude < geometry.boundingBox[0] || sample.longitude >= geometry.boundingBox[2] || sample.latitude <= geometry.boundingBox[1] || sample.latitude > geometry.boundingBox[3]) continue;
    const x = Math.floor((sample.longitude - geometry.boundingBox[0]) / (geometry.boundingBox[2] - geometry.boundingBox[0]) * geometry.width);
    const y = Math.floor((geometry.boundingBox[3] - sample.latitude) / (geometry.boundingBox[3] - geometry.boundingBox[1]) * geometry.height);
    const northSouthCellKm = 111.32 * geometry.resolutionDegrees[1];
    const eastWestCellKm = Math.max(0.1, 111.32 * Math.cos(sample.latitude * Math.PI / 180) * geometry.resolutionDegrees[0]);
    const radiusX = Math.max(1, Math.min(24, Math.ceil(sample.locationToleranceKm / eastWestCellKm)));
    const radiusY = Math.max(1, Math.min(12, Math.ceil(sample.locationToleranceKm / northSouthCellKm)));
    const window: [number, number, number, number] = [
      Math.max(0, x - radiusX),
      Math.max(0, y - radiusY),
      Math.min(geometry.width, x + radiusX + 1),
      Math.min(geometry.height, y + radiusY + 1),
    ];
    const raster = await image.readRasters({ window, samples: [0], interleave: true });
    const windowWidth = window[2] - window[0];
    const windowHeight = window[3] - window[1];
    if (raster.length !== windowWidth * windowHeight) throw new Error("LHASA GeoTIFF window length does not match its geometry");
    const centerIndex = (y - window[1]) * windowWidth + (x - window[0]);
    const values = Array.from(raster, Number);
    for (const value of values) if (![0, 1, 2, geometry.noDataValue].includes(value)) throw new Error(`LHASA GeoTIFF contains an unsupported class value ${value}`);
    const valid = values.filter((value) => value !== geometry.noDataValue) as Array<0 | 1 | 2>;
    const point = values[centerIndex];
    results.set(sample.caseId, {
      pointValue: point === geometry.noDataValue ? null : point as 0 | 1 | 2,
      neighborhoodMaximum: valid.length ? Math.max(...valid) as 0 | 1 | 2 : null,
      neighborhoodRadiusCells: [radiusX, radiusY],
      validCellCount: valid.length,
      moderateCellCount: valid.filter((value) => value === 1).length,
      highCellCount: valid.filter((value) => value === 2).length,
      window,
      rasterWidth: geometry.width,
      rasterHeight: geometry.height,
      boundingBox: geometry.boundingBox,
      resolutionDegrees: geometry.resolutionDegrees,
      noDataValue: geometry.noDataValue,
      interpretation: "same_day_nowcast",
    });
  }
  return results;
}

function validateOfficialRasterGeometry(image: GeoTiffImageLike) {
  const width = image.getWidth();
  const height = image.getHeight();
  const bounding = image.getBoundingBox().map(Number);
  const origin = image.getOrigin().map(Number);
  const resolution = image.getResolution().map(Number);
  const geoKeys = image.getGeoKeys();
  const noData = image.getGDALNoData();
  if (!Number.isInteger(width) || width < 43_000 || width > 43_300 || !Number.isInteger(height) || height < 14_300 || height > 14_500) throw new Error("LHASA GeoTIFF dimensions do not match the official 30 arc-second global grid");
  if (image.getSamplesPerPixel() !== 1 || image.getBitsPerSample(0) !== 8 || ![1, undefined].includes(image.getSampleFormat(0))) throw new Error("LHASA GeoTIFF must contain one unsigned 8-bit class band");
  if (bounding.length < 4 || bounding.some((value) => !Number.isFinite(value)) || Math.abs(bounding[0] + 180) > 0.02 || Math.abs(bounding[1] + 60) > 0.02 || Math.abs(bounding[2] - 180) > 0.02 || Math.abs(bounding[3] - 60) > 0.02) throw new Error("LHASA GeoTIFF bounds do not match the official 60°N–60°S coverage");
  if (origin.length < 2 || Math.abs(origin[0] + 180) > 0.02 || Math.abs(origin[1] - 60) > 0.02 || resolution.length < 2 || resolution[0] <= 0 || resolution[1] >= 0 || Math.abs(resolution[0] - 1 / 120) > 0.00001 || Math.abs(Math.abs(resolution[1]) - 1 / 120) > 0.00001) throw new Error("LHASA GeoTIFF origin, orientation or resolution does not match the official 30 arc-second grid");
  const geographicType = Number(geoKeys?.GeographicTypeGeoKey);
  if (geographicType !== 4326) throw new Error("LHASA GeoTIFF coordinate system is not WGS 84");
  const blockPixels = image.getBlockWidth() * image.getBlockHeight(0);
  if (!Number.isFinite(blockPixels) || blockPixels < 1 || blockPixels > 4_000_000) throw new Error("LHASA GeoTIFF strip or tile is too large for bounded replay");
  const noDataValue = noData === null ? 255 : Number(noData);
  if (noDataValue !== 255) throw new Error("LHASA GeoTIFF no-data value is not the documented value 255");
  return {
    width,
    height,
    boundingBox: [bounding[0], bounding[1], bounding[2], bounding[3]] as [number, number, number, number],
    resolutionDegrees: [Math.abs(resolution[0]), Math.abs(resolution[1])] as [number, number],
    noDataValue,
  };
}

function trustedLhasaDownloadUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "data.gesdisc.earthdata.nasa.gov" || !url.pathname.endsWith(".tif") || url.username || url.password) throw new Error("LHASA download URL is not trusted");
  return url.toString();
}

async function readBoundedBinary(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error("Earthdata response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error("Earthdata GeoTIFF exceeds the safety limit"); }
    chunks.push(value);
  }
  const declared = Number(response.headers.get("content-length"));
  if (!response.headers.get("content-encoding") && Number.isFinite(declared) && declared > 0 && declared !== total) throw new Error("Earthdata GeoTIFF download is incomplete");
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined.buffer;
}

function isTiff(bytes: ArrayBuffer) {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a);
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
