export type VisibilityServiceCapabilities = {
  schemaVersion: "tianxun.visibility.capabilities/v1";
  engines: Array<"orekit" | "basilisk" | "custom">;
  supportsMovingAoi: boolean;
  verifiedConstraints: string[];
  precisionClass: "orbit_only" | "sensor_model" | "engineering_model";
  serviceVersion: string;
};

export async function loadVisibilityServiceCapabilities(): Promise<VisibilityServiceCapabilities | null> {
  const configured = process.env.SATELLITE_VISIBILITY_CAPABILITIES_URL?.trim();
  if (!configured) return null;
  const url = safeServiceUrl(configured);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const token = process.env.MISSION_SERVICE_TOKEN?.trim();
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: controller.signal,
    redirect: "manual",
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`仿真能力接口返回 HTTP ${response.status}`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error("仿真能力响应超过安全上限");
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.schemaVersion !== "tianxun.visibility.capabilities/v1") throw new Error("仿真能力响应版本不受支持");
  const engines = Array.isArray(raw.engines) ? [...new Set(raw.engines.filter((item): item is VisibilityServiceCapabilities["engines"][number] => ["orekit", "basilisk", "custom"].includes(String(item))))] : [];
  if (!engines.length) throw new Error("仿真能力响应未声明计算引擎");
  const precisionClass = ["orbit_only", "sensor_model", "engineering_model"].includes(String(raw.precisionClass)) ? raw.precisionClass as VisibilityServiceCapabilities["precisionClass"] : null;
  if (!precisionClass) throw new Error("仿真能力响应未声明精度层级");
  const verifiedConstraints = Array.isArray(raw.verifiedConstraints) ? raw.verifiedConstraints.filter((item): item is string => typeof item === "string" && item.length <= 120).slice(0, 100) : [];
  return {
    schemaVersion: "tianxun.visibility.capabilities/v1",
    engines,
    supportsMovingAoi: raw.supportsMovingAoi === true,
    verifiedConstraints,
    precisionClass,
    serviceVersion: typeof raw.serviceVersion === "string" ? raw.serviceVersion.slice(0, 120) : "unspecified",
  };
}

function safeServiceUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("仿真能力 URL 禁止内嵌凭据");
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("仿真能力接口必须使用 HTTPS，回环地址除外");
  return url.toString();
}
