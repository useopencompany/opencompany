import { describe, expect, it, vi } from "vitest";
import {
  buildSkillSlashCommands,
  type SkillCommandSource,
  toSlashSlug,
} from "@/lib/slash-commands/skill-commands";

const reserved = new Set(["clear", "btw"]);

function source(overrides: Partial<SkillCommandSource> = {}): SkillCommandSource {
  return {
    id: "graphify",
    name: "Graphify",
    description: "Turn input into a knowledge graph",
    command: "graphify",
    ...overrides,
  };
}

describe("toSlashSlug", () => {
  it("normalizes to a slash token slug", () => {
    expect(toSlashSlug("/Graph-ify")).toBe("graph_ify");
    expect(toSlashSlug("Deep Research")).toBe("deep_research");
    expect(toSlashSlug("Deep_Research")).toBe("deep_research");
    expect(toSlashSlug("!!!")).toBe("");
  });
});

describe("buildSkillSlashCommands", () => {
  it("builds a /<command> entry with the skill's metadata", () => {
    const [command] = buildSkillSlashCommands([source()], reserved);
    expect(command).toMatchObject({
      id: "graphify",
      trigger: "/graphify",
      title: "Graphify",
      description: "Turn input into a knowledge graph",
    });
    expect(command?.keywords).toContain("skill");
  });

  it("falls back to a generic description when none is given", () => {
    const [command] = buildSkillSlashCommands([source({ description: "" })], reserved);
    expect(command?.description).toBe("Use the Graphify skill");
  });

  it("applies on select and inserts the @skill mention when run", () => {
    const insertMention = vi.fn();
    const [command] = buildSkillSlashCommands([source({ id: "abc" })], reserved);
    expect(command?.applyOnSelect).toBe(true);
    // @ts-expect-error — run only reads insertMention/args from the context here.
    command?.run({ insertMention, args: "" });
    expect(insertMention).toHaveBeenCalledWith("@skill/abc ");
  });

  it("falls back to a slug of the name when no command is declared", () => {
    const [command] = buildSkillSlashCommands(
      [source({ command: null, name: "Deep Research" })],
      reserved,
    );
    expect(command).toMatchObject({ id: "deep_research", trigger: "/deep_research" });
  });

  it("falls back to the name when the declared command is unsluggable", () => {
    const [command] = buildSkillSlashCommands(
      [source({ command: "###", name: "Deep Research" })],
      reserved,
    );
    expect(command?.trigger).toBe("/deep_research");
  });

  it("skips commands that collide with a built-in", () => {
    expect(buildSkillSlashCommands([source({ command: "clear" })], reserved)).toHaveLength(0);
  });

  it("skips a skill only when neither its command, name, nor id can be slugged", () => {
    expect(
      buildSkillSlashCommands([source({ command: "###", name: "!!!", id: "@@@" })], reserved),
    ).toHaveLength(0);
  });

  it("disambiguates duplicate skill slugs with a numeric suffix", () => {
    const commands = buildSkillSlashCommands(
      [source({ id: "a", command: "research" }), source({ id: "b", command: "research" })],
      reserved,
    );
    expect(commands.map((c) => c.id)).toEqual(["research", "research2"]);
  });
});
