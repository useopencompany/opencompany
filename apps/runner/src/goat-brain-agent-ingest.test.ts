import type { GoatBrainIngestTrace } from "@opencompany/db/goat-brain-ingest-trace";
import {
  normalizeGoatChatCapture,
  normalizeJamieMeetingCompletedWebhook,
  normalizeSlackConversationWindow,
} from "@opencompany/goat-brain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((steps: number) => ({ steps })),
  tool: vi.fn((definition: unknown) => definition),
}));
const brainFilesMock = vi.hoisted(() => ({
  materializeGoatBrainFilesToRoot: vi.fn(async () => []),
  syncGoatBrainFilesFromRoot: vi.fn(async () => ({
    upserted: 3,
    deleted: 0,
    conflicts: [] as Array<{ path: string }>,
  })),
}));
const workspacesMock = vi.hoisted(() => ({
  getDefaultGoatBrainForUser: vi.fn(async () => ({ id: "gbrain_default" })),
}));
const localBrainMock = vi.hoisted(() => ({
  writeLocalBrainFile: vi.fn(async () => undefined),
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
vi.mock("@opencompany/db/goat-brain-files", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeGoatBrainFilesToRoot: brainFilesMock.materializeGoatBrainFilesToRoot,
  syncGoatBrainFilesFromRoot: brainFilesMock.syncGoatBrainFilesFromRoot,
}));
vi.mock("@opencompany/db/goat-workspaces", () => ({
  getDefaultGoatBrainForUser: workspacesMock.getDefaultGoatBrainForUser,
}));
vi.mock("@opencompany/goat-brain/cli-bundle", () => ({
  getGoatBrainCliSource: () => "// cli bundle",
}));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./goat-brain", () => ({ writeLocalBrainFile: localBrainMock.writeLocalBrainFile }));

import {
  buildGoatChatCaptureAgentIngestPrompt,
  buildJamieMeetingAgentIngestPrompt,
  buildSlackConversationAgentIngestPrompt,
  type GoatBrainAgentCliRunner,
  runGoatChatCaptureAgentIngest,
  runJamieMeetingAgentIngest,
  runSlackConversationAgentIngest,
  validateGoatBrainAgentInvocation,
} from "./goat-brain-agent-ingest";
import { buildJamieMeetingIds } from "./goat-brain-jamie-writes";

function jamieItem() {
  return normalizeJamieMeetingCompletedWebhook(
    {
      metadata: { event: "meeting.completed", created: "2026-01-01T11:00:00.000Z" },
      data: {
        user: { id: "user_123" },
        event: {
          externalId: "calendar_event_123",
          title: "Roadmap Review",
          startTime: "2026-01-01T10:00:00.000Z",
          summary: "Discussed priorities for the next product cycle.",
          participants: [{ name: "Ada", email: "ada@example.com" }],
          actionItems: ["Share the revised roadmap"],
          transcript: [{ speakerName: "Ada", startTime: "00:00:00", text: "Transcript segment 0" }],
        },
      },
    },
    { capturedAt: "2026-01-01T11:01:00.000Z" },
  );
}

function captureItem() {
  return normalizeGoatChatCapture({
    text: "Check out https://example.com/pricing-teardown for the pricing rework.",
    title: "Pricing teardown reference",
    intent: "reference for the pricing page rework",
    chatSessionId: "goat_chat_session_1",
    userMessageId: "goat_chat_msg_1",
    draftBrainId: "pricing-teardown-reference",
    draftFolder: "inbox",
    capturedAt: "2026-07-09T10:00:00.000Z",
  });
}

function slackItem() {
  return normalizeSlackConversationWindow({
    windowId: "gslkwin_test1",
    teamId: "T012345",
    teamDomain: "acme",
    channelId: "C09ABC",
    channelName: "product",
    channelType: "channel",
    messages: [
      {
        ts: "1783950060.000100",
        userId: "U01",
        userName: "Jamie",
        text: "Where did we land on onboarding?",
      },
      {
        ts: "1783950120.000200",
        threadTs: "1783950060.000100",
        userId: "U02",
        userName: "Ada",
        text: "We decided to ship the new flow next week.",
      },
    ],
    flushedAt: "2026-07-13T10:30:00.000Z",
  });
}

type CapturedTool = {
  execute: (args: { command: string; args?: string[]; stdin?: string }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
};

function mockAgentRun(input: {
  finalText: string;
  toolInvocations?: Array<{ command: string; args?: string[]; stdin?: string }>;
}) {
  aiMock.generateText.mockImplementationOnce(
    async (options: { tools: Record<string, CapturedTool> }) => {
      for (const invocation of input.toolInvocations ?? []) {
        await options.tools.goat_brain?.execute(invocation);
      }
      return {
        text: input.finalText,
        steps: [{}, {}],
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    },
  );
}

const okCli: GoatBrainAgentCliRunner = vi.fn(async () => ({
  ok: true,
  exitCode: 0,
  stdout: "ok",
  stderr: "",
}));

function traceFromResult(result: Record<string, unknown>): GoatBrainIngestTrace {
  const trace = result.trace;
  if (!trace || typeof trace !== "object") {
    throw new Error("Expected result.trace to be present.");
  }
  return trace as GoatBrainIngestTrace;
}

beforeEach(() => {
  vi.clearAllMocks();
  brainFilesMock.materializeGoatBrainFilesToRoot.mockResolvedValue([]);
  brainFilesMock.syncGoatBrainFilesFromRoot.mockResolvedValue({
    upserted: 3,
    deleted: 0,
    conflicts: [],
  });
  workspacesMock.getDefaultGoatBrainForUser.mockResolvedValue({ id: "gbrain_default" });
});

describe("validateGoatBrainAgentInvocation", () => {
  it("rejects commands outside the ingestion agent surface", () => {
    expect(validateGoatBrainAgentInvocation({ command: "delete" })).toContain("not available");
    expect(validateGoatBrainAgentInvocation({ command: "merge" })).toContain("not available");
    expect(validateGoatBrainAgentInvocation({ command: "ingest" })).toContain("not available");
    expect(validateGoatBrainAgentInvocation({ command: "set" })).toBeNull();
  });

  it("honors a custom command allow-list", () => {
    expect(validateGoatBrainAgentInvocation({ command: "merge" }, ["query", "merge"])).toBeNull();
    expect(validateGoatBrainAgentInvocation({ command: "create" }, ["query", "merge"])).toContain(
      "not available",
    );
  });

  it("rejects --root escapes and accepts normal invocations", () => {
    expect(
      validateGoatBrainAgentInvocation({ command: "list", args: ["--root", "/etc"] }),
    ).toContain("--root");
    expect(validateGoatBrainAgentInvocation({ command: "list", args: ["--root=/etc"] })).toContain(
      "--root",
    );
    expect(
      validateGoatBrainAgentInvocation({
        command: "create",
        args: ["--type", "person", "--id", "ada", "--title", "Ada", "--truth-stdin"],
        stdin: "Ada leads GTM.",
      }),
    ).toBeNull();
  });
});

describe("buildJamieMeetingAgentIngestPrompt", () => {
  it("carries the evidence pointer, deterministic meeting id, and source content", () => {
    const item = jamieItem();
    const ids = buildJamieMeetingIds(item);
    const prompt = buildJamieMeetingAgentIngestPrompt(item, {
      ...ids,
      truncatedTranscript: false,
    });

    expect(prompt).toContain(`[[evidence:${ids.evidenceBrainId}|`);
    expect(prompt).toContain(`id "${ids.meetingBrainId}"`);
    expect(prompt).toContain("Ada (ada@example.com)");
    expect(prompt).toContain(item.sourceRef);
    expect(prompt).toContain("Transcript segment 0");
  });
});

describe("buildGoatChatCaptureAgentIngestPrompt", () => {
  it("carries the draft pointer, source ref, intent, and capture text", () => {
    const item = captureItem();
    const prompt = buildGoatChatCaptureAgentIngestPrompt(item);

    expect(prompt).toContain('"pricing-teardown-reference"');
    expect(prompt).toContain("inbox/pricing-teardown-reference.md");
    expect(prompt).toContain("goat-chat:goat_chat_msg_1");
    expect(prompt).toContain("reference for the pricing page rework");
    expect(prompt).toContain("https://example.com/pricing-teardown");
    expect(prompt).toContain("merge --from pricing-teardown-reference");
    expect(prompt).toContain("user-authored ideas and thoughts belong in Brain");
    expect(prompt).toContain("they do not get a new kind");
    expect(prompt).toContain("type concept in concepts");
    expect(prompt).toContain("file the draft in decisions with the best existing type");
    expect(prompt).toContain("type note in thoughts");
  });
});

describe("buildSlackConversationAgentIngestPrompt", () => {
  it("carries the transcript, per-message refs, permalinks, and thread markers", () => {
    const item = slackItem();
    const prompt = buildSlackConversationAgentIngestPrompt(item);

    expect(prompt).toContain("#product");
    expect(prompt).toContain(item.sourceRef);
    expect(prompt).toContain("slack:message:T012345:C09ABC:<message ts>");
    expect(prompt).toContain("https://acme.slack.com/archives/C09ABC/p");
    expect(prompt).toContain("Jamie (ts 1783950060.000100): Where did we land on onboarding?");
    expect(prompt).toContain("↳ [");
    expect(prompt).toContain("We decided to ship the new flow next week.");
  });

  it("omits the permalink hint without a team domain", () => {
    const item = normalizeSlackConversationWindow({
      windowId: "gslkwin_test2",
      teamId: "T012345",
      channelId: "D09DM",
      channelName: "Ada",
      channelType: "im",
      messages: [{ ts: "1783950060.000100", userId: "U02", text: "hi" }],
      flushedAt: "2026-07-13T10:30:00.000Z",
    });
    const prompt = buildSlackConversationAgentIngestPrompt(item);
    expect(prompt).not.toContain("permalinks");
    expect(prompt).toContain("the DM with Ada");
  });

  it("renders bounded Slack context as interpretive context", () => {
    const item = normalizeSlackConversationWindow({
      windowId: "gslkwin_test3",
      teamId: "T012345",
      teamDomain: "acme",
      channelId: "C09ABC",
      channelName: "product",
      channelType: "channel",
      messages: [{ ts: "1783950120.000200", userId: "U02", text: "Yes, let's ship that." }],
      context: {
        previousMessages: [
          {
            ts: "1783950060.000100",
            userId: "U01",
            userName: "Jamie",
            text: "Do we want to launch onboarding next week?",
          },
        ],
        threads: [
          {
            threadTs: "1783950000.000050",
            messages: [
              {
                ts: "1783950030.000080",
                threadTs: "1783950000.000050",
                userId: "U03",
                text: "Earlier thread setup.",
              },
            ],
          },
        ],
      },
      flushedAt: "2026-07-13T10:30:00.000Z",
    });

    const prompt = buildSlackConversationAgentIngestPrompt(item);

    expect(prompt).toContain("The current window is the primary ingest target");
    expect(prompt).toContain("Query the brain first");
    expect(prompt).toContain("## Prior context");
    expect(prompt).toContain("### Previous channel messages");
    expect(prompt).toContain("### Thread context for 1783950000.000050");
    expect(prompt).toContain("Do we want to launch onboarding next week?");
    expect(prompt).toContain("## Current window transcript");
    expect(prompt).toContain("Yes, let's ship that.");
  });
});

describe("runSlackConversationAgentIngest", () => {
  it("runs the ingest loop and reports window metadata", async () => {
    mockAgentRun({
      finalText: "Updated onboarding page.",
      toolInvocations: [
        { command: "timeline-add", args: ["onboarding", "--body", "Ship decision."] },
      ],
    });

    const result = await runSlackConversationAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: slackItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({
      brainRef: "gbrain_123",
      skipped: false,
      channelId: "C09ABC",
      messageCount: 2,
      windowStartTs: "1783950060.000100",
      windowEndTs: "1783950120.000200",
    });
  });

  it("treats a SKIP reply with no writes as a clean skip", async () => {
    mockAgentRun({ finalText: "SKIP" });

    const result = await runSlackConversationAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: slackItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({ skipped: true, mutations: 0 });
  });
});

describe("runGoatChatCaptureAgentIngest", () => {
  it("runs the capture curation loop and syncs the brain", async () => {
    mockAgentRun({
      finalText: "Promoted the capture into concepts/usage-based-pricing.",
      toolInvocations: [
        { command: "get", args: ["pricing-teardown-reference"] },
        {
          command: "set",
          args: ["pricing-teardown-reference", "--type", "concept", "--status", "active"],
        },
      ],
    });

    const result = await runGoatChatCaptureAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: captureItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({
      brainRef: "gbrain_123",
      skipped: false,
      toolCalls: 2,
      mutations: 1,
      draftBrainId: "pricing-teardown-reference",
      summary: "Promoted the capture into concepts/usage-based-pricing.",
      trace: {
        schemaVersion: "goat.brain_ingest_trace.v1",
        model: "anthropic/claude-sonnet-5",
        steps: 2,
        toolCallCount: 2,
        mutations: 1,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        finalText: "Promoted the capture into concepts/usage-based-pricing.",
        toolCalls: [
          expect.objectContaining({
            command: "get",
            args: ["pricing-teardown-reference"],
            status: "completed",
            mutating: false,
            stdoutPreview: "ok",
          }),
          expect.objectContaining({
            command: "set",
            args: ["pricing-teardown-reference", "--type", "concept", "--status", "active"],
            status: "completed",
            mutating: true,
            stdoutPreview: "ok",
          }),
        ],
      },
    });
    // No deterministic pre-write for captures: the inbox draft was created at
    // capture time.
    expect(localBrainMock.writeLocalBrainFile).not.toHaveBeenCalled();
    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          gateway: {
            user: expect.stringMatching(/^goat-[0-9a-f]{16}$/),
            tags: expect.arrayContaining([
              "app:goat",
              "env:test",
              "feature:brain-ingest",
              "brain:gbrain_123",
              "ingest:goat-chat:goat_chat_msg_1",
            ]),
          },
        },
      }),
    );
    expect(okCli).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["set", "pricing-teardown-reference", "--type", "concept", "--status", "active"],
        reporting: {
          user: expect.stringMatching(/^goat-[0-9a-f]{16}$/),
          tags: expect.arrayContaining([
            "app:goat",
            "env:test",
            "feature:brain-query",
            "brain:gbrain_123",
            "ingest:goat-chat:goat_chat_msg_1",
          ]),
        },
      }),
    );
  });

  it("allows merge for capture curation", async () => {
    mockAgentRun({
      finalText: "Folded the capture into the existing pricing page.",
      toolInvocations: [
        { command: "timeline-add", args: ["pricing", "--body", "New teardown reference."] },
        { command: "merge", args: ["--from", "pricing-teardown-reference", "--into", "pricing"] },
      ],
    });

    const result = await runGoatChatCaptureAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: captureItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(okCli).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ toolCalls: 2, mutations: 2 });
  });

  it("bounds trace previews for long args, stdin, output, and final text", async () => {
    const longArg = "a".repeat(500);
    const longText = "body ".repeat(500);
    const longOutput = "output ".repeat(500);
    mockAgentRun({
      finalText: "final ".repeat(500),
      toolInvocations: [
        {
          command: "rewrite",
          args: ["pricing-teardown-reference", "--truth", longArg],
          stdin: longText,
        },
      ],
    });
    const noisyCli: GoatBrainAgentCliRunner = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: longOutput,
      stderr: longOutput,
    }));

    const result = await runGoatChatCaptureAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: captureItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: noisyCli },
    );

    const resultTrace = traceFromResult(result);
    expect(resultTrace.finalText).toContain("[truncated]");
    expect(resultTrace.toolCalls[0]?.args[2]).toContain("[truncated]");
    expect(resultTrace.toolCalls[0]?.stdinPreview).toContain("[truncated]");
    expect(resultTrace.toolCalls[0]?.stdoutPreview).toContain("[truncated]");
    expect(resultTrace.toolCalls[0]?.stderrPreview).toContain("[truncated]");
  });

  it("counts folder creation as a brain mutation", async () => {
    mockAgentRun({
      finalText: "Created the launch folder.",
      toolInvocations: [{ command: "folder", args: ["create", "--path", "projects/launch"] }],
    });

    const result = await runGoatChatCaptureAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: captureItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({ toolCalls: 1, mutations: 1 });
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).toHaveBeenCalled();
  });

  it("keeps folder list read-only for no-write detection", async () => {
    mockAgentRun({
      finalText: "Listed folders.",
      toolInvocations: [{ command: "folder", args: ["list"] }],
    });

    await expect(
      runGoatChatCaptureAgentIngest(
        {
          userWorkosId: "user_123",
          brainRef: "gbrain_123",
          item: captureItem(),
          env: { vercelAiGatewayApiKey: "gw_test" },
        },
        { runCli: okCli },
      ),
    ).rejects.toThrow("finished without writing");
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).not.toHaveBeenCalled();
  });
});

