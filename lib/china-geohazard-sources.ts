import type { DisasterEvent, HazardSubtype } from "./disasters.ts";

export type MemGeohazardListingItem = {
  url: string;
  title: string;
  publishedAt: string;
};

export type MemGeohazardBulletin = {
  sourceEventId: string;
  title: string;
  hazardSubtype: HazardSubtype;
  locationQuery: string;
  occurredAt: string;
  updatedAt: string;
  sourceUrl: string;
  sourceSeverity: string;
  severity: DisasterEvent["severity"];
  description: string;
  country: string;
  originCountry?: string;
  affectedCountries: string[];
  crossBorder: boolean;
};

const memListingUrl = "https://www.mem.gov.cn/xw/yjglbgzdt/";
const geohazardPattern = /泥石流|滑坡|山体滑坡|山体崩塌|崩塌|落石|地质灾害/i;
const confirmedOccurrencePattern = /(?:发生|突发|遭受)[^。；]{0,36}(?:泥石流|滑坡|山体崩塌|崩塌|落石)(?:灾害|险情)?|(?:泥石流|滑坡|山体崩塌|崩塌|落石)(?:灾害|险情)[^。；]{0,24}(?:发生|造成|导致)/i;

export function parseMemGeohazardListing(html: string, now = Date.now(), maximumAgeDays = 7): MemGeohazardListingItem[] {
  const maximumAgeMs = Math.max(1, Math.min(14, maximumAgeDays)) * 86_400_000;
  const items = [...html.matchAll(/<a\s+href=["']([^"']*t\d{8}_\d+\.shtml)["'][^>]*>([\s\S]*?)<span[^>]*>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*<\/span>\s*<\/a>/gi)]
    .flatMap((match): MemGeohazardListingItem[] => {
      const title = htmlText(match[2]);
      const publishedAt = chinaLocalIso(`${match[3]}:00`);
      if (!publishedAt || !geohazardPattern.test(title)) return [];
      const age = now - Date.parse(publishedAt);
      if (age < -10 * 60_000 || age > maximumAgeMs) return [];
      let url: string;
      try { url = new URL(match[1], memListingUrl).toString(); } catch { return []; }
      if (new URL(url).hostname !== "www.mem.gov.cn") return [];
      return [{ url, title, publishedAt }];
    });
  return [...new Map(items.map((item) => [item.url, item])).values()].slice(0, 12);
}

export function parseMemGeohazardBulletin(html: string, sourceUrl: string): MemGeohazardBulletin | null {
  let safeUrl: URL;
  try { safeUrl = new URL(sourceUrl); } catch { return null; }
  if (safeUrl.protocol !== "https:" || safeUrl.hostname !== "www.mem.gov.cn") return null;

  const title = metaContent(html, "ArticleTitle") || htmlText(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/--中华人民共和国应急管理部.*$/, "");
  const publishedAt = chinaLocalIso(metaContent(html, "PubDate"));
  const editor = firstMatch(html, /<div\s+class=(?:["'])?TRS_Editor(?:["'])?[^>]*>([\s\S]*?)<\/div>/i);
  const body = htmlText(editor);
  const combined = `${title}。${body}`;
  if (!title || !publishedAt || !geohazardPattern.test(combined) || !confirmedOccurrencePattern.test(combined)) return null;

  const hazardSubtype = classifySubtype(combined);
  const occurredAt = occurrenceTime(combined, publishedAt);
  const locationQuery = extractLocation(combined);
  if (!occurredAt || !locationQuery || Date.parse(occurredAt) > Date.parse(publishedAt) + 10 * 60_000) return null;

  const originCountry = extractOriginCountry(combined);
  const affectedCountries = chineseAffectedLocation(locationQuery) ? ["中国"] : [];
  const crossBorder = Boolean(originCountry && originCountry !== "中国" && affectedCountries.includes("中国"));
  const severity = bulletinSeverity(combined);
  const occurrenceLabel = hazardSubtype === "debris_flow" ? "泥石流" : hazardSubtype === "rockfall" ? "崩塌/落石" : "滑坡";
  return {
    sourceEventId: `mem-geohazard-${fnv1a(`${hazardSubtype}|${occurredAt.slice(0, 10)}|${locationQuery}`)}`,
    title: `${occurrenceLabel}实况 · ${locationQuery}`,
    hazardSubtype,
    locationQuery,
    occurredAt,
    updatedAt: publishedAt,
    sourceUrl: safeUrl.toString(),
    sourceSeverity: responseLevel(combined) || "应急管理部已确认灾情",
    severity,
    description: `应急管理部公开通报确认该灾害已经发生。位置为官方报道地名经地理编码得到的代表点，不是官方灾害边界；下发卫星任务前必须结合遥感、现场或更精确坐标核对 AOI。${crossBorder ? ` 灾害起源于${originCountry}，受影响地位于中国，按跨境影响事件处理。` : ""} ${body.slice(0, 1_200)}`.trim(),
    country: affectedCountries.includes("中国") ? `中国 · ${locationQuery}` : locationQuery,
    originCountry,
    affectedCountries,
    crossBorder,
  };
}

function classifySubtype(value: string): HazardSubtype {
  if (/泥石流/.test(value)) return "debris_flow";
  if (/崩塌|落石/.test(value)) return "rockfall";
  if (/边坡失稳/.test(value)) return "slope_failure";
  return "landslide";
}

function occurrenceTime(value: string, publishedAt: string) {
  const full = value.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*时(?:\s*(\d{1,2})\s*分)?/);
  if (full) return localPartsIso(Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4]), Number(full[5] ?? 0));
  const partial = value.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*时(?:\s*(\d{1,2})\s*分)?/);
  if (!partial) return null;
  const published = new Date(publishedAt);
  return localPartsIso(published.getUTCFullYear(), Number(partial[1]), Number(partial[2]), Number(partial[3]), Number(partial[4] ?? 0));
}

