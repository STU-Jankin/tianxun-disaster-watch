import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { createWebSessionRecord, getWebSessionRecord, revokeWebSessionRecord } from "../db/operational.ts";

export type WebSession = {
  username: string;
  role: "viewer" | "operator" | "admin";
  createdAt: string;
  expiresAt: string;
};

const productionCookieName = "__Host-tianxun_session";
const developmentCookieName = "tianxun_session";
const passwordAlgorithm = "pbkdf2-sha256";
const minimumIterations = 600_000;
const requestSessions = new WeakMap<Request, Promise<WebSession | null>>();

export function webAuthConfiguration() {
  const username = (process.env.TIANXUN_LOGIN_USERNAME ?? "").trim();
  const passwordHash = (process.env.TIANXUN_LOGIN_PASSWORD_HASH ?? "").trim();
  const roleValue = (process.env.TIANXUN_LOGIN_ROLE ?? "admin").trim();
  const validRole = ["viewer", "operator", "admin"].includes(roleValue);
  const role = (validRole ? roleValue : "viewer") as WebSession["role"];
  return {
    username,
    passwordHash,
    role,
    configured: validRole && username.length >= 3 && username.length <= 120 && Boolean(parsePasswordHash(passwordHash)),
    absoluteTtlMinutes: boundedInteger(process.env.TIANXUN_SESSION_TTL_MINUTES, 480, 30, 1_440),
    idleTtlMinutes: boundedInteger(process.env.TIANXUN_SESSION_IDLE_MINUTES, 30, 5, 240),
  };
}

export async function verifyWebCredentials(username: string, password: string) {
  const configuration = webAuthConfiguration();
  const parsed = parsePasswordHash(configuration.passwordHash);
  if (!configuration.configured || !parsed) return false;
  const passwordBytes = Buffer.byteLength(password, "utf8");
  const boundedPassword = passwordBytes <= 512 ? password : "invalid-overlong-password";
  const actual = await derivePassword(boundedPassword, parsed.salt, parsed.iterations, parsed.digest.length);
  const usernameMatches = safeDigestEqual(username.trim(), configuration.username);
  const passwordMatches = actual.length === parsed.digest.length && timingSafeEqual(actual, parsed.digest);
  return usernameMatches && passwordMatches && passwordBytes > 0 && passwordBytes <= 512;
}

export async function hashWebPassword(password: string, iterations = minimumIterations) {
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password, "utf8") > 512) throw new Error("密码必须为 12–128 个字符且不超过 512 字节");
  const safeIterations = Math.max(minimumIterations, Math.trunc(iterations));
  const salt = randomBytes(16);
  const digest = await derivePassword(password, salt, safeIterations, 32);
  return `${passwordAlgorithm}$${safeIterations}$${salt.toString("hex")}$${digest.toString("hex")}`;
}

export async function createWebSession(username: string, role: WebSession["role"]) {
  const configuration = webAuthConfiguration();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + configuration.absoluteTtlMinutes * 60_000);
  const token = randomBytes(32).toString("base64url");
  await createWebSessionRecord({
    sessionHash: sessionTokenHash(token),
    username,
    role,
    authVersion: authenticationVersion(configuration.username, configuration.role, configuration.passwordHash),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return { token, expiresAt };
}

export async function authenticateWebRequest(request: Request): Promise<WebSession | null> {
  const cached = requestSessions.get(request);
  if (cached) return cached;
  const authentication = resolveWebSession(request);
  requestSessions.set(request, authentication);
  return authentication;
}

async function resolveWebSession(request: Request): Promise<WebSession | null> {
  const token = sessionTokenFromCookie(request.headers.get("cookie"));
  if (!token) return null;
  const configuration = webAuthConfiguration();
  if (!configuration.configured) return null;
  const idleCutoff = new Date(Date.now() - configuration.idleTtlMinutes * 60_000).toISOString();
  const record = await getWebSessionRecord(sessionTokenHash(token), idleCutoff);
  if (!record || !safeDigestEqual(record.username, configuration.username) || record.role !== configuration.role || !safeDigestEqual(record.authVersion, authenticationVersion(configuration.username, configuration.role, configuration.passwordHash))) return null;
  return { username: record.username, role: record.role, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export async function revokeWebSession(request: Request) {
  const token = sessionTokenFromCookie(request.headers.get("cookie"));
  if (token) await revokeWebSessionRecord(sessionTokenHash(token));
}

export function loginCookie(request: Request, token: string, expiresAt: Date) {
  const secure = requestIsSecure(request);
  const name = secure ? productionCookieName : developmentCookieName;
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function alternateExpiredLoginCookie(request: Request) {
  const expired = "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict";
  return requestIsSecure(request) ? `${developmentCookieName}=; ${expired}` : `${productionCookieName}=; ${expired}; Secure`;
}

export function expiredLoginCookies() {
  const expired = "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict";
  return [`${productionCookieName}=; ${expired}; Secure`, `${developmentCookieName}=; ${expired}`];
}

export function requestIsSecure(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwarded ? forwarded === "https" : new URL(request.url).protocol === "https:";
}

export function secureLoginTransportRequired(request: Request) {
  const hostname = new URL(request.url).hostname;
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  return process.env.NODE_ENV === "production" && !requestIsSecure(request) && !loopback;
}

export function hasWebSessionCookie(request: Request) {
  return Boolean(sessionTokenFromCookie(request.headers.get("cookie")));
}

export function webSessionRateKey(request: Request) {
  const token = sessionTokenFromCookie(request.headers.get("cookie"));
  return token ? `session-${sessionTokenHash(token).slice(0, 24)}` : "anonymous";
}

function sessionTokenFromCookie(cookieHeader: string | null) {
  if (!cookieHeader || cookieHeader.length > 8_192) return null;
  const tokens = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    if (![productionCookieName, developmentCookieName].includes(name)) return [];
    const token = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? [token] : [];
  });
  return tokens.length === 1 ? tokens[0] : null;
}

function parsePasswordHash(value: string) {
  const [algorithm, iterationsText, saltText, digestText, extra] = value.split("$");
  const iterations = Number(iterationsText);
  if (extra !== undefined || algorithm !== passwordAlgorithm || !Number.isInteger(iterations) || iterations < minimumIterations || iterations > 5_000_000) return null;
  if (!/^[a-f0-9]{32,128}$/i.test(saltText ?? "") || !/^[a-f0-9]{64,128}$/i.test(digestText ?? "")) return null;
  return { iterations, salt: Buffer.from(saltText, "hex"), digest: Buffer.from(digestText, "hex") };
}

function derivePassword(password: string, salt: Buffer, iterations: number, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    pbkdf2(password, salt, iterations, length, "sha256", (error, derived) => error ? reject(error) : resolve(derived));
  });
}

function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function authenticationVersion(username: string, role: string, passwordHash: string) {
  return createHash("sha256").update(`${username}\u0000${role}\u0000${passwordHash}`, "utf8").digest("hex");
}

function safeDigestEqual(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
