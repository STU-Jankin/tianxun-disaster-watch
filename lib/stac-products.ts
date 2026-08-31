import { validateGeoGeometry } from "./geo-geometry.ts";
import type { GeoGeometry } from "./task-aoi.ts";

export const productQualityStatuses = ["pending", "passed", "conditional", "rejected"] as const;
export type ProductQualityStatus = (typeof productQualityStatuses)[number];

export type ObservationProduct = {
  itemId: string;
  taskId: string;
  masterEventId: string;
  owner: string;
  collectionId: string;
  productLevel: string;
  qualityStatus: ProductQualityStatus;
  acquiredAt: string;
  geometry: GeoGeometry;
  bbox: [number, number, number, number];
  stac: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ObservationProductInput = Pick<ObservationProduct, "itemId" | "taskId" | "collectionId" | "productLevel" | "qualityStatus" | "acquiredAt" | "geometry"> & {
  platform: string;
  instruments: string[];
  assets: Record<string, { href: string; type?: string; title?: string; roles?: string[] }>;
  properties?: Record<string, unknown>;
  expectedRevision?: number;
};

export function normalizeObservationProductInput(value: unknown): ObservationProductInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("产品元数据必须是对象");
  const input = value as Record<string, unknown>;
  const geometry = normalizeGeometry(input.geometry);
  const qualityStatus = String(input.qualityStatus ?? "pending") as ProductQualityStatus;
  if (!productQualityStatuses.includes(qualityStatus)) throw new Error("产品质检状态无效");
  const instruments = Array.isArray(input.instruments)
    ? [...new Set(input.instruments.map((item) => boundedText(item, 120, "载荷名称", true)))].slice(0, 20)
    : [];
  if (!instruments.length) throw new Error("至少提供一个载荷名称");
  const expectedRevision = input.expectedRevision === undefined ? undefined : Number(input.expectedRevision);
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new Error("expectedRevision 必须是正整数");
  return {
    itemId: boundedText(input.itemId, 220, "STAC Item ID", true),
    taskId: boundedText(input.taskId, 220, "任务 ID", true),
    collectionId: boundedText(input.collectionId, 220, "集合 ID", true),
    productLevel: boundedText(input.productLevel, 80, "产品级别", true),
    qualityStatus,
    acquiredAt: normalizeIso(input.acquiredAt, "成像时间"),
    geometry,
    platform: boundedText(input.platform, 120, "卫星平台", true),
    instruments,
    assets: normalizeAssets(input.assets),
    properties: normalizeProperties(input.properties),
    expectedRevision,
  };
}

export function buildStacItem(input: ObservationProductInput, links: { taskId: string; masterEventId: string }) {
  return {
    stac_version: "1.0.0",
    type: "Feature",
    id: input.itemId,
    collection: input.collectionId,
    bbox: geometryBbox(input.geometry),
    geometry: input.geometry,
    properties: {
      datetime: input.acquiredAt,
      platform: input.platform,
      instruments: input.instruments,
      "processing:level": input.productLevel,
      "quality:status": input.qualityStatus,
      "tianxun:task_id": links.taskId,
      "tianxun:master_event_id": links.masterEventId,
      ...input.properties,
    },
    links: [
      { rel: "derived_from", href: `/api/tasks?taskId=${encodeURIComponent(links.taskId)}`, title: "天巡卫星任务" },
      { rel: "via", href: `/api/events?masterEventId=${encodeURIComponent(links.masterEventId)}`, title: "天巡主灾害事件" },
    ],
    assets: input.assets,
  };
}

export function geometryBbox(geometry: GeoGeometry): [number, number, number, number] {
  const coordinates: Array<[number, number]> = [];
  collectCoordinates(geometry.coordinates, coordinates);
  if (!coordinates.length) throw new Error("产品几何不含有效坐标");
  return [
    Math.min(...coordinates.map((item) => item[0])),
    Math.min(...coordinates.map((item) => item[1])),
    Math.max(...coordinates.map((item) => item[0])),
    Math.max(...coordinates.map((item) => item[1])),
  ];
}

function collectCoordinates(value: unknown, output: Array<[number, number]>) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    output.push([Number(value[0]), Number(value[1])]);
    return;
  }
  value.forEach((item) => collectCoordinates(item, output));
}

function normalizeGeometry(value: unknown) {
  const result = validateGeoGeometry(value, { maximumVertices: 20_000, maximumRingVertices: 5_000, maximumAreaKm2: 25_000_000, rejectUnsplitAntimeridian: true });
  if (!result.ok) throw new Error(`产品几何无效：${result.reason ?? "未通过拓扑校验"}`);
  return JSON.parse(JSON.stringify(value)) as GeoGeometry;
}

function normalizeAssets(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("产品至少需要一个 STAC asset");
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > 30) throw new Error("产品 assets 数量必须为 1–30");
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("产品 asset 名称或结构无效");
    const asset = raw as Record<string, unknown>;
    const href = safeAssetHref(asset.href);
    const roles = Array.isArray(asset.roles) ? asset.roles.map((item) => boundedText(item, 40, "asset role", true)).slice(0, 10) : undefined;
    return [key, {
      href,
      ...(asset.type ? { type: boundedText(asset.type, 120, "asset type", true) } : {}),
      ...(asset.title ? { title: boundedText(asset.title, 220, "asset title", true) } : {}),
      ...(roles?.length ? { roles } : {}),
    }];
  }));
}

function safeAssetHref(value: unknown) {
  const text = boundedText(value, 2_000, "asset href", true);
  if (text.startsWith("/")) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch {
    throw new Error("asset href 只允许 HTTPS 或同源相对地址");
  }
}

function normalizeProperties(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("产品 properties 必须是对象");
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 32 * 1024) throw new Error("产品 properties 超过 32KB");
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  for (const protectedKey of ["datetime", "platform", "instruments", "processing:level", "quality:status", "tianxun:task_id", "tianxun:master_event_id"]) delete parsed[protectedKey];
  return parsed;
}

function boundedText(value: unknown, maximum: number, label: string, required: boolean) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maximum || [...normalized].some((character) => character.charCodeAt(0) < 32)) throw new Error(`${label}无效或过长`);
  return normalized;
}

function normalizeIso(value: unknown, label: string) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label}无效`);
  if (parsed > Date.now() + 5 * 60_000) throw new Error(`${label}不能晚于当前时间 5 分钟以上`);
  return new Date(parsed).toISOString();
}
