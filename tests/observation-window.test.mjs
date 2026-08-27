import assert from "node:assert/strict";
import test from "node:test";

async function disasters() {
  return import(new URL("../lib/disasters.ts", import.meta.url));
}

test("forecast and warning windows obey authoritative validity instead of severity extension", async () => {
  const { getObservationTimeline } = await disasters();
  const now = Date.now();
  const issuedAt = new Date(now - 3_600_000).toISOString();
  const validFrom = new Date(now + 3_600_000).toISOString();
  const validTo = new Date(now + 13 * 3_600_000).toISOString();
  const red = getObservationTimeline(validFrom, issuedAt, "cyclone", "red", { phenomenonStage: "forecast", issuedAt, validFrom, validTo });
  const blue = getObservationTimeline(validFrom, issuedAt, "cyclone", "blue", { phenomenonStage: "forecast", issuedAt, validFrom, validTo });
  assert.equal(red.phase, "forecast");
  assert.equal(red.expiresAt, validTo);
  assert.equal(red.expiresAt, blue.expiresAt, "severity must not extend an official forecast bulletin");
});

test("observed hazards use hazard-specific follow-up and hard-review points", async () => {
  const { getObservationTimeline } = await disasters();
  const occurredAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const earthquake = getObservationTimeline(occurredAt, occurredAt, "earthquake", "yellow", { phenomenonStage: "observed", targets: ["形变"], sensors: ["SAR"] });
  const dust = getObservationTimeline(occurredAt, occurredAt, "dust", "yellow", { phenomenonStage: "observed", targets: ["移动方向"], sensors: ["宽幅多光谱"] });
  assert.ok(earthquake.followupHours > dust.followupHours);
  assert.ok(Date.parse(earthquake.hardReviewAt) > Date.parse(earthquake.reviewAt));
  assert.match(earthquake.rationale, /长期变化目标/);
});

test("debris-flow observations use a shorter emergency window than slow landslide follow-up", async () => {
  const { getObservationTimeline } = await disasters();
  const occurredAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const debrisFlow = getObservationTimeline(occurredAt, occurredAt, "landslide", "orange", {
    phenomenonStage: "observed",
    hazardSubtype: "debris_flow",
    targets: ["冲淤范围", "道路桥梁损毁"],
    sensors: ["SAR"],
  });
  const landslide = getObservationTimeline(occurredAt, occurredAt, "landslide", "orange", {
    phenomenonStage: "observed",
    hazardSubtype: "landslide",
    targets: ["滑坡斑块", "残余形变"],
    sensors: ["SAR"],
  });
  assert.equal(debrisFlow.goldenHours, 24);
  assert.equal(landslide.goldenHours, 72);
  assert.ok(debrisFlow.followupHours < landslide.followupHours);
  assert.match(debrisFlow.rationale, /泥石流冲淤/);
});

test("future forecasts cannot receive the observed-event maximum recency score", async () => {
  const { calculateTimeScore } = await disasters();
  const future = new Date(Date.now() + 72 * 3_600_000).toISOString();
  const issued = new Date(Date.now() - 3_600_000).toISOString();
  const score = calculateTimeScore(future, { phenomenonStage: "forecast", issuedAt: issued, validFrom: future });
  assert.ok(score >= 0 && score <= 15);
  assert.equal(calculateTimeScore(future, { phenomenonStage: "observed" }), 0);
});
