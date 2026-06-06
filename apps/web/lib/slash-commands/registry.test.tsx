import { Sparkles } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import {
  matchSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "@/lib/slash-commands/registry";

// These dependencies are stubbed only to satisfy imports used by registry command definitions.
vi.mock("@/lib/agent-sessions/actions", () => ({
  createAgentSession: vi.fn(),
  createAgentSessionFromPrompt: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

describe("parseSlashCommand", () => {
  it("parses a command at the start of the trimmed input", () => {
    const parsed = parseSlashCommand("  /clear start fresh  ");

    expect(parsed?.command.id).toBe("clear");
    expect(parsed?.args).toBe("start fresh");
  });

  it("ignores incidental slash tokens later in the message", () => {
    expect(parseSlashCommand("the command is /clear")).toBeNull();
  });

  it("requires the command word to be a clean token", () => {
    expect(parseSlashCommand("/clear-cache")).toBeNull();
    expect(parseSlashCommand("/clearing")).toBeNull();
    expect(parseSlashCommand("/clear1")).toBeNull();
  });

  it("parses a command with no arguments", () => {
    const parsed = parseSlashCommand("  /clear  ");

    expect(parsed?.command.id).toBe("clear");
    expect(parsed?.args).toBe("");
  });

  it("returns null for invalid command names", () => {
    expect(parseSlashCommand("/notacommand")).toBeNull();
    expect(parseSlashCommand("/xyz")).toBeNull();
  });

  it("returns null for a lone slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/ ")).toBeNull();
  });

  it("handles case-insensitive command names", () => {
    const parsed = parseSlashCommand("/Clear");

    expect(parsed?.command.id).toBe("clear");
    expect(parsed?.args).toBe("");
  });

  it("handles whitespace between command and args", () => {
    expect(parseSlashCommand("/clear    extra spaces")?.args).toBe("extra spaces");
    expect(parseSlashCommand("\t/clear\twith tab\t")?.args).toBe("with tab");
  });

  it("parses /btw with and without a prompt", () => {
    expect(parseSlashCommand("  /btw  ")?.command.id).toBe("btw");
    expect(parseSlashCommand("/btw")?.args).toBe("");

    const parsed = parseSlashCommand("/btw draft the notes");
    expect(parsed?.command.id).toBe("btw");
    expect(parsed?.args).toBe("draft the notes");
  });

  it("requires /btw to be a clean token", () => {
    expect(parseSlashCommand("/btweet a thread")).toBeNull();
    expect(parseSlashCommand("/btw-now")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  it("finds /btw by id, keyword, and phrase", () => {
    for (const query of ["btw", "side", "background", "by the way"]) {
      expect(matchSlashCommands(query).some((command) => command.id === "btw")).toBe(true);
    }
  });
});

describe("with a runtime command list", () => {
  const skillCommand: SlashCommand = {
    id: "graphify",
    trigger: "/graphify",
    title: "Graphify",
    description: "Turn input into a knowledge graph",
    icon: Sparkles,
    keywords: ["skill", "Graphify"],
    run: () => {},
  };
  const combined = [...SLASH_COMMANDS, skillCommand];

  it("parses a skill command from the combined list with its args", () => {
    const parsed = parseSlashCommand("/graphify these notes", combined);
    expect(parsed?.command.id).toBe("graphify");
    expect(parsed?.args).toBe("these notes");
  });

  it("does not match a skill command absent from the default list", () => {
    expect(parseSlashCommand("/graphify these notes")).toBeNull();
  });

  it("ranks built-ins before skill commands and surfaces the skill on a prefix match", () => {
    expect(matchSlashCommands("", combined).map((c) => c.id)).toEqual(["clear", "btw", "graphify"]);
    expect(matchSlashCommands("graph", combined).map((c) => c.id)).toEqual(["graphify"]);
  });
});
