type GeoGeometry = { type: "Point" | "Polygon" | "MultiPolygon" | "LineString"; coordinates: unknown };

export function buildTaskAoi(task: Record<string, unknown>): GeoGeometry | null {
  const type = String(task.aoiType ?? "");
  const latitude = Number(task.latitude);
  const longitude = Number(task.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (type === "source") return isGeometry(task.sourceGeometry) ? task.sourceGeometry as GeoGeometry : null;
  const radius = Number(task.aoiRadiusKm);
  if (type === "point" && radius <= 0) return { type: "Point", coordinates: [longitude, latitude] };
  if (type === "point" || type === "circle") return splitDateLine(aoiCircle(latitude, longitude, Math.max(0.01, radius)));
  if (type === "rectangle" || type === "corridor") {
    const width = Number(task.aoiWidthKm);
    const height = type === "corridor" ? Number(task.aoiLengthKm) : Number(task.aoiHeightKm);
    const bearing = type === "corridor" ? Number(task.aoiBearingDeg) : 0;
    return splitDateLine(aoiRectangle(latitude, longitude, width, height, bearing));
  }
  return null;
}

function aoiRectangle(latitude: number, longitude: number, widthKm: number, heightKm: number, bearingDeg: number) {
  const bearing = bearingDeg * Math.PI / 180;
  const corners = [[-widthKm / 2, -heightKm / 2], [widthKm / 2, -heightKm / 2], [widthKm / 2, heightKm / 2], [-widthKm / 2, heightKm / 2], [-widthKm / 2, -heightKm / 2]];
  return corners.map(([east, north]) => {
    const rotatedEast = east * Math.cos(bearing) + north * Math.sin(bearing);
    const rotatedNorth = -east * Math.sin(bearing) + north * Math.cos(bearing);
    return destinationPoint(latitude, longitude, Math.hypot(rotatedEast, rotatedNorth), Math.atan2(rotatedEast, rotatedNorth) * 180 / Math.PI);
  });
}

function aoiCircle(latitude: number, longitude: number, radiusKm: number) {
  return Array.from({ length: 65 }, (_, index) => destinationPoint(latitude, longitude, radiusKm, 360 * index / 64));
}

function destinationPoint(latitude: number, longitude: number, distanceKm: number, bearingDeg: number): [number, number] {
  const angularDistance = distanceKm / 6371.0088;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  let lon = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
  lon = lon * 180 / Math.PI;
  while (lon - longitude > 180) lon -= 360;
  while (lon - longitude < -180) lon += 360;
  return [Number(lon.toFixed(6)), Number((lat2 * 180 / Math.PI).toFixed(6))];
}

function splitDateLine(ring: Array<[number, number]>): GeoGeometry {
  const maximum = Math.max(...ring.map((point) => point[0]));
  const minimum = Math.min(...ring.map((point) => point[0]));
  if (minimum >= -180 && maximum <= 180) return { type: "Polygon", coordinates: [ring] };
  const boundary = maximum > 180 ? 180 : -180;
  const inside = clipVertical(ring, boundary, maximum > 180 ? "less" : "greater");
  const outside = clipVertical(ring, boundary, maximum > 180 ? "greater" : "less").map(([lon, lat]) => [lon + (maximum > 180 ? -360 : 360), lat]);
  const polygons = [inside, outside].filter((part) => part.length >= 4).map((part) => [part]);
  return polygons.length > 1 ? { type: "MultiPolygon", coordinates: polygons } : { type: "Polygon", coordinates: [ring.map(([lon, lat]) => [normalizeLongitude(lon), lat])] };
}

function clipVertical(ring: Array<[number, number]>, boundary: number, side: "less" | "greater") {
  const result: Array<[number, number]> = [];
  const inside = (point: [number, number]) => side === "less" ? point[0] <= boundary : point[0] >= boundary;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index];
    const end = ring[index + 1];
    const startInside = inside(start);
    const endInside = inside(end);
    if (startInside) result.push(start);
    if (startInside !== endInside) {
      const ratio = (boundary - start[0]) / (end[0] - start[0]);
      result.push([boundary, Number((start[1] + ratio * (end[1] - start[1])).toFixed(6))]);
    }
  }
  if (result.length && (result[0][0] !== result[result.length - 1][0] || result[0][1] !== result[result.length - 1][1])) result.push([...result[0]]);
  return result;
}

function normalizeLongitude(value: number) {
  return Number((((value + 540) % 360) - 180).toFixed(6));
}

function isGeometry(value: unknown) {
  return Boolean(value && typeof value === "object" && ["Point", "LineString", "Polygon", "MultiPolygon"].includes(String((value as { type?: unknown }).type)) && Array.isArray((value as { coordinates?: unknown }).coordinates));
}