describe("runJamieMeetingAgentIngest", () => {
  it("writes the evidence snapshot, runs the tool loop, and syncs the brain", async () => {
    const item = jamieItem();
    const ids = buildJamieMeetingIds(item);
    mockAgentRun({
      finalText: "Updated meeting and attendee pages.",
      toolInvocations: [
        { command: "query", args: ["Ada", "--limit", "5"] },
        {
          command: "create",
          args: ["--type", "person", "--id", "ada", "--title", "Ada", "--truth-stdin"],
          stdin: "Ada leads GTM.",
        },
      ],
    });

    const result = await runJamieMeetingAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item,
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({
      brainRef: "gbrain_123",
      skipped: false,
      toolCalls: 2,
      mutations: 1,
      upserted: 3,
      meetingBrainId: ids.meetingBrainId,
      evidenceBrainId: ids.evidenceBrainId,
      summary: "Updated meeting and attendee pages.",
    });
    expect(workspacesMock.getDefaultGoatBrainForUser).not.toHaveBeenCalled();
    expect(localBrainMock.writeLocalBrainFile).toHaveBeenCalledWith(
      expect.any(String),
      `evidence/document/${ids.evidenceBrainId}.md`,
      expect.stringContaining("Transcript segment 0"),
    );
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "gbrain_123", userWorkosId: "user_123" }),
    );
    expect(okCli).toHaveBeenCalledTimes(2);
    expect(okCli).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["create", "--type", "person", "--id", "ada", "--title", "Ada", "--truth-stdin"],
        stdin: "Ada leads GTM.",
      }),
    );
  });

  it("falls back to the user's default brain when the job has no brain ref", async () => {
    mockAgentRun({
      finalText: "Updated pages.",
      toolInvocations: [{ command: "timeline-add", args: ["ada", "--body", "Met."] }],
    });

    await runJamieMeetingAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: null,
        item: jamieItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(workspacesMock.getDefaultGoatBrainForUser).toHaveBeenCalledWith(
      "user_123",
      expect.anything(),
    );
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "gbrain_default" }),
    );
  });

  it("treats a SKIP reply without writes as a successful no-op that still syncs evidence", async () => {
    mockAgentRun({ finalText: "SKIP" });

    const result = await runJamieMeetingAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: jamieItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(result).toMatchObject({ skipped: true, mutations: 0 });
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).toHaveBeenCalledTimes(1);
  });

  it("fails when the agent neither writes nor skips so the job retries", async () => {
    mockAgentRun({
      finalText: "All done!",
      toolInvocations: [{ command: "query", args: ["Ada"] }],
    });

    await expect(
      runJamieMeetingAgentIngest(
        {
          userWorkosId: "user_123",
          brainRef: "gbrain_123",
          item: jamieItem(),
          env: { vercelAiGatewayApiKey: "gw_test" },
        },
        { runCli: okCli },
      ),
    ).rejects.toThrow(/without writing/);
    expect(brainFilesMock.syncGoatBrainFilesFromRoot).not.toHaveBeenCalled();
  });

  it("blocks disallowed tool invocations without running the CLI", async () => {
    mockAgentRun({
      finalText: "Updated pages.",
      toolInvocations: [
        { command: "delete", args: ["ada", "--force"] },
        { command: "rewrite", args: ["ada", "--truth", "Ada leads GTM."] },
      ],
    });

    const result = await runJamieMeetingAgentIngest(
      {
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        item: jamieItem(),
        env: { vercelAiGatewayApiKey: "gw_test" },
      },
      { runCli: okCli },
    );

    expect(okCli).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      toolCalls: 2,
      mutations: 1,
      trace: {
        toolCallCount: 2,
        mutations: 1,
        toolCalls: [
          expect.objectContaining({
            command: "delete",
            args: ["ada", "--force"],
            status: "blocked",
            mutating: false,
            errorPreview: expect.stringContaining("not available"),
          }),
          expect.objectContaining({
            command: "rewrite",
            status: "completed",
            mutating: true,
          }),
        ],
      },
    });
  });

  it("fails on sync conflicts so the job retries against a fresh snapshot", async () => {
    brainFilesMock.syncGoatBrainFilesFromRoot.mockResolvedValueOnce({
      upserted: 0,
      deleted: 0,
      conflicts: [{ path: "people/ada.md" }],
    });
    mockAgentRun({
      finalText: "Updated pages.",
      toolInvocations: [{ command: "rewrite", args: ["ada", "--truth", "Ada leads GTM."] }],
    });

    await expect(
      runJamieMeetingAgentIngest(
        {
          userWorkosId: "user_123",
          brainRef: "gbrain_123",
          item: jamieItem(),
          env: { vercelAiGatewayApiKey: "gw_test" },
        },
        { runCli: okCli },
      ),
    ).rejects.toThrow(/people\/ada\.md/);
  });
});
