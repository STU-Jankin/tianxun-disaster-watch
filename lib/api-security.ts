function timingSafeEqualText(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function authorizeApiRequest(request: Request) {
  const expectedToken = process.env.TIANXUN_API_TOKEN?.trim();
  const proxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (isStrongSecret(expectedToken) && bearer && timingSafeEqualText(bearer, expectedToken!)) return null;
  const suppliedProxySecret = request.headers.get("x-tianxun-proxy-secret") ?? "";
  if (isStrongSecret(proxySecret) && suppliedProxySecret && timingSafeEqualText(suppliedProxySecret, proxySecret!)) return null;

  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (process.env.NODE_ENV !== "production" && !expectedToken && local) return null;
  if (!isStrongSecret(expectedToken) && !isStrongSecret(proxySecret)) {
    return Response.json({ error: "服务端鉴权尚未安全配置" }, { status: 503 });
  }
  return Response.json({ error: "未授权访问；请使用站点身份或配置的 API Bearer Token" }, { status: 401 });
}

export function rejectCrossOriginBrowserWrite(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ") || request.headers.get("x-tianxun-proxy-secret")) return null;
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return null;
  } catch {
    // fall through
  }
  return Response.json({ error: "拒绝跨站写入请求" }, { status: 403 });
}

export function apiActor(request: Request) {
  const expectedProxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  const suppliedProxySecret = request.headers.get("x-tianxun-proxy-secret") ?? "";
  if (isStrongSecret(expectedProxySecret) && suppliedProxySecret && timingSafeEqualText(suppliedProxySecret, expectedProxySecret)) {
    return sanitizeActor(request.headers.get("x-tianxun-user")) || "trusted-proxy-user";
  }
  return request.headers.get("authorization")?.startsWith("Bearer ") ? "api-token" : "local-developer";
}

export async function readJsonObject(request: Request, maximumBytes = 64 * 1024) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new ApiInputError("请求体过大", 413);
  if (!request.body) throw new ApiInputError("请求体为空", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ApiInputError("请求体过大", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiInputError("请求体不是有效 JSON 对象", 400);
  }
}

function isStrongSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= 32 && !/replace|example|changeme|placeholder/i.test(value));
}

function sanitizeActor(value: string | null) {
  return value?.trim().replace(/[^\p{L}\p{N}@._-]+/gu, "-").slice(0, 120) ?? "";
}

export class ApiInputError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const rateState = globalThis as typeof globalThis & { __tianxunRateLimits?: Map<string, { count: number; resetAt: number }> };

export function enforceRateLimit(request: Request, action: string, limit: number, windowMs = 60_000) {
  const store = rateState.__tianxunRateLimits ??= new Map();
  const now = Date.now();
  if (store.size > 2_000) for (const [key, value] of store) if (value.resetAt <= now) store.delete(key);
  const actor = apiActor(request);
  const key = `${actor}:${action}`;
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  current.count += 1;
  if (current.count <= limit) return null;
  return Response.json({ error: "请求过于频繁，请稍后重试" }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))) } });
}
