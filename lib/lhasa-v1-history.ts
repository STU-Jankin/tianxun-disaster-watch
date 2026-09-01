export const lhasaV1CollectionConceptId = "C2036912694-GES_DISC";
export const lhasaV1DatasetUrl = "https://catalog.data.gov/dataset/global-landslide-nowcast-from-lhasa-l4-1-day-1-km-x-1-km-version-1-1-global_landslide_nowc";
export const lhasaV1Doi = "10.5067/0D23ALHMHHT5";
export const lhasaV1CoverageStart = "2000-06-14";
export const lhasaV1CoverageEnd = "2020-12-31";
export const lhasaV1CmrMaximumBytes = 128 * 1024;

export type LhasaV1GranuleStatus = "available" | "not_found" | "metadata_error";

export type LhasaV1GranuleMetadata = {
  productDate: string;
  status: LhasaV1GranuleStatus;
  collectionConceptId: string;
  granuleConceptId?: string;
  producerGranuleId?: string;
  downloadUrl?: string;
  granuleSizeMb?: number;
  timeStart?: string;
  timeEnd?: string;
  message: string;
};

export type LhasaV1GranuleProbeRecord = LhasaV1GranuleMetadata & {
  caseId: string;
  checkedAt: string;
};

export function lhasaV1ProductDate(occurredAt: string) {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return null;
  const productDate = date.toISOString().slice(0, 10);
  return productDate >= lhasaV1CoverageStart && productDate <= lhasaV1CoverageEnd ? productDate : null;
}

export function lhasaV1ProducerGranuleId(productDate: string) {
  requireProductDate(productDate);
  return `Global_Landslide_Nowcast_v1.1_${productDate.replaceAll("-", "")}.tif`;
}

export function buildLhasaV1CmrSearchUrl(productDate: string) {
  requireProductDate(productDate);
  const start = `${productDate}T00:00:00Z`;
  const end = `${productDate}T23:59:59Z`;
  const url = new URL("https://cmr.earthdata.nasa.gov/search/granules.json");
  url.searchParams.set("collection_concept_id", lhasaV1CollectionConceptId);
  url.searchParams.set("temporal", `${start},${end}`);
  url.searchParams.set("page_size", "5");
  return url.toString();
}

export async function probeLhasaV1Granule(productDate: string, fetcher: typeof fetch = fetch): Promise<LhasaV1GranuleMetadata> {
  const response = await fetcher(buildLhasaV1CmrSearchUrl(productDate), {
    headers: { "Accept": "application/json", "Client-Id": "tianxun-disaster-watch" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NASA CMR metadata request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > lhasaV1CmrMaximumBytes) throw new Error("NASA CMR metadata response exceeds the safety limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > lhasaV1CmrMaximumBytes) throw new Error("NASA CMR metadata response exceeds the safety limit");
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return parseLhasaV1CmrPayload(payload, productDate);
}

export function parseLhasaV1CmrPayload(payload: unknown, productDate: string): LhasaV1GranuleMetadata {
  requireProductDate(productDate);
  const expectedId = lhasaV1ProducerGranuleId(productDate);
  const entries = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { feed?: { entry?: unknown } }).feed?.entry
    : undefined;
  if (!Array.isArray(entries)) throw new Error("NASA CMR metadata response has an invalid feed");
  const match = entries.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { producer_granule_id?: unknown }).producer_granule_id === expectedId) as Record<string, unknown> | undefined;
  if (!match) {
    return {
      productDate,
      status: "not_found",
      collectionConceptId: lhasaV1CollectionConceptId,
      message: "CMR未返回该日期的LHASA 1.1逐日产品；不能判定模型未命中。",
    };
  }
  const links = Array.isArray(match.links) ? match.links : [];
  const dataLink = links.find((link) => link && typeof link === "object" && !Array.isArray(link)
    && (link as { rel?: unknown }).rel === "http://esipfed.org/ns/fedsearch/1.1/data#"
    && safeDataUrl((link as { href?: unknown }).href));
  const downloadUrl = dataLink && typeof dataLink === "object" ? safeDataUrl((dataLink as { href?: unknown }).href) : null;
  if (!downloadUrl) throw new Error("NASA CMR granule metadata does not contain a trusted GeoTIFF download link");
  const granuleConceptId = boundedText(match.id, 80);
  const timeStart = isoText(match.time_start);
  const timeEnd = isoText(match.time_end);
  const granuleSizeMb = finiteRange(match.granule_size, 0, 100);
  return {
    productDate,
    status: "available",
    collectionConceptId: lhasaV1CollectionConceptId,
    granuleConceptId: granuleConceptId || undefined,
    producerGranuleId: expectedId,
    downloadUrl,
    granuleSizeMb: granuleSizeMb ?? undefined,
    timeStart: timeStart ?? undefined,
    timeEnd: timeEnd ?? undefined,
    message: "CMR已确认历史GeoTIFF存在；尚未下载或读取核验点像元。",
  };
}

function requireProductDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < lhasaV1CoverageStart || value > lhasaV1CoverageEnd) {
    throw new Error("LHASA 1.1 product date is outside the official archive coverage");
  }
}

function safeDataUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "data.gesdisc.earthdata.nasa.gov" || !url.pathname.endsWith(".tif") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function isoText(value: unknown) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function finiteRange(value: unknown, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}
