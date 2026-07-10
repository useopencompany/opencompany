import { describe, expect, it } from "vitest";
import {
  GOAT_BRAIN_READ_COMMANDS,
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";

describe("Goat Brain read surface", () => {
  it("keeps the shared tool schema aligned with the read command list", () => {
    expect(GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties.command.enum).toEqual([
      ...GOAT_BRAIN_READ_COMMANDS,
    ]);
    expect(GOAT_BRAIN_READ_COMMANDS).toEqual([
      "help",
      "list",
      "get",
      "timeline",
      "query",
      "doctor",
    ]);
  });

  it("normalizes read command flags without accepting write commands", () => {
    expect(
      normalizeGoatBrainReadToolInput({
        command: "query",
        flags: {
          text: " hiring ",
          since: " last 6 hours ",
          id: [" ada ", "", " acme "],
          hops: 1,
          includeMerged: true,
          ignored: null,
        },
      }),
    ).toEqual({
      command: "query",
      flags: {
        text: "hiring",
        since: "last 6 hours",
        id: ["ada", "acme"],
        hops: 1,
        includeMerged: true,
      },
    });

    expect(() =>
      normalizeGoatBrainReadToolInput({ command: "create", flags: { title: "Acme" } }),
    ).toThrow("goat_brain command is invalid");
  });
});
