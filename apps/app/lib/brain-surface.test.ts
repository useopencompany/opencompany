import { describe, expect, it } from "vitest";
import {
  BRAIN_READ_COMMANDS,
  BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  buildBrainMultiBrainToolSchema,
  normalizeBrainReadToolInput,
} from "@/lib/brain-surface";

describe("Brain read surface", () => {
  it("keeps the shared tool schema aligned with the read command list", () => {
    expect(BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties.command.enum).toEqual([
      ...BRAIN_READ_COMMANDS,
    ]);
    expect(BRAIN_READ_COMMANDS).toEqual(["help", "list", "get", "timeline", "query", "doctor"]);
  });

  it("normalizes read command flags without accepting write commands", () => {
    expect(
      normalizeBrainReadToolInput({
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
      normalizeBrainReadToolInput({ command: "create", flags: { title: "Acme" } }),
    ).toThrow("goat_brain command is invalid");
  });

  it("advertises page defaults and query continuation flags to models", () => {
    const flags = BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties.flags;
    expect(flags.properties.kind).toMatchObject({
      enum: ["page", "evidence"],
      description: expect.stringContaining('defaults to "page"'),
    });
    expect(flags.properties.offset).toMatchObject({
      type: "integer",
      minimum: 0,
      description: expect.stringContaining("pagination.nextOffset"),
    });
    expect(flags.description).toContain("pagination");
  });
});

describe("buildBrainMultiBrainToolSchema", () => {
  const BRAIN_A = { brainRef: "brain_a", brainName: "Product" };
  const BRAIN_B = { brainRef: "brain_b", brainName: "Customers" };

  it("uses the shared read-tool schema unchanged for a single brain", () => {
    expect(buildBrainMultiBrainToolSchema([BRAIN_A])).toBe(BRAIN_READ_TOOL_INPUT_JSON_SCHEMA);
  });

  it("adds a required brain enum when multiple brains match", () => {
    const schema = buildBrainMultiBrainToolSchema([BRAIN_A, BRAIN_B]) as {
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
    const before = JSON.stringify(BRAIN_READ_TOOL_INPUT_JSON_SCHEMA);
    buildBrainMultiBrainToolSchema([BRAIN_A, BRAIN_B]);
    expect(JSON.stringify(BRAIN_READ_TOOL_INPUT_JSON_SCHEMA)).toBe(before);
  });
});
