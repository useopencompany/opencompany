import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasReadSkill, markSkillRead, resetSkillReadsForTests } from "./self-edit-gate";

const SESSION = "session-1";
const OTHER_SESSION = "session-2";
const SKILL = "agent-self-edit";

describe("self-edit gate", () => {
  beforeEach(() => resetSkillReadsForTests());
  afterEach(() => resetSkillReadsForTests());

  it("reports a skill as unread before any read", () => {
    expect(hasReadSkill(SESSION, SKILL)).toBe(false);
  });

  it("remembers a read for the same session", () => {
    markSkillRead(SESSION, SKILL);
    expect(hasReadSkill(SESSION, SKILL)).toBe(true);
  });

  it("isolates reads per session", () => {
    markSkillRead(SESSION, SKILL);
    expect(hasReadSkill(OTHER_SESSION, SKILL)).toBe(false);
  });

  it("does not clear the gate for a different skill id", () => {
    markSkillRead(SESSION, "some-other-skill");
    expect(hasReadSkill(SESSION, SKILL)).toBe(false);
  });

  it("ignores empty session or skill ids", () => {
    markSkillRead("", SKILL);
    markSkillRead(SESSION, "");
    expect(hasReadSkill(SESSION, SKILL)).toBe(false);
  });
});
