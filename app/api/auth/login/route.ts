import { ApiInputError, enforceRateLimit, readJsonObject, rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { alternateExpiredLoginCookie, createWebSession, loginCookie, secureLoginTransportRequired, verifyWebCredentials, webAuthConfiguration } from "../../../../lib/web-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  if (secureLoginTransportRequired(request)) {
    return Response.json({ error: "生产环境登录仅允许通过 HTTPS 访问" }, { status: 426, headers: { "Cache-Control": "no-store" } });
  }
  const configuration = webAuthConfiguration();
  if (!configuration.configured) {
    return Response.json({ error: "登录服务尚未配置，请由管理员设置登录账号和密码哈希" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const body = await readJsonObject(request, 4 * 1024);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    // The trusted reverse proxy contributes the client IP to the rate key;
    // including the bounded username prevents one anonymous bucket from
    // locking every account when the application is run without that proxy.
    const limited = enforceRateLimit(request, `web-login:${username.slice(0, 120).toLocaleLowerCase() || "blank"}`, 5, 15 * 60_000);
    if (limited) return limited;
    const valid = username.length <= 120 && password.length <= 128 && await verifyWebCredentials(username, password);
    if (!valid) {
      return Response.json({ error: "用户名或密码错误" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const session = await createWebSession(configuration.username, configuration.role);
    const headers = new Headers({ "Cache-Control": "no-store" });
    headers.append("Set-Cookie", loginCookie(request, session.token, session.expiresAt));
    headers.append("Set-Cookie", alternateExpiredLoginCookie(request));
    return Response.json({ authenticated: true, user: { username: configuration.username, role: configuration.role }, expiresAt: session.expiresAt.toISOString() }, { headers });
  } catch (error) {
    if (error instanceof ApiInputError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    console.error("web login unavailable", error);
    return Response.json({ error: "登录服务暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