function extractLocation(value: string) {
  const knownLocations = [
    "西藏日喀则市吉隆县吉隆口岸",
    "西藏自治区日喀则市吉隆县吉隆口岸",
  ];
  const known = knownLocations.find((location) => value.includes(location));
  if (known) return known.replace(/^西藏(?=日喀则)/, "西藏自治区");

  const candidates = [...value.matchAll(/(?:造成|导致|发生于|位于)([\u4e00-\u9fff]{2,48}?(?:口岸|自治州|地区|县|区|市|镇|乡|村))(?=重大|人员|群众|房屋|道路|桥梁|受灾|出现|发生|，|。|；)/g)]
    .map((match) => match[1].replace(/^(?:在|了)/, ""))
    .filter((candidate) => candidate.length >= 3 && candidate.length <= 48)
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? "";
}

function extractOriginCountry(value: string) {
  const match = value.match(/因([\u4e00-\u9fff]{2,12}?)(?:一侧|境内)?发生(?:泥石流|滑坡|崩塌|落石)/);
  if (!match) return undefined;
  const origin = match[1].replace(/(?:一侧|境内)$/, "");
  if (/尼泊尔/.test(origin)) return "尼泊尔";
  if (/中国|我国/.test(origin)) return "中国";
  return origin.slice(0, 12);
}

function chineseAffectedLocation(value: string) {
  return /中国|西藏|新疆|内蒙古|广西|宁夏|北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海/.test(value);
}

function bulletinSeverity(value: string): DisasterEvent["severity"] {
  if (/一级应急响应|重大人员伤亡|特大/.test(value)) return "red";
  if (/二级应急响应|严重|多人失联/.test(value)) return "orange";
  if (/三级应急响应|较大/.test(value)) return "yellow";
  return "blue";
}

function responseLevel(value: string) {
  const match = value.match(/(?:国家|自然灾害|地质灾害|救灾)?[一二三四]级(?:救灾|地质灾害)?应急响应/);
  return match?.[0] ?? "";
}

function chinaLocalIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return match ? localPartsIso(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)) : null;
}

function localPartsIso(year: number, month: number, day: number, hour: number, minute: number, second = 0) {
  const utc = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const date = new Date(utc);
  const localCheck = new Date(utc + 8 * 3_600_000);
  if (localCheck.getUTCFullYear() !== year || localCheck.getUTCMonth() + 1 !== month || localCheck.getUTCDate() !== day
      || localCheck.getUTCHours() !== hour || localCheck.getUTCMinutes() !== minute) return null;
  return date.toISOString();
}

function metaContent(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(firstMatch(html, new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"))
    || firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"))).trim();
}

function firstMatch(value: string, pattern: RegExp) {
  return value.match(pattern)?.[1] ?? "";
}

function htmlText(value: string) {
  return decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/p>|<\/li>|<\/h\d>/gi, "。")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/。{2,}/g, "。")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;|&ensp;|&emsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function fnv1a(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
