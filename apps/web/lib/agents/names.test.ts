import { describe, expect, test } from "vitest";
import { DEFAULT_AGENT_NAMES, randomAgentName } from "./names";

describe("agent names", () => {
  test("picks a name from the default rotation", () => {
    expect(DEFAULT_AGENT_NAMES).toContain(randomAgentName(() => 0));
    expect(DEFAULT_AGENT_NAMES).toContain(randomAgentName(() => 0.999));
  });

  test("maps random values across different names", () => {
    const selectedNames = new Set(
      [0, 0.24, 0.49, 0.74, 0.99].map((value) => randomAgentName(() => value)),
    );

    expect(selectedNames.size).toBeGreaterThan(1);
    expect(selectedNames).not.toEqual(new Set(["nova"]));
  });

  test("includes short human and agent-sounding names", () => {
    expect(DEFAULT_AGENT_NAMES).toContain("leo");
    expect(DEFAULT_AGENT_NAMES).toContain("hermes");
  });
});
