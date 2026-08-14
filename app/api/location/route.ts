export const dynamic = "force-dynamic";

type CachedLocation = { locationZh: string; source: "Nominatim" | "fallback"; cachedAt: number };

const globalCache = globalThis as typeof globalThis & {
  __tianxunLocationCache?: Map<string, CachedLocation>;
  __tianxunLastGeocodeAt?: number;
};

const cache = globalCache.__tianxunLocationCache ??= new Map<string, CachedLocation>();
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));
  const fallback = url.searchParams.get("fallback")?.slice(0, 220) ?? "";
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return Response.json({ error: "坐标无效" }, { status: 400 });
  }

  const key = `zh-v2:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return Response.json({ locationZh: cached.locationZh, source: cached.source, cached: true });
  }

  const minimumWait = 1_050 - (Date.now() - (globalCache.__tianxunLastGeocodeAt ?? 0));
  if (minimumWait > 0) await new Promise((resolve) => setTimeout(resolve, minimumWait));
  globalCache.__tianxunLastGeocodeAt = Date.now();

  try {
    const endpoint = new URL("https://nominatim.openstreetmap.org/reverse");
    endpoint.searchParams.set("format", "jsonv2");
    endpoint.searchParams.set("lat", String(latitude));
    endpoint.searchParams.set("lon", String(longitude));
    endpoint.searchParams.set("zoom", "10");
    endpoint.searchParams.set("addressdetails", "1");
    endpoint.searchParams.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.5");
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Tianxun-Disaster-Watch/0.1 (disaster location display)",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
        Referer: new URL(request.url).origin,
      },
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) throw new Error(`reverse geocode ${response.status}`);
    const data = await response.json() as {
      display_name?: string;
      address?: Record<string, string>;
    };
    const locationZh = formatChineseAddress(data.address, data.display_name) || fallbackLocation(fallback, latitude, longitude);
    const result: CachedLocation = { locationZh, source: "Nominatim", cachedAt: Date.now() };
    cache.set(key, result);
    return Response.json({ locationZh, source: result.source, cached: false });
  } catch {
    const locationZh = fallbackLocation(fallback, latitude, longitude);
    const result: CachedLocation = { locationZh, source: "fallback", cachedAt: Date.now() };
    cache.set(key, result);
    return Response.json({ locationZh, source: result.source, cached: false });
  }
}

function formatChineseAddress(address: Record<string, string> | undefined, displayName?: string) {
  if (!address) return displayName?.trim() ?? "";
  const country = address.country ?? "";
  const state = address.state ?? address.region ?? address.province ?? "";
  const county = address.county ?? address.state_district ?? "";
  const locality = address.city ?? address.town ?? address.village ?? address.municipality ?? "";
  const parts = [country, state, county, locality].filter(Boolean);
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.join(" · ") || displayName?.trim() || "";
}

function fallbackLocation(original: string, latitude: number, longitude: number) {
  const known = original
    .replace(/South Sandwich Islands region/gi, "南桑威奇群岛地区")
    .replace(/Pacific-Antarctic Ridge/gi, "太平洋—南极洋海岭")
    .replace(/Western Australia/gi, "西澳大利亚州")
    .replace(/Wuxi/gi, "无锡市")
    .replace(/Jiangsu/gi, "江苏省")
    .replace(/Japan/gi, "日本")
    .replace(/Indonesia/gi, "印度尼西亚")
    .replace(/China/gi, "中国")
    .replace(/Colombia/gi, "哥伦比亚")
    .replace(/Guatemala/gi, "危地马拉")
    .replace(/Pakistan/gi, "巴基斯坦")
    .replace(/Papua New Guinea/gi, "巴布亚新几内亚")
    .replace(/Tonga/gi, "汤加")
    .replace(/India/gi, "印度")
    .trim();
  const directional = known.match(/^(\d+(?:\.\d+)?)\s*km\s+(NNW|NNE|SSW|SSE|ENE|ESE|WNW|WSW|N|S|E|W|NE|NW|SE|SW)\s+of\s+(.+)$/i);
  if (directional) {
    const direction: Record<string, string> = {
      N: "以北", S: "以南", E: "以东", W: "以西",
      NE: "东北", NW: "西北", SE: "东南", SW: "西南",
      NNW: "北偏西", NNE: "北偏东", SSW: "南偏西", SSE: "南偏东",
      ENE: "东偏北", ESE: "东偏南", WNW: "西偏北", WSW: "西偏南",
    };
    const target = directional[3].replace(/,\s*/g, " · ");
    return `${target}${direction[directional[2].toUpperCase()]}约${directional[1]}公里`;
  }
  if (known && known !== original.trim()) return known;
  return `坐标 ${formatCoordinate(latitude, "北", "南")}，${formatCoordinate(longitude, "东", "西")}`;
}

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(3)}°${value >= 0 ? positive : negative}`;
}
