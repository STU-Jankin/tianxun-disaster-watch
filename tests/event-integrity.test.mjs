import assert from "node:assert/strict";
import test from "node:test";

import {
  aoiFingerprint,
  eventHasInvalidIdentity,
  firstValidSourceEventId,
  geometryEquals,
  isValidSourceEventId,
} from "../lib/event-integrity.ts";
import { classifyScope } from "../lib/disasters.ts";
import { floodProcessEntityKey, sameFloodRegion } from "../lib/process-identity.ts";

test("rejects placeholder source identities and falls back to a valid feature id", () => {
  assert.equal(isValidSourceEventId("eonet-undefined"), false);
  assert.equal(isValidSourceEventId("null"), false);
  assert.equal(firstValidSourceEventId("undefined", "EONET_1234"), "EONET_1234");
  assert.equal(firstValidSourceEventId(undefined, null, "unknown"), null);
});

test("quarantines a canonical event when any evidence identity is invalid", () => {
  const event = {
    id: "eonet-undefined",
    masterEventId: "chan-hom",
    entityKey: "chan-hom",
    evidence: [{ sourceEventId: "eonet-undefined" }],
  };
  assert.equal(eventHasInvalidIdentity(event), true);
});

test("AOI fingerprints and geometry comparisons are key-order deterministic", () => {
  const left = { type: "Point", coordinates: [120.2, 31.5] };
  const right = { coordinates: [120.2, 31.5], type: "Point" };
  assert.equal(geometryEquals(left, right), true);
  assert.equal(aoiFingerprint(left), aoiFingerprint(right));
  assert.notEqual(aoiFingerprint(left), aoiFingerprint({ type: "Point", coordinates: [120.3, 31.5] }));
});

test("priority scopes require both coordinates and administrative evidence", () => {
  assert.equal(classifyScope(31.5, 120.2, "无锡市太湖"), "wuxi");
  assert.equal(classifyScope(31.5, 120.2, "unknown location"), "global");
  assert.equal(classifyScope(35, 120, "江苏省"), "jiangsu");
  assert.equal(classifyScope(50, 120, "Mongolia"), "global");
});

test("continuing flood bulletins map to one regional process without crossing years", () => {
  const numbered = floodProcessEntityKey({ title: "太湖发生2026年第1号洪水", country: "中国 · 太湖流域", occurredAt: "2026-08-11T00:00:00Z" });
  const basin = floodProcessEntityKey({ title: "太湖流域发生流域性较大洪水", country: "中国 · 太湖流域", occurredAt: "2026-08-14T00:00:00Z" });
  const oldYear = floodProcessEntityKey({ title: "太湖发生2025年第1号洪水", country: "中国 · 太湖流域", occurredAt: "2025-08-11T00:00:00Z" });
  assert.equal(numbered, "flood:2026:taihu:1");
  assert.match(basin, /^flood:2026:taihu:bulletin-/);
  assert.equal(sameFloodRegion(numbered, basin), true);
  assert.equal(sameFloodRegion(numbered, oldYear), false);
  const canal = floodProcessEntityKey({ title: "苏南运河洪水蓝色预警", country: "中国 · 江苏省", occurredAt: "2026-07-08T00:00:00Z" });
  const river = floodProcessEntityKey({ title: "望虞河洪水蓝色预警", country: "中国 · 江苏省", occurredAt: "2026-07-08T00:00:00Z" });
  assert.equal(sameFloodRegion(canal, river), false);
});
