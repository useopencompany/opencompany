import { describe, expect, it, vi } from "vitest";
import { parseSlashCommand } from "@/lib/slash-commands/registry";

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
  });
});
