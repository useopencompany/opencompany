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
      capabilities: {
        personalSkillsAuthorization: PERSONAL_SKILLS_AUTHORIZATION_CAPABILITY,
        personalPluginsAuthorization: "v1",
      },
    }),
  );
  assert.throws(
    () => assertPersonalSkillsAuthorization("runner", { ok: true, capabilities: {} }),
    /runner does not advertise Personal-skill and personal-plugin authorization/u,
  );
  assert.ok(PERSONAL_SKILLS_DRAIN_MS > 300_000);
});

test("does not activate personal plugins against services that only support personal skills", () => {
  assert.throws(
    () =>
      assertPersonalSkillsAuthorization("API", {
        ok: true,
        capabilities: { personalSkillsAuthorization: "v1" },
      }),
    /personal-plugin/u,
  );
});
