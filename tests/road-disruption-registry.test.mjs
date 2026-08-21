import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists, verifies and resolves road disruptions with owner and revision guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianxun-road-registry-"));
  process.env.TIANXUN_SQLITE_PATH = join(directory, "operational.sqlite");
  try {
    const { listRoadDisruptions, transitionRoadDisruption, upsertRoadDisruptionReports } = await import(new URL("../db/operational.ts", import.meta.url));
    const now = new Date();
    const report = {
      disruptionId: "road-11111111-1111-4111-8111-111111111111",
      label: "测试桥梁中断",
      kind: "bridge_failure",
      impact: "blocked",
      verification: "verified",
      affectedModes: ["driving", "walking", "bicycling", "electrobike"],
      geometry: { type: "Point", coordinates: [120.3, 31.5] },
      radiusMeters: 80,
      validFrom: now.toISOString(),
      validTo: new Date(now.getTime() + 86_400_000).toISOString(),
      validityBasis: "reported",
      source: "test field report",
      importedAt: now.toISOString(),
    };

    const [saved] = await upsertRoadDisruptionReports([report], "alice");
    assert.equal(saved.verification, "reported", "a report cannot self-verify");
    assert.equal(saved.lifecycleStatus, "active");
    assert.equal(saved.revision, 1);
    assert.equal((await listRoadDisruptions()).length, 1);
    await assert.rejects(() => transitionRoadDisruption(saved.disruptionId, 1, "verify", "alice", false), /只有管理员/);

    const verified = await transitionRoadDisruption(saved.disruptionId, 1, "verify", "review-admin", true);
    assert.equal(verified.verification, "verified");
    assert.equal(verified.revision, 2);
    assert.equal(verified.verifiedBy, "review-admin");
    await assert.rejects(() => transitionRoadDisruption(saved.disruptionId, 1, "resolve", "review-admin", true), /版本冲突/);
    await assert.rejects(() => upsertRoadDisruptionReports([report], "bob"), /不属于当前操作员/);

    const resolved = await transitionRoadDisruption(saved.disruptionId, 2, "resolve", "review-admin", true);
    assert.equal(resolved.lifecycleStatus, "resolved");
    assert.equal((await listRoadDisruptions()).length, 0);
    const auditView = await listRoadDisruptions({ includeInactive: true });
    assert.equal(auditView.length, 1);
    assert.equal(auditView[0].revision, 3);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (error?.code !== "EBUSY") throw error;
    });
  }
});
