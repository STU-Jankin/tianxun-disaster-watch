import { authenticateWebRequest, hasWebSessionCookie, webAuthConfiguration, webSessionRateKey } from "./web-auth.ts";

function timingSafeEqualText(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export type ApiRole = "viewer" | "operator" | "executor" | "admin";

export async function authorizeApiRequest(request: Request, requiredRole: ApiRole = "viewer") {
  const expectedToken = process.env.TIANXUN_API_TOKEN?.trim();
  const viewerToken = process.env.TIANXUN_VIEWER_TOKEN?.trim();
  const operatorToken = process.env.TIANXUN_OPERATOR_TOKEN?.trim();
  const executorToken = process.env.TIANXUN_EXECUTOR_TOKEN?.trim();
  const proxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  let role: ApiRole | null;
  try {
    role = await apiRole(request);
  } catch (error) {
    console.error("web session lookup unavailable", error);
    return Response.json({ error: "登录会话服务暂不可用" }, { status: 503 });
  }
  if (role) {
    if (roleAllows(role, requiredRole)) return null;
    return Response.json({ error: `当前身份缺少 ${requiredRole} 权限` }, { status: 403 });
  }

  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (process.env.NODE_ENV !== "production" && !expectedToken && !viewerToken && !operatorToken && !executorToken && local) return null;
  if (![expectedToken, viewerToken, operatorToken, executorToken, proxySecret].some(isStrongSecret) && !webAuthConfiguration().configured) {
    return Response.json({ error: "服务端鉴权尚未安全配置" }, { status: 503 });
  }
  return Response.json({ error: "未授权访问；请使用站点身份或配置的 API Bearer Token" }, { status: 401 });
}

export async function apiRole(request: Request): Promise<ApiRole | null> {
  const bearer = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7).trim() : "";
  if (isStrongSecret(process.env.TIANXUN_API_TOKEN?.trim()) && bearer && timingSafeEqualText(bearer, process.env.TIANXUN_API_TOKEN!.trim())) return "admin";
  if (isStrongSecret(process.env.TIANXUN_VIEWER_TOKEN?.trim()) && bearer && timingSafeEqualText(bearer, process.env.TIANXUN_VIEWER_TOKEN!.trim())) return "viewer";
  if (isStrongSecret(process.env.TIANXUN_OPERATOR_TOKEN?.trim()) && bearer && timingSafeEqualText(bearer, process.env.TIANXUN_OPERATOR_TOKEN!.trim())) return "operator";
  if (isStrongSecret(process.env.TIANXUN_EXECUTOR_TOKEN?.trim()) && bearer && timingSafeEqualText(bearer, process.env.TIANXUN_EXECUTOR_TOKEN!.trim())) return "executor";
  const proxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  const suppliedProxySecret = request.headers.get("x-tianxun-proxy-secret") ?? "";
  if (isStrongSecret(proxySecret) && suppliedProxySecret && timingSafeEqualText(suppliedProxySecret, proxySecret)) return normalizeRole(request.headers.get("x-tianxun-role")) ?? "viewer";
  const webSession = await authenticateWebRequest(request);
  if (webSession) return webSession.role;
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (process.env.NODE_ENV !== "production" && local && ![process.env.TIANXUN_API_TOKEN, process.env.TIANXUN_VIEWER_TOKEN, process.env.TIANXUN_OPERATOR_TOKEN, process.env.TIANXUN_EXECUTOR_TOKEN].some(isStrongSecret)) return "admin";
  return null;
}

export function rejectCrossOriginBrowserWrite(request: Request) {
  // A trusted reverse proxy authenticates the server-to-server hop, not the
  // browser origin. Keep same-origin enforcement for proxied browser writes.
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return null;
  const origin = request.headers.get("origin");
  if (!origin) {
    if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") {
      return Response.json({ error: "拒绝跨站写入请求" }, { status: 403 });
    }
    return hasWebSessionCookie(request) ? Response.json({ error: "浏览器会话写入缺少同源证明" }, { status: 403 }) : null;
  }
  try {
    if (new URL(origin).origin === browserVisibleOrigin(request)) return null;
  } catch {
    // fall through
  }
  return Response.json({ error: "拒绝跨站写入请求" }, { status: 403 });
}

function browserVisibleOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProtocol = firstForwardedValue(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  if (forwardedProtocol === "https" || forwardedProtocol === "http") requestUrl.protocol = `${forwardedProtocol}:`;
  const forwardedHost = validForwardedHost(firstForwardedValue(request.headers.get("x-forwarded-host")));
  if (forwardedHost) requestUrl.host = forwardedHost;
  const forwardedPort = firstForwardedValue(request.headers.get("x-forwarded-port"));
  if (forwardedPort && /^\d{1,5}$/.test(forwardedPort)) {
    const port = Number(forwardedPort);
    if (port >= 1 && port <= 65_535) requestUrl.port = forwardedPort;
  }
  return requestUrl.origin;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || null;
}

function validForwardedHost(value: string | null) {
  if (!value || value.length > 255 || /[\s/@?#\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.host;
  } catch {
    return null;
  }
}

export async function apiActor(request: Request) {
  const expectedProxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  const suppliedProxySecret = request.headers.get("x-tianxun-proxy-secret") ?? "";
  if (isStrongSecret(expectedProxySecret) && suppliedProxySecret && timingSafeEqualText(suppliedProxySecret, expectedProxySecret)) {
    return sanitizeActor(request.headers.get("x-tianxun-user")) || "trusted-proxy-user";
  }
  const bearer = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7).trim() : "";
  if (isStrongSecret(process.env.TIANXUN_OPERATOR_TOKEN?.trim()) && timingSafeEqualText(bearer, process.env.TIANXUN_OPERATOR_TOKEN!.trim())) return "operator-token";
  if (isStrongSecret(process.env.TIANXUN_EXECUTOR_TOKEN?.trim()) && timingSafeEqualText(bearer, process.env.TIANXUN_EXECUTOR_TOKEN!.trim())) return "executor-token";
  const session = await authenticateWebRequest(request);
  if (session) return sanitizeActor(session.username) || "web-operator";
  return bearer ? "admin-token" : "local-developer";
}

function normalizeRole(value: string | null): ApiRole | null {
  return ["viewer", "operator", "executor", "admin"].includes(value ?? "") ? value as ApiRole : null;
}

function roleAllows(actual: ApiRole, required: ApiRole) {
  if (actual === "admin" || actual === required) return true;
  return required === "viewer";
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
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const rateState = globalThis as typeof globalThis & { __tianxunRateLimits?: Map<string, { count: number; resetAt: number }> };

export function enforceRateLimit(request: Request, action: string, limit: number, windowMs = 60_000) {
  const store = rateState.__tianxunRateLimits ??= new Map();
  const now = Date.now();
  if (store.size > 2_000) for (const [key, value] of store) if (value.resetAt <= now) store.delete(key);
  const actor = rateLimitActor(request);
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

function rateLimitActor(request: Request) {
  const proxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET?.trim();
  const suppliedProxySecret = request.headers.get("x-tianxun-proxy-secret") ?? "";
  if (isStrongSecret(proxySecret) && suppliedProxySecret && timingSafeEqualText(suppliedProxySecret, proxySecret)) {
    return sanitizeActor(request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-tianxun-user")) || "trusted-proxy";
  }
  const bearer = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7).trim() : "";
  if (bearer) return `bearer-${bearer.slice(0, 12)}`;
  return webSessionRateKey(request);
}
