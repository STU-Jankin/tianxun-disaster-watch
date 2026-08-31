import type { GeoGeometry } from "./task-aoi.ts";
import { geometryBbox } from "./stac-products.ts";

export const aoiWorkPackageStatuses = ["open", "claimed", "submitted", "in_review", "changes_requested", "approved", "cancelled"] as const;
export type AoiWorkPackageStatus = (typeof aoiWorkPackageStatuses)[number];

export type AoiWorkPackage = {
  packageId: string;
  masterEventId: string;
  sourceTaskId: string;
  owner: string;
  title: string;
  geometry: GeoGeometry;
  aoiHash: string;
  status: AoiWorkPackageStatus;
  assignee: string;
  reviewer: string;
  priority: number;
  reviewNote: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AoiWorkPackageAction = "claim" | "release" | "submit" | "start_review" | "approve" | "request_changes" | "cancel";

const transitions: Record<AoiWorkPackageStatus, Partial<Record<AoiWorkPackageAction, AoiWorkPackageStatus>>> = {
  open: { claim: "claimed", cancel: "cancelled" },
  claimed: { release: "open", submit: "submitted", cancel: "cancelled" },
  submitted: { start_review: "in_review", approve: "approved", request_changes: "changes_requested", cancel: "cancelled" },
  in_review: { approve: "approved", request_changes: "changes_requested", cancel: "cancelled" },
  changes_requested: { claim: "claimed", cancel: "cancelled" },
  approved: {},
  cancelled: {},
};

export function transitionAoiWorkPackage(current: AoiWorkPackage, action: AoiWorkPackageAction, actor: string, note = ""): AoiWorkPackage {
  const status = transitions[current.status][action];
  if (!status) throw new Error(`AOI 分块不允许执行 ${action}：当前状态 ${current.status}`);
  if (["release", "submit"].includes(action) && current.assignee !== actor) throw new Error("只有当前领取人可以提交或释放该分块");
  if (["start_review", "approve", "request_changes"].includes(action) && current.assignee === actor) throw new Error("领取人与复核人必须分离，不能自审");
  if (action === "request_changes" && note.trim().length < 3) throw new Error("退回修改必须填写至少 3 个字的原因");
  const updatedAt = new Date().toISOString();
  return {
    ...current,
    status,
    assignee: action === "claim" ? actor : action === "release" ? "" : current.assignee,
    reviewer: ["start_review", "approve", "request_changes"].includes(action) ? actor : current.reviewer,
    reviewNote: note.trim().slice(0, 1_000),
    revision: current.revision + 1,
    updatedAt,
  };
}

export function partitionAoiGeometry(geometry: GeoGeometry, options: { widthKm: number; heightKm: number; maximumPackages?: number }) {
  const widthKm = boundedDimension(options.widthKm, "分块宽度");
  const heightKm = boundedDimension(options.heightKm, "分块高度");
  const maximumPackages = Math.max(1, Math.min(200, Math.trunc(options.maximumPackages ?? 100)));
  const bbox = geometryBbox(geometry);
  if (geometry.type === "Point") return [rectangleAround(Number((geometry.coordinates as number[])[1]), Number((geometry.coordinates as number[])[0]), widthKm, heightKm)];
  const midLatitude = (bbox[1] + bbox[3]) / 2;
  const latStep = heightKm / 110.574;
  const lonStep = widthKm / Math.max(1, 111.320 * Math.cos(midLatitude * Math.PI / 180));
  const columns = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / lonStep));
  const rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / latStep));
  if (columns * rows > maximumPackages * 8) throw new Error(`AOI 预计生成 ${columns * rows} 个候选网格，超过安全上限；请增大分块幅宽`);
  const packages: GeoGeometry[] = [];
  for (let row = 0; row < rows; row += 1) {
    const south = bbox[1] + row * latStep;
    const north = Math.min(bbox[3], south + latStep);
    for (let column = 0; column < columns; column += 1) {
      const west = bbox[0] + column * lonStep;
      const east = Math.min(bbox[2], west + lonStep);
      const tile = rectangle(west, south, east, north);
      if (!geometryIntersectsRectangle(geometry, [west, south, east, north])) continue;
      packages.push(tile);
      if (packages.length > maximumPackages) throw new Error(`AOI 分块超过 ${maximumPackages} 块；请增大分块幅宽或拆分任务`);
    }
  }
  if (!packages.length) throw new Error("AOI 未生成有效分块");
  return packages;
}

function geometryIntersectsRectangle(geometry: GeoGeometry, bbox: [number, number, number, number]) {
  const [west, south, east, north] = bbox;
  const points: Array<[number, number]> = [];
  collectPoints(geometry.coordinates, points);
  if (points.some(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north)) return true;
  const center: [number, number] = [(west + east) / 2, (south + north) / 2];
  if (geometry.type === "Polygon") return pointInPolygon(center, geometry.coordinates as number[][][]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).some((polygon) => pointInPolygon(center, polygon));
  return points.some(([lon, lat]) => Math.abs(lon - center[0]) <= east - west && Math.abs(lat - center[1]) <= north - south);
}

function pointInPolygon(point: [number, number], polygon: number[][][]) {
  const insideRing = (ring: number[][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = Number(ring[i][0]); const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]); const yj = Number(ring[j][1]);
      if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
    }
    return inside;
  };
  return Boolean(polygon[0] && insideRing(polygon[0]) && !polygon.slice(1).some(insideRing));
}

function collectPoints(value: unknown, output: Array<[number, number]>) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) { output.push([Number(value[0]), Number(value[1])]); return; }
  value.forEach((item) => collectPoints(item, output));
}

function rectangleAround(latitude: number, longitude: number, widthKm: number, heightKm: number) {
  const halfLat = heightKm / 110.574 / 2;
  const halfLon = widthKm / Math.max(1, 111.320 * Math.cos(latitude * Math.PI / 180)) / 2;
  return rectangle(longitude - halfLon, latitude - halfLat, longitude + halfLon, latitude + halfLat);
}

function rectangle(west: number, south: number, east: number, north: number): GeoGeometry {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]].map(([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))])] };
}

function boundedDimension(value: number, label: string) {
  if (!Number.isFinite(value) || value < 1 || value > 1_000) throw new Error(`${label}必须在 1–1000 km 之间`);
  return value;
}
