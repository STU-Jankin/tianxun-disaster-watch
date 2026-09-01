export type ForecastRasterStorageBackend = "r2" | "filesystem";

type R2ObjectBodyLike = { arrayBuffer(): Promise<ArrayBuffer> };
type R2BucketLike = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
};

const archiveBinding = "FORECAST_ARCHIVE";

export async function storeForecastRasterObject(input: {
  storageKey: string;
  bytes: ArrayBuffer;
  contentType: string;
  metadata: Record<string, string>;
}): Promise<ForecastRasterStorageBackend> {
  const storageKey = safeStorageKey(input.storageKey);
  const bucket = await loadCloudflareBucket();
  if (bucket) {
    await bucket.put(storageKey, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: input.metadata,
    });
    return "r2";
  }
  await writeLocalArchive(storageKey, input.bytes);
  return "filesystem";
}

export async function readForecastRasterObject(storageKey: string, backend: ForecastRasterStorageBackend): Promise<ArrayBuffer | null> {
  const safeKey = safeStorageKey(storageKey);
  if (backend === "r2") {
    const bucket = await loadCloudflareBucket();
    if (!bucket) return null;
    return (await bucket.get(safeKey))?.arrayBuffer() ?? null;
  }
  return readLocalArchive(safeKey);
}

async function loadCloudflareBucket(): Promise<R2BucketLike | null> {
  try {
    const workers = await import("cloudflare:workers");
    return ((workers.env as unknown as Record<string, unknown>)[archiveBinding] as R2BucketLike | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeLocalArchive(storageKey: string, bytes: ArrayBuffer) {
  const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const [fs, path] = await Promise.all([
    dynamicImport("node:fs/promises") as Promise<{ mkdir(path: string, options: { recursive: boolean }): Promise<void>; writeFile(path: string, data: Uint8Array): Promise<void> }>,
    dynamicImport("node:path") as Promise<{ dirname(path: string): string; resolve(...paths: string[]): string; sep: string }>,
  ]);
  const root = path.resolve(process.env.TIANXUN_FORECAST_ARCHIVE_DIR || ".data/forecast-archive");
  const destination = path.resolve(root, storageKey);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("预测归档路径越界");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, new Uint8Array(bytes));
}

async function readLocalArchive(storageKey: string) {
  const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const [fs, path] = await Promise.all([
    dynamicImport("node:fs/promises") as Promise<{ readFile(path: string): Promise<Uint8Array> }>,
    dynamicImport("node:path") as Promise<{ resolve(...paths: string[]): string; sep: string }>,
  ]);
  const root = path.resolve(process.env.TIANXUN_FORECAST_ARCHIVE_DIR || ".data/forecast-archive");
  const source = path.resolve(root, storageKey);
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error("预测归档路径越界");
  try {
    const bytes = await fs.readFile(source);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function safeStorageKey(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (!/^[a-z0-9][a-z0-9._/-]{1,240}$/i.test(normalized) || normalized.includes("..") || normalized.startsWith("/") || normalized.endsWith("/")) {
    throw new Error("预测归档对象键无效");
  }
  return normalized;
}

function isMissingFile(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
