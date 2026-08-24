import assert from "node:assert/strict";
import test from "node:test";
import { applyEventSourcePresence } from "../lib/event-presence.ts";

test("retained events lose automatic source-verified dispatch eligibility", () => {
  const event = {
    sourcePresence: "current",
    lifecycleStatus: "active",
    dispatchEligibility: "ready",
    aoiApprovalRequired: false,
  };
  assert.deepEqual(applyEventSourcePresence(event, false), {
    sourcePresence: "retained",
    lifecycleStatus: "monitoring",
    dispatchEligibility: "review_required",
    aoiApprovalRequired: true,
  });
  assert.equal(applyEventSourcePresence(event, true).dispatchEligibility, "ready");
});
