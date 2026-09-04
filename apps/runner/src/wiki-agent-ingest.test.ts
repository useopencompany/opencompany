import { normalizeGmailThreadWindow } from "@opencompany/brain";
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
  buildCompanyImportSourceContextHeader,
  buildGmailSourceContextHeader,
  buildLinearSourceContextHeader,
  buildMeetingSourceContextHeader,
  buildWikiIngestUserMessage,
  buildWikiSourceContextHeader,
  runWikiAgentIngest,
  WIKI_AGENT_INGEST_BUDGET_STOP_THRESHOLD_USD_MICROS,
  WIKI_AGENT_INGEST_MODEL,
  WIKI_AGENT_INGEST_SYSTEM_PROMPT,
  WikiAgentOutcomeError,
  WikiIngestBudgetError,
} from "./wiki-agent-ingest";

const occurredAt = new Date("2026-08-24T10:00:00.000Z");
const normalizedPayload = {
  sourceProvider: "granola",
  sourceType: "meeting",
  externalId: "meeting_123",
  sourceRef: "granola:meeting:meeting_123",
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
    sourceProvider: "granola" as const,
    sourceType: "meeting" as const,
    sourceRef: "granola:meeting:meeting_123",
    title: "Roadmap review",
    occurredAt,
    contentHash: "hash_123",
    normalizedPayload,
    sourceConfig: {},
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
  stepCount?: number;
}) {
  aiMock.generateText.mockImplementationOnce(async (options: any) => {
    if (input.toolInput) await options.tools.wiki.execute(input.toolInput);
    const stepUsage = input.stepUsage ?? usage();
    const stepCount = input.stepCount ?? 1;
    for (let step = 0; step < stepCount; step += 1) {
      await options.onStepFinish({ usage: stepUsage });
    }
    return {
      text: input.text,
      steps: Array.from({ length: stepCount }, () => ({})),
      totalUsage: usage(stepUsage.inputTokens * stepCount, stepUsage.outputTokens * stepCount),
    };
  });
}

