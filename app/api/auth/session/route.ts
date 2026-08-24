import { authenticateWebRequest } from "../../../../lib/web-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await authenticateWebRequest(request);
    return Response.json(session ? { authenticated: true, user: { username: session.username, role: session.role }, expiresAt: session.expiresAt } : { authenticated: false }, {
      status: session ? 200 : 401,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("web session lookup unavailable", error);
    return Response.json({ authenticated: false, error: "会话服务暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
