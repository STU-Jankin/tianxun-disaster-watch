import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuthenticatedApp, LoginScreen } from "./authenticated-app";
import { authenticateWebRequest, webAuthConfiguration } from "../lib/web-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "星联体·天巡灾情实时预报系统",
  description: "面向自有卫星任务规划的全球自然灾害实时发现与重点区域预警系统。",
};

export default async function Home() {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const configured = webAuthConfiguration().configured;
  let serviceUnavailable = false;
  let session = null;
  if (cookie) {
    try {
      session = await authenticateWebRequest(new Request("http://tianxun.internal/", { headers: { cookie } }));
    } catch {
      serviceUnavailable = true;
    }
  }
  return session
    ? <AuthenticatedApp user={{ username: session.username, role: session.role }} />
    : <LoginScreen configured={configured} serviceUnavailable={serviceUnavailable} />;
}
