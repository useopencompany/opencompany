import { describe, expect, it } from "vitest";
import { renderGoatBrainToolCommand, runGoatBrainToolForUser } from "@/lib/brain-cli";

const BASE_INPUT = {
  userWorkosId: "user_1",
  gatewayApiKey: "gateway_test",
  sourceRef: "goat-chat:user_message_1",
};

describe("runGoatBrainToolForUser", () => {
  it("does not silently ignore stdin for create truth", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            type: "company",
            json: true,
          },
          stdin: "OpenCompany is a company.",
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: [
        "create",
        "--id",
        "opencompany",
        "--title",
        "OpenCompany",
        "--type",
        "company",
        "--json",
        "--truth-stdin",
        "--folder",
        "companies",
        "--source-ref",
        "goat-chat:user_message_1",
      ],
      stdin: "OpenCompany is a company.",
    });
  });

  it("rejects create without an explicit type", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("goat_brain create requires a type.");
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('Relevant help command: { command: "help", flags: { topic: "create" } }.');
  });

  it("rejects create without compiled truth", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            type: "company",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("goat_brain create requires compiled truth");
  });

  it("rejects create when the folder does not match the type", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            folder: "inbox",
            title: "OpenCompany",
            type: "company",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('goat_brain create folder "inbox" does not match type "company"');
  });

  it("renders goat_brain help invocations", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "help",
          flags: { topic: "create" },
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: ["help", "create"],
    });
  });

  it("passes includeMerged through for list and query", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "query",
          flags: { text: "Sarah Chen", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["query", "--text", "Sarah Chen", "--include-merged", "--json"]);

    expect(
      renderGoatBrainToolCommand(
        {
          command: "list",
          flags: { folder: "people", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["list", "--folder", "people", "--include-merged", "--json"]);
  });

  it("returns a helpful error for unsupported create entity types", async () => {
    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "create",
        flags: {
          id: "jordan-lee",
          title: "Jordan Lee",
          type: "candidate",
          json: true,
        },
      },
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining(
        'Unsupported Goat Brain entity type "candidate". Use one of: person, company, project, decision, meeting, conversation, research, document, concept, reference, daily, note.',
      ),
    });
    expect(output.error).toContain('Relevant help command: { command: "help"');
  });

  it("does not expose ingest through the chat tool", async () => {
    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "ingest",
        flags: { textStdin: true, json: true },
        stdin: "Remember this.",
      } as never,
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining('Unsupported goat_brain command "ingest".'),
    });
    expect(output.error).toContain("For command-specific usage");
  });
});