function triageResult(
  decision: "skip" | "ingest",
  overrides: Partial<{
    reason: string;
    entityHints: string[];
  }> = {},
) {
  return {
    model: WIKI_AGENT_INGEST_MODEL,
    decision,
    reason: overrides.reason ?? (decision === "skip" ? "obvious chatter" : "durable decision"),
    entityHints: overrides.entityHints ?? (decision === "skip" ? [] : ["Acme API", "Billing"]),
    usage: {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
    modelCostUsdMicros: 25,
  } as const;
}

function companyImportInput(
  executeCommand: NonNullable<Parameters<typeof runWikiAgentIngest>[0]["executeCommand"]>,
) {
  return {
    ...input(executeCommand),
    sourceProvider: "opencompany-import" as const,
    sourceType: "run" as const,
    sourceRef: "opencompany-import:run:gbimp_1:research",
    title: "Acme context import",
    contentHash: "hash_import",
    normalizedPayload: {
      sourceProvider: "opencompany-import",
      sourceType: "run",
      externalId: "gbimp_1:research",
      sourceRef: "opencompany-import:run:gbimp_1:research",
      title: "Acme context import",
      occurredAt: occurredAt.toISOString(),
      capturedAt: occurredAt.toISOString(),
      contentHash: "hash_import",
      content: {
        phase: "research",
        importRunId: "gbimp_1",
        companyUrl: "https://acme.example",
        companyDomain: "acme.example",
        searches: [],
        results: [],
      },
    },
  };
}

describe("opencompany wiki librarian agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes company-import pages through the API command boundary as the acting user", async () => {
    const executeCommand = vi.fn(async () => ({
      ok: true as const,
      result: { action: "created", path: "companies/acme" },
    }));
    generate({
      text: "Created the company profile.",
      toolInput: {
        command: "write",
        path: "companies/acme",
        title: "Acme",
        kind: "company",
        body: "# Acme",
      },
    });

    await expect(runWikiAgentIngest(companyImportInput(executeCommand))).resolves.toMatchObject({
      mutations: 1,
      skipped: false,
    });
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_123",
        actorId: "user_123",
        toolInput: expect.objectContaining({ command: "write", kind: "company" }),
      }),
    );
  });

  it("rejects company-import writes with a non-company/person kind before the API call", async () => {
    const executeCommand = vi.fn();
    generate({
      text: "Could not create the page.",
      toolInput: {
        command: "write",
        path: "research/acme",
        title: "Acme",
        kind: "research",
        body: "# Acme",
      },
    });

    await expect(runWikiAgentIngest(companyImportInput(executeCommand))).rejects.toBeInstanceOf(
      WikiAgentOutcomeError,
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("gives company imports explicit company/person kind guidance", () => {
    expect(
      buildCompanyImportSourceContextHeader({
        sourceProvider: "opencompany-import",
        sourceType: "run",
        sourceRef: "opencompany-import:run:gbimp_1:research",
        title: "Acme context import",
        occurredAt,
        sourceConfig: {},
      }),
    ).toContain("kind `company`");
    expect(
      buildCompanyImportSourceContextHeader({
        sourceProvider: "opencompany-import",
        sourceType: "run",
        sourceRef: "opencompany-import:run:gbimp_1:candidate:gmail:gbimpc_1",
        title: "Acme customer context",
        occurredAt,
        sourceConfig: {},
      }),
    ).toContain("supplied company context");
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

    expect(result).toMatchObject({
      model: WIKI_AGENT_INGEST_MODEL,
      skipped: false,
      mutations: 1,
      toolCalls: 1,
      pages: [{ path: "meetings/roadmap-review", title: "Roadmap Review", action: "created" }],
    });
    const generation = aiMock.generateText.mock.calls[0]?.[0] as any;
    expect(generation.model).toEqual({ model: WIKI_AGENT_INGEST_MODEL });
    expect(Object.keys(generation.tools)).toEqual(["wiki"]);
    expect(generation.providerOptions.gateway.caching).toBe("auto");
    expect(generation.system).toBe(WIKI_AGENT_INGEST_SYSTEM_PROMPT);
    expect(generation.messages).toEqual([
      expect.objectContaining({ role: "user", content: expect.any(String) }),
    ]);
    expect(generation.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ providerOptions: expect.anything() })]),
    );
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
    generate({ text: "No write completed.", stepUsage: usage(1_000_000, 0), stepCount: 7 });

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

  it("builds the registered Granola meeting header and five-section prompt", () => {
    const message = buildWikiIngestUserMessage(input(vi.fn()));
    expect(message).toContain("# Source context: granola/meeting");
    expect(message).toContain("title, date and time, attendees, provider summary, and transcript");
    expect(message).toContain("decisions, project state, commitments, and people or company facts");
    expect(message).toContain("at most a timeline-add");
    expect(message).toContain("do NOT copy the full transcript");
    expect(message).toContain("[[source:granola:meeting:meeting_123]]");
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

  it("routes Granola through the meeting header registry", () => {
    const granolaHeader = buildWikiSourceContextHeader({
      sourceProvider: "granola",
      sourceType: "meeting",
      sourceRef: "granola:note:note_123",
      title: "Roadmap review",
      occurredAt,
      sourceConfig: {},
    });
    const directHeader = buildMeetingSourceContextHeader({
      sourceProvider: "granola",
      sourceType: "meeting",
      sourceRef: "granola:note:note_123",
      title: "Roadmap review",
      occurredAt,
      sourceConfig: {},
    });

    expect(granolaHeader).toBe(directHeader);
    expect(granolaHeader).toContain("# Source context: granola/meeting");
    expect(granolaHeader).toContain("[[source:granola:note:note_123]]");
    expect(granolaHeader).toContain("not a standalone transcript archive");
  });

  it("builds Gmail guidance with job-scoped source references", () => {
    const gmailHeader = buildGmailSourceContextHeader({
      sourceProvider: "gmail",
      sourceType: "thread",
      sourceRef: "gmail:thread:thread_123",
      title: "Acme renewal",
      occurredAt,
      sourceConfig: {
        instructions: "Only capture customer commitments.",
      },
    });

    expect(gmailHeader).toContain("sender and thread context");
    expect(gmailHeader).toContain("facts about external contacts");
    expect(gmailHeader).toContain("Trusted source guidance: Only capture customer commitments.");
    expect(gmailHeader).toContain("[[source:gmail:thread:thread_123]]");
  });

  it("registers the Linear header with external-source pointer discipline", () => {
    const linearInput = {
      sourceProvider: "linear" as const,
      sourceType: "issue" as const,
      sourceRef: "linear:acme:ENG-42",
      title: "Ship billing retries",
      occurredAt,
      sourceConfig: {},
    };
    const linearHeader = buildWikiSourceContextHeader(linearInput);
    expect(linearHeader).toBe(buildLinearSourceContextHeader(linearInput));
    expect(linearHeader).toContain("timeline-add entries or brief page updates");
    expect(linearHeader).toContain("[[source:linear:acme:ENG-42]]");
    expect(linearHeader).toContain("never mirror an issue body");
  });

  it("short-circuits a Gmail job when cheap triage returns skip", async () => {
    const runTriage = vi.fn(async () => triageResult("skip"));

    await expect(runWikiAgentIngest(gmailInput(vi.fn()), { runTriage })).resolves.toMatchObject({
      model: WIKI_AGENT_INGEST_MODEL,
      skipped: true,
      skipMode: "triage",
      reason: "obvious chatter",
      steps: 1,
      toolCalls: 0,
      mutations: 0,
      trace: {
        triage: { decision: "skip" },
      },
    });
    expect(aiMock.generateText).not.toHaveBeenCalled();
  });

  it("passes triage entity hints into the full Gmail librarian message", async () => {
    generate({ text: "SKIP: already captured" });

    await runWikiAgentIngest(gmailInput(vi.fn()), {
      runTriage: vi.fn(async () => triageResult("ingest", { entityHints: ["Acme", "Onboarding"] })),
    });

    const generation = aiMock.generateText.mock.calls[0]?.[0] as any;
    expect(generation.messages[0].content).toContain("## Cheap triage handoff");
    expect(generation.messages[0].content).toContain("- Acme\n- Onboarding");
  });

  it("falls through to full wiki ingest when cheap triage fails", async () => {
    generate({ text: "SKIP: nothing durable" });

    await expect(
      runWikiAgentIngest(gmailInput(vi.fn()), {
        runTriage: vi.fn(async () => {
          throw new Error("triage provider unavailable");
        }),
      }),
    ).resolves.toMatchObject({ skipped: true, skipMode: "explicit" });
    expect(aiMock.generateText).toHaveBeenCalledOnce();
  });
});

function gmailInput(
  executeCommand: NonNullable<Parameters<typeof runWikiAgentIngest>[0]["executeCommand"]>,
) {
  const item = normalizeGmailThreadWindow({
    windowId: "ggmwin_123",
    threadId: "thread_123",
    subject: "Acme onboarding",
    messages: [
      {
        messageId: "message_123",
        direction: "received",
        from: "ada@acme.example",
        sentAt: occurredAt.toISOString(),
        bodyText: "Acme approved the onboarding plan.",
      },
    ],
    flushedAt: occurredAt.toISOString(),
  });
  return {
    ...input(executeCommand),
    sourceProvider: "gmail" as const,
    sourceType: "thread" as const,
    sourceRef: item.sourceRef,
    title: item.title,
    contentHash: item.contentHash,
    normalizedPayload: item,
  };
}
