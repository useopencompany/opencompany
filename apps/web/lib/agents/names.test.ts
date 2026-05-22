import { describe, expect, test } from "vitest";
import { DEFAULT_AGENT_NAMES, randomAgentName } from "./names";

describe("agent names", () => {
  test("picks a name from the default rotation", () => {
    expect(DEFAULT_AGENT_NAMES).toContain(randomAgentName(() => 0));
    expect(DEFAULT_AGENT_NAMES).toContain(randomAgentName(() => 0.999));
  });

  test("includes short human and agent-sounding names", () => {
    expect(DEFAULT_AGENT_NAMES).toContain("leo");
    expect(DEFAULT_AGENT_NAMES).toContain("hermes");
  });
});
