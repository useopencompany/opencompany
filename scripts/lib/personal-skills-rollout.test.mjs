import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPersonalSkillsAuthorization,
  PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY,
  PERSONAL_SKILLS_DRAIN_MS,
} from "./personal-skills-rollout.mjs";

test("requires the authorization capability from both replacement services", () => {
  assert.doesNotThrow(() =>
    assertPersonalSkillsAuthorization("API", {
      ok: true,
      capabilities: { personalSkillsAuthorization: PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY },
    }),
  );
  assert.throws(
    () => assertPersonalSkillsAuthorization("runner", { ok: true, capabilities: {} }),
    /runner does not advertise Personal-skill authorization/u,
  );
  assert.ok(PERSONAL_SKILLS_DRAIN_MS > 300_000);
});
