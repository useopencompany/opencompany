import assert from "node:assert/strict";
import test from "node:test";

import { expectedReleaseFor } from "./release-smoke.mjs";

test("uses a surface-specific expected release", () => {
  assert.equal(
    expectedReleaseFor("goat", {
      EXPECTED_RELEASE: "fallback",
      EXPECTED_GOAT_RELEASE: "goat-sha",
    }),
    "goat-sha",
  );
});

test("an explicit empty surface release disables the global fallback", () => {
  assert.equal(
    expectedReleaseFor("web", {
      EXPECTED_RELEASE: "fallback",
      EXPECTED_WEB_RELEASE: "",
    }),
    "",
  );
});

test("preserves the global expected release for existing callers", () => {
  assert.equal(expectedReleaseFor("runner", { EXPECTED_RELEASE: "legacy-sha" }), "legacy-sha");
});

test("rejects unknown smoke-check surfaces", () => {
  assert.throws(() => expectedReleaseFor("marketing", {}), /Unknown smoke-check surface/);
});
