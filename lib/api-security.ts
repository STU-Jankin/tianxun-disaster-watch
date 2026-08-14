function timingSafeEqualText(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function authorizeApiRequest(request: Request) {
  const expectedToken = process.env.TIANXUN_API_TOKEN?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (expectedToken && bearer && timingSafeEqualText(bearer, expectedToken)) return null;

  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!expectedToken && local) return null;
  return Response.json({ error: "未授权访问；请使用站点身份或配置的 API Bearer Token" }, { status: 401 });
}

export function rejectCrossOriginBrowserWrite(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return null;
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
  return request.headers.get("authorization")?.startsWith("Bearer ") ? "api-token" : "local-operator";
}

export async function readJsonObject(request: Request, maximumBytes = 512 * 1024) {
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

export class ApiInputError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
