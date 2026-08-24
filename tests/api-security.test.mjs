import assert from "node:assert/strict";
import test from "node:test";

test("enforces API roles and ignores forged proxy identity headers", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TIANXUN_API_TOKEN: process.env.TIANXUN_API_TOKEN,
    TIANXUN_OPERATOR_TOKEN: process.env.TIANXUN_OPERATOR_TOKEN,
    TIANXUN_EXECUTOR_TOKEN: process.env.TIANXUN_EXECUTOR_TOKEN,
    TIANXUN_TRUSTED_PROXY_SECRET: process.env.TIANXUN_TRUSTED_PROXY_SECRET,
    TIANXUN_LOGIN_USERNAME: process.env.TIANXUN_LOGIN_USERNAME,
    TIANXUN_LOGIN_PASSWORD_HASH: process.env.TIANXUN_LOGIN_PASSWORD_HASH,
  };
  const admin = "a".repeat(64);
  const operator = "b".repeat(64);
  const executor = "c".repeat(64);
  const proxy = "d".repeat(64);
  Object.assign(process.env, {
    NODE_ENV: "production",
    TIANXUN_API_TOKEN: admin,
    TIANXUN_OPERATOR_TOKEN: operator,
    TIANXUN_EXECUTOR_TOKEN: executor,
    TIANXUN_TRUSTED_PROXY_SECRET: proxy,
    TIANXUN_LOGIN_USERNAME: "",
    TIANXUN_LOGIN_PASSWORD_HASH: "",
  });
  try {
    const { apiActor, apiRole, authorizeApiRequest } = await import(new URL("../lib/api-security.ts", import.meta.url));
    const request = (headers = {}) => new Request("https://example.test/api/tasks", { headers });
    assert.equal(await apiRole(request({ authorization: `Bearer ${operator}` })), "operator");
    assert.equal(await authorizeApiRequest(request({ authorization: `Bearer ${operator}` }), "operator"), null);
    assert.equal((await authorizeApiRequest(request({ authorization: `Bearer ${executor}` }), "operator"))?.status, 403);
    assert.equal(await authorizeApiRequest(request({ authorization: `Bearer ${admin}` }), "admin"), null);

    const forged = request({ "x-tianxun-user": "victim", "x-tianxun-role": "admin" });
    assert.equal(await apiRole(forged), null);
    assert.equal(await apiActor(forged), "local-developer");

    const viewer = request({ "x-tianxun-proxy-secret": proxy, "x-tianxun-user": "viewer@example.test", "x-tianxun-role": "viewer" });
    assert.equal(await apiRole(viewer), "viewer");
    assert.equal(await apiActor(viewer), "viewer@example.test");
    assert.equal((await authorizeApiRequest(viewer, "operator"))?.status, 403);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("trusted proxy authentication does not bypass browser same-origin checks", async () => {
  const previousProxySecret = process.env.TIANXUN_TRUSTED_PROXY_SECRET;
  process.env.TIANXUN_TRUSTED_PROXY_SECRET = "p".repeat(64);
  try {
    const { rejectCrossOriginBrowserWrite } = await import(new URL("../lib/api-security.ts", import.meta.url));
    const crossOrigin = new Request("https://watch.example/api/tasks", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "X-Tianxun-Proxy-Secret": "p".repeat(64),
        "X-Tianxun-User": "public-203.0.113.8",
        "X-Tianxun-Role": "operator",
      },
    });
    assert.equal(rejectCrossOriginBrowserWrite(crossOrigin)?.status, 403);

    const sameOrigin = new Request("https://watch.example/api/tasks", {
      method: "POST",
      headers: {
        Origin: "https://watch.example",
        "X-Tianxun-Proxy-Secret": "p".repeat(64),
        "X-Tianxun-User": "public-203.0.113.8",
        "X-Tianxun-Role": "operator",
      },
    });
    assert.equal(rejectCrossOriginBrowserWrite(sameOrigin), null);

    const nonStandardHttpsPort = new Request("http://127.0.0.1:3000/api/tasks", {
      method: "POST",
      headers: {
        Origin: "https://67.230.184.51:8443",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "67.230.184.51:8443",
        "X-Forwarded-Port": "8443",
      },
    });
    assert.equal(rejectCrossOriginBrowserWrite(nonStandardHttpsPort), null);

    const wrongExternalPort = new Request("http://127.0.0.1:3000/api/tasks", {
      method: "POST",
      headers: {
        Origin: "https://67.230.184.51:9443",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "67.230.184.51:8443",
        "X-Forwarded-Port": "8443",
      },
    });
    assert.equal(rejectCrossOriginBrowserWrite(wrongExternalPort)?.status, 403);
  } finally {
    if (previousProxySecret === undefined) delete process.env.TIANXUN_TRUSTED_PROXY_SECRET;
    else process.env.TIANXUN_TRUSTED_PROXY_SECRET = previousProxySecret;
  }
});

test("treats configured web login as authentication and requires origin proof for cookie writes", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TIANXUN_API_TOKEN: process.env.TIANXUN_API_TOKEN,
    TIANXUN_OPERATOR_TOKEN: process.env.TIANXUN_OPERATOR_TOKEN,
    TIANXUN_EXECUTOR_TOKEN: process.env.TIANXUN_EXECUTOR_TOKEN,
    TIANXUN_TRUSTED_PROXY_SECRET: process.env.TIANXUN_TRUSTED_PROXY_SECRET,
    TIANXUN_LOGIN_USERNAME: process.env.TIANXUN_LOGIN_USERNAME,
    TIANXUN_LOGIN_PASSWORD_HASH: process.env.TIANXUN_LOGIN_PASSWORD_HASH,
    TIANXUN_LOGIN_ROLE: process.env.TIANXUN_LOGIN_ROLE,
  };
  Object.assign(process.env, {
    NODE_ENV: "production",
    TIANXUN_API_TOKEN: "",
    TIANXUN_OPERATOR_TOKEN: "",
    TIANXUN_EXECUTOR_TOKEN: "",
    TIANXUN_TRUSTED_PROXY_SECRET: "",
    TIANXUN_LOGIN_USERNAME: "admin",
    TIANXUN_LOGIN_PASSWORD_HASH: `pbkdf2-sha256$600000$${"a".repeat(32)}$${"b".repeat(64)}`,
    TIANXUN_LOGIN_ROLE: "admin",
  });
  try {
    const { authorizeApiRequest, rejectCrossOriginBrowserWrite } = await import(new URL(`../lib/api-security.ts?web=${Date.now()}`, import.meta.url));
    const anonymous = new Request("https://watch.example/api/events");
    assert.equal((await authorizeApiRequest(anonymous))?.status, 401);
    const cookieWriteWithoutOrigin = new Request("https://watch.example/api/tasks", { method: "POST", headers: { cookie: `__Host-tianxun_session=${"a".repeat(43)}` } });
    assert.equal(rejectCrossOriginBrowserWrite(cookieWriteWithoutOrigin)?.status, 403);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
