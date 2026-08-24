import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("hashes passwords with the configured PBKDF2 work factor and verifies generically", async () => {
  const previous = captureEnvironment();
  try {
    const auth = await import(new URL("../lib/web-auth.ts", import.meta.url));
    const password = "Tianxun-Test-Password-2026";
    const hash = await auth.hashWebPassword(password);
    assert.match(hash, /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    Object.assign(process.env, { TIANXUN_LOGIN_USERNAME: "operator", TIANXUN_LOGIN_PASSWORD_HASH: hash, TIANXUN_LOGIN_ROLE: "admin" });
    assert.equal(await auth.verifyWebCredentials("operator", password), true);
    assert.equal(await auth.verifyWebCredentials("operator", "incorrect-password"), false);
    assert.equal(await auth.verifyWebCredentials("unknown-user", password), false);
  } finally {
    restoreEnvironment(previous);
  }
});

test("stores only opaque server sessions, rejects tampering and revokes logout", async () => {
  const previous = captureEnvironment();
  const directory = await mkdtemp(join(tmpdir(), "tianxun-auth-"));
  try {
    Object.assign(process.env, {
      TIANXUN_SQLITE_PATH: join(directory, "auth.sqlite"),
      TIANXUN_LOGIN_USERNAME: "admin",
      TIANXUN_LOGIN_PASSWORD_HASH: `pbkdf2-sha256$600000$${"a".repeat(32)}$${"b".repeat(64)}`,
      TIANXUN_LOGIN_ROLE: "admin",
      TIANXUN_SESSION_TTL_MINUTES: "60",
      TIANXUN_SESSION_IDLE_MINUTES: "30",
    });
    const auth = await import(new URL(`../lib/web-auth.ts?session=${Date.now()}`, import.meta.url));
    const created = await auth.createWebSession("admin", "admin");
    const cookie = auth.loginCookie(new Request("https://watch.example/api/auth/login"), created.token, created.expiresAt).split(";")[0];
    assert.match(cookie, /^__Host-tianxun_session=/);
    const request = new Request("https://watch.example/api/events", { headers: { cookie } });
    assert.deepEqual(await auth.authenticateWebRequest(request), {
      username: "admin",
      role: "admin",
      createdAt: (await auth.authenticateWebRequest(request)).createdAt,
      expiresAt: created.expiresAt.toISOString(),
    });
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    assert.equal(await auth.authenticateWebRequest(new Request("https://watch.example/api/events", { headers: { cookie: tampered } })), null);
    await auth.revokeWebSession(request);
    assert.equal(await auth.authenticateWebRequest(new Request("https://watch.example/api/events", { headers: { cookie } })), null);
    assert.equal(auth.secureLoginTransportRequired(new Request("http://watch.example/api/auth/login")), process.env.NODE_ENV === "production");
  } finally {
    restoreEnvironment(previous);
  }
});

function captureEnvironment() {
  return Object.fromEntries(["TIANXUN_SQLITE_PATH", "TIANXUN_LOGIN_USERNAME", "TIANXUN_LOGIN_PASSWORD_HASH", "TIANXUN_LOGIN_ROLE", "TIANXUN_SESSION_TTL_MINUTES", "TIANXUN_SESSION_IDLE_MINUTES"].map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
