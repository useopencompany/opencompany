import { describe, expect, it } from "vitest";
import { GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA } from "@/lib/brain-surface";
import { buildGoatSlackBotToolSchema, GOAT_SLACK_BOT_MODEL } from "./agent";

const BRAIN_A = { brainRef: "brain_a", brainName: "Product" };
const BRAIN_B = { brainRef: "brain_b", brainName: "Customers" };

it("uses the cost-efficient Kimi model", () => {
  expect(GOAT_SLACK_BOT_MODEL).toBe("moonshotai/kimi-k2.6");
});

describe("buildGoatSlackBotToolSchema", () => {
  it("uses the shared read-tool schema unchanged for a single brain", () => {
    expect(buildGoatSlackBotToolSchema([BRAIN_A])).toBe(GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA);
  });

  it("adds a required brain enum when multiple brains match", () => {
    const schema = buildGoatSlackBotToolSchema([BRAIN_A, BRAIN_B]) as {
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
    buildGoatSlackBotToolSchema([BRAIN_A, BRAIN_B]);
    expect(JSON.stringify(GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA)).toBe(before);
  });
});
