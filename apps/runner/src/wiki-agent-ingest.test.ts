import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((steps: number) => ({ steps })),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("ai", () => ({
  generateText: aiMock.generateText,
  createGateway: aiMock.createGateway,
  jsonSchema: aiMock.jsonSchema,
  stepCountIs: aiMock.stepCountIs,
  tool: aiMock.tool,
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  getBraintrustAISDK: <T>(sdk: T) => sdk,
}));

import {
  buildWikiIngestUserMessage,
  placeMovingAnthropicCacheBreakpoint,
  runWikiAgentIngest,
  WIKI_AGENT_INGEST_BUDGET_STOP_THRESHOLD_USD_MICROS,
  WIKI_AGENT_INGEST_SYSTEM_PROMPT,
  WikiAgentOutcomeError,
  WikiIngestBudgetError,
} from "./wiki-agent-ingest";

const occurredAt = new Date("2026-08-24T10:00:00.000Z");
const normalizedPayload = {
  sourceProvider: "jamie",
  sourceType: "meeting",
  externalId: "meeting_123",
  sourceRef: "jamie:meeting:meeting_123",
  title: "Roadmap review",
  occurredAt: occurredAt.toISOString(),
  capturedAt: "2026-08-24T11:00:00.000Z",
  contentHash: "hash_123",
  content: { summary: "The team selected option A." },
};

function input(
  executeCommand: NonNullable<Parameters<typeof runWikiAgentIngest>[0]["executeCommand"]>,
) {
  return {
    jobId: "gwjob_123",
    attempt: 1,
    workspaceId: "workspace_123",
    actorUserWorkosId: "user_123",
    sourceProvider: "jamie" as const,
    sourceType: "meeting" as const,
    sourceRef: "jamie:meeting:meeting_123",
    title: "Roadmap review",
    occurredAt,
    contentHash: "hash_123",
    normalizedPayload,
    env: {
      apiOrigin: "http://api.local",
      apiInternalToken: "internal-token",
      vercelAiGatewayApiKey: "gateway-key",
    },
    executeCommand,
  };
}

function usage(inputTokens = 100, outputTokens = 20) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

function generate(input: {
  text: string;
  toolInput?: Record<string, unknown>;
  stepUsage?: ReturnType<typeof usage>;
}) {
  aiMock.generateText.mockImplementationOnce(async (options: any) => {
    if (input.toolInput) await options.tools.wiki.execute(input.toolInput);
    const stepUsage = input.stepUsage ?? usage();
    await options.onStepFinish({ usage: stepUsage });
    return {
      text: input.text,
      steps: [{}],
      totalUsage: stepUsage,
    };
  });
}

describe("opencompany wiki librarian agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one wiki tool and classifies a successful mutation", async () => {
    const executeCommand = vi.fn(async () => ({
      ok: true as const,
      result: { action: "created", path: "meetings/roadmap-review" },
    }));
    generate({
      text: "Added the durable roadmap decision.",
      toolInput: {
        command: "write",
        path: "meetings/roadmap-review",
        body: "# Roadmap review\n\nThe team selected option A.",
        kind: "meeting",
      },
    });

    const result = await runWikiAgentIngest(input(executeCommand));

    expect(result).toMatchObject({ skipped: false, mutations: 1, toolCalls: 1 });
    const generation = aiMock.generateText.mock.calls[0]?.[0] as any;
    expect(Object.keys(generation.tools)).toEqual(["wiki"]);
    expect(generation.messages[0].providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
    expect(generation.messages[1].providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_123",
        actorId: "user_123",
        idempotencyKey: expect.stringMatching(/^wiki_ingest:gwjob_123:1:[a-f0-9]{24}$/u),
      }),
    );
  });

  it("classifies an explicit SKIP sentinel", async () => {
    generate({ text: "SKIP: already represented accurately" });

    await expect(runWikiAgentIngest(input(vi.fn()))).resolves.toMatchObject({
      skipped: true,
      skipMode: "explicit",
      reason: "already represented accurately",
      mutations: 0,
    });
  });

  it("infers a skip when the agent makes zero mutations", async () => {
    generate({ text: "The source adds nothing durable." });

    await expect(runWikiAgentIngest(input(vi.fn()))).resolves.toMatchObject({
      skipped: true,
      skipMode: "inferred_no_mutations",
      mutations: 0,
    });
  });

  it("raises an outcome error when a mutating wiki command fails", async () => {
    const executeCommand = vi.fn(async () => ({ ok: false as const, error: "invalid path" }));
    generate({
      text: "I could not save the page.",
      toolInput: { command: "write", path: "Bad Path", body: "# Bad" },
    });

    await expect(runWikiAgentIngest(input(executeCommand))).rejects.toBeInstanceOf(
      WikiAgentOutcomeError,
    );
  });

  it("preserves a hard wiki API transport failure even if the model call returns", async () => {
    const transportError = new Error("wiki command API unavailable");
    const executeCommand = vi.fn(async () => {
      throw transportError;
    });
    aiMock.generateText.mockImplementationOnce(async (options: any) => {
      await options.tools.wiki.execute({ command: "tree" }).catch(() => undefined);
      const stepUsage = usage();
      await options.onStepFinish({ usage: stepUsage });
      return { text: "Could not inspect the wiki.", steps: [{}], totalUsage: stepUsage };
    });

    await expect(runWikiAgentIngest(input(executeCommand))).rejects.toBe(transportError);
  });

  it("raises a budget error after the soft stop without a mutation", async () => {
    generate({ text: "No write completed.", stepUsage: usage(1_000_000, 0) });

    await expect(runWikiAgentIngest(input(vi.fn()))).rejects.toMatchObject({
      name: "WikiIngestBudgetError",
      result: {
        budget: {
          exhausted: true,
          totalCostUsdMicros: expect.any(Number),
        },
      },
    });
    expect(WIKI_AGENT_INGEST_BUDGET_STOP_THRESHOLD_USD_MICROS).toBe(900_000);
  });

  it("builds the generic provider/type source header and five-section prompt", () => {
    const message = buildWikiIngestUserMessage(input(vi.fn()));
    expect(message).toContain("# Source context: jamie/meeting");
    expect(message).toContain("<normalized-source-payload>");
    expect(message).toContain('"contentHash": "hash_123"');
    for (const section of [
      "## 1. Librarian mission",
      "## 2. Lookup discipline",
      "## 3. Write discipline",
      "## 4. Structure discipline",
      "## 5. Skip rule",
    ]) {
      expect(WIKI_AGENT_INGEST_SYSTEM_PROMPT).toContain(section);
    }
    expect(WIKI_AGENT_INGEST_SYSTEM_PROMPT).toContain("timeline-add");
    expect(WIKI_AGENT_INGEST_SYSTEM_PROMPT).toContain("[[source:provider:id]]");
  });

  it("moves the Anthropic cache breakpoint to the newest non-static message", () => {
    const marked = placeMovingAnthropicCacheBreakpoint([
      { role: "system", content: "system" },
      { role: "user", content: "source" },
      {
        role: "assistant",
        content: "old",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "tool", content: [] },
    ] as any);

    expect(marked[2]?.providerOptions).not.toHaveProperty("anthropic");
    expect(marked[3]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});
