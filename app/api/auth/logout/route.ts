import { rejectCrossOriginBrowserWrite } from "../../../../lib/api-security";
import { expiredLoginCookies, revokeWebSession } from "../../../../lib/web-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOrigin = rejectCrossOriginBrowserWrite(request);
  if (crossOrigin) return crossOrigin;
  try {
    await revokeWebSession(request);
  } catch (error) {
    console.error("web logout revocation unavailable", error);
    return Response.json({ error: "会话撤销失败，请稍后重试" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers({ "Cache-Control": "no-store", "Clear-Site-Data": '"cache", "storage"' });
  for (const cookie of expiredLoginCookies()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}
