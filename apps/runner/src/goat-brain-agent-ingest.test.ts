import {
  normalizeGoatChatCapture,
  normalizeJamieMeetingCompletedWebhook,
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
  type GoatBrainAgentCliRunner,
  runGoatChatCaptureAgentIngest,
  runJamieMeetingAgentIngest,
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
    });
    // No deterministic pre-write for captures: the inbox draft was created at
    // capture time.
    expect(localBrainMock.writeLocalBrainFile).not.toHaveBeenCalled();
    expect(okCli).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["set", "pricing-teardown-reference", "--type", "concept", "--status", "active"],
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
    expect(result).toMatchObject({ toolCalls: 2, mutations: 1 });
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
