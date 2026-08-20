import assert from "node:assert/strict";
import test from "node:test";

test("enforces API roles and ignores forged proxy identity headers", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TIANXUN_API_TOKEN: process.env.TIANXUN_API_TOKEN,
    TIANXUN_OPERATOR_TOKEN: process.env.TIANXUN_OPERATOR_TOKEN,
    TIANXUN_EXECUTOR_TOKEN: process.env.TIANXUN_EXECUTOR_TOKEN,
    TIANXUN_TRUSTED_PROXY_SECRET: process.env.TIANXUN_TRUSTED_PROXY_SECRET,
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
  });
  try {
    const { apiActor, apiRole, authorizeApiRequest } = await import(new URL("../lib/api-security.ts", import.meta.url));
    const request = (headers = {}) => new Request("https://example.test/api/tasks", { headers });
    assert.equal(apiRole(request({ authorization: `Bearer ${operator}` })), "operator");
    assert.equal(authorizeApiRequest(request({ authorization: `Bearer ${operator}` }), "operator"), null);
    assert.equal(authorizeApiRequest(request({ authorization: `Bearer ${executor}` }), "operator")?.status, 403);
    assert.equal(authorizeApiRequest(request({ authorization: `Bearer ${admin}` }), "admin"), null);

    const forged = request({ "x-tianxun-user": "victim", "x-tianxun-role": "admin" });
    assert.equal(apiRole(forged), null);
    assert.equal(apiActor(forged), "local-developer");

    const viewer = request({ "x-tianxun-proxy-secret": proxy, "x-tianxun-user": "viewer@example.test", "x-tianxun-role": "viewer" });
    assert.equal(apiRole(viewer), "viewer");
    assert.equal(apiActor(viewer), "viewer@example.test");
    assert.equal(authorizeApiRequest(viewer, "operator")?.status, 403);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
