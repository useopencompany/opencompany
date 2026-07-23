import { describe, expect, it } from "vitest";
import {
  buildGoatBrainMultiBrainToolSchema,
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

describe("buildGoatBrainMultiBrainToolSchema", () => {
  const BRAIN_A = { brainRef: "brain_a", brainName: "Product" };
  const BRAIN_B = { brainRef: "brain_b", brainName: "Customers" };

  it("uses the shared read-tool schema unchanged for a single brain", () => {
    expect(buildGoatBrainMultiBrainToolSchema([BRAIN_A])).toBe(
      GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
    );
  });

  it("adds a required brain enum when multiple brains match", () => {
    const schema = buildGoatBrainMultiBrainToolSchema([BRAIN_A, BRAIN_B]) as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(schema.required).toContain("brain");
    expect(schema.required).toContain("command");
    expect(schema.properties.brain?.enum).toEqual(["brain_a", "brain_b"]);
    expect(schema.properties.brain?.description).toContain("Product: brain_a");
    expect(schema.properties.brain?.description).toContain("Customers: brain_b");
    expect(schema.properties.command).toBeDefined();
  });

  it("does not mutate the shared base schema", () => {
    const before = JSON.stringify(GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA);
    buildGoatBrainMultiBrainToolSchema([BRAIN_A, BRAIN_B]);
    expect(JSON.stringify(GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA)).toBe(before);
  });
});
