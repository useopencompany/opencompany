import type { GoatHarnessSpec, GoatTaskDebugTrace, goatTasks } from "@opencompany/db/goat-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { executeGoatTask, parseGoatHarnessOutput, planGoatHarness } from "./goat-harness";

const sandboxMocks = vi.hoisted(() => ({
  armSandboxIdleTimeout: vi.fn(async () => {}),
  createOrConnectSandbox: vi.fn(),
}));

vi.mock("./sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sandbox")>();
  return {
    ...actual,
    armSandboxIdleTimeout: sandboxMocks.armSandboxIdleTimeout,
    createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
  };
});

type GoatTask = typeof goatTasks.$inferSelect;

const harnessSpec: GoatHarnessSpec = {
  prompt: "Research Marseille",
  model: "openai/gpt-5.4-mini",
  tools: ["exa", "goat_result"],
  resultMode: "freeform",
};

const harnessDebugTrace: GoatTaskDebugTrace = {
  schemaVersion: "goat.debug.v1",
  harness: {
    model: "openai/gpt-5.4-mini",
    turns: [{ step: 0, responseMessage: { role: "assistant", content: "Done." } }],
  },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("parseGoatHarnessOutput", () => {
  it("reads the final structured result from noisy stdout", () => {
    expect(
      parseGoatHarnessOutput(
        `planning\n${JSON.stringify({
          ok: true,
          result: " finished result ",
          debugTrace: harnessDebugTrace,
        })}\n`,
      ),
    ).toEqual({
      ok: true,
      result: "finished result",
      debugTrace: harnessDebugTrace,
    });
  });

  it("returns structured harness errors", () => {
    expect(parseGoatHarnessOutput('{"ok":false,"error":"model failed"}')).toEqual({
      ok: false,
      error: "model failed",
    });
  });

  it("falls back to assistant text when no JSON envelope exists", () => {
    expect(parseGoatHarnessOutput("plain assistant answer")).toEqual({
      ok: true,
      result: "plain assistant answer",
    });
  });
});

describe("planGoatHarness", () => {
  it("constrains planner output to Goat's MVP capability set", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "trim me",
                    model: "some-other-model",
                    tools: ["shell"],
                    resultMode: "json",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      planGoatHarness({
        prompt: "User task",
        model: "openai/gpt-5.4-mini",
        availableTools: ["exa", "gmail", "google_calendar", "goat_result"],
        gatewayApiKey: "gateway",
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toEqual({
      prompt: "trim me",
      model: "openai/gpt-5.4-mini",
      tools: ["exa", "goat_result"],
      resultMode: "freeform",
    });

    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody).toMatchObject({
      model: "anthropic/claude-sonnet-4.6",
      stream: false,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "goat_harness_spec",
          strict: true,
        },
      },
    });
    expect(requestBody.response_format.json_schema.schema.required).toEqual([
      "prompt",
      "model",
      "tools",
      "resultMode",
    ]);
    expect(requestBody.response_format.json_schema.schema.properties.tools.items.enum).toEqual([
      "exa",
      "gmail",
      "google_calendar",
      "goat_result",
    ]);
    expect(requestBody.messages[0].content).toContain(
      "The available tools list is the source of truth for what the background harness can use.",
    );
    expect(requestBody.messages[0].content).toContain(
      "If the task text contains stale chat-layer limitations",
    );
  });

  it("asks the planner to use connected Gmail despite stale chat-layer access wording", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "Use Gmail to summarize the latest emails and extract action items.",
                    model: "openai/gpt-5.4-mini",
                    tools: ["gmail", "goat_result"],
                    resultMode: "freeform",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      planGoatHarness({
        prompt:
          "Summarize the user's latest emails. Since no inbox access is available in chat, ask the user to provide/export their latest emails.",
        model: "openai/gpt-5.4-mini",
        availableTools: ["exa", "gmail", "goat_result"],
        gatewayApiKey: "gateway",
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toEqual({
      prompt: "Use Gmail to summarize the latest emails and extract action items.",
      model: "openai/gpt-5.4-mini",
      tools: ["exa", "gmail", "goat_result"],
      resultMode: "freeform",
    });

    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.messages[0].content).toContain(
      'Include "gmail" when the task needs email context and Gmail is available.',
    );
    expect(requestBody.messages[0].content).toContain(
      "rewrite the prompt for the harness to use the available connected tool instead",
    );
    expect(requestBody.messages[1].content).toContain("no inbox access is available in chat");
  });

  it("surfaces gateway error messages when planning is rejected", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid response_format provided.",
              type: "invalid_request_error",
            },
          }),
          { status: 400, statusText: "Bad Request" },
        ),
    );

    await expect(
      planGoatHarness({
        prompt: "User task",
        model: "openai/gpt-5.4-mini",
        gatewayApiKey: "gateway",
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toThrow("Goat harness planning failed (400): Invalid response_format provided.");
  });

  it("keeps planned tools provider-level and drops operation-level tool names", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "Find important mail",
                    model: "openai/gpt-5.4-mini",
                    tools: ["exa_search", "gmail", "gmail_search", "google_calendar"],
                    resultMode: "freeform",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      planGoatHarness({
        prompt: "What emails are important?",
        model: "openai/gpt-5.4-mini",
        availableTools: ["exa", "gmail", "google_calendar", "goat_result"],
        gatewayApiKey: "gateway",
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toEqual({
      prompt: "Find important mail",
      model: "openai/gpt-5.4-mini",
      tools: ["exa", "gmail", "google_calendar", "goat_result"],
      resultMode: "freeform",
    });
  });
});

describe("executeGoatTask", () => {
  it("parses structured harness errors from non-zero sandbox exits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(harnessSpec) } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const commandError = Object.assign(new Error("exit status 1"), {
      name: "CommandExitError",
      result: {
        stdout: '{"ok":false,"error":"Vercel AI Gateway failed (400): bad tool"}\n',
        stderr: "sandbox stderr",
        exitCode: 1,
      },
    });
    const filesWrite = vi.fn(async () => {});
    sandboxMocks.createOrConnectSandbox.mockResolvedValue({
      sandboxId: "sbx_1",
      files: { write: filesWrite },
      commands: {
        run: vi.fn(async () => {
          throw commandError;
        }),
      },
    });

    await expect(
      executeGoatTask({
        task: goatTask(),
        env: runnerEnv(),
        signal: new AbortController().signal,
        reportStage: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(
      "Goat harness failed (exit 1): Vercel AI Gateway failed (400): bad tool\nsandbox stderr",
    );
    const [, scriptContent] = filesWrite.mock.calls[0] as unknown as [string, string];
    const script = String(scriptContent);
    expect(script).toContain("Authorization: `Bearer ${gatewayKey}`,");
    expect(script).toContain("const systemPrompt =");
    expect(script).toContain('const toolChoice = "auto";');
    expect(script).toContain("const toolsSentToModel = tools.map(sanitizeValue);");
    expect(script).toContain("systemPrompt,");
    expect(script).toContain("toolsSentToModel,");
    expect(script).toContain("toolChoice,");
    expect(script).not.toContain("\\`");
  });

  it("merges planner and harness debug traces on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(harnessSpec) } }],
            }),
            { status: 200 },
          ),
      ),
    );
    sandboxMocks.createOrConnectSandbox.mockResolvedValue({
      sandboxId: "sbx_1",
      files: { write: vi.fn(async () => {}) },
      commands: {
        run: vi.fn(async () => ({
          stdout: `${JSON.stringify({
            ok: true,
            result: "Done.",
            debugTrace: harnessDebugTrace,
          })}\n`,
          stderr: "",
          exitCode: 0,
        })),
      },
    });

    await expect(
      executeGoatTask({
        task: goatTask(),
        env: runnerEnv(),
        signal: new AbortController().signal,
        reportStage: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({
      result: "Done.",
      debugTrace: {
        schemaVersion: "goat.debug.v1",
        planner: {
          model: "anthropic/claude-sonnet-4.6",
          response: { content: JSON.stringify(harnessSpec) },
        },
        harness: harnessDebugTrace.harness,
      },
    });
  });

  it("reports streamed harness progress while the sandbox command is still running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(harnessSpec) } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const progressTrace: GoatTaskDebugTrace = {
      schemaVersion: "goat.debug.v1",
      harness: {
        model: "openai/gpt-5.4-mini",
        turns: [
          {
            step: 0,
            responseMessage: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "exa_search",
                    arguments: JSON.stringify({ query: "Marseille" }),
                  },
                },
              ],
            },
            toolResults: [],
          },
        ],
      },
    };
    const run = vi.fn(
      async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
        await options.onStdout?.(
          `__goat_harness_progress__${JSON.stringify({ debugTrace: progressTrace })}\n`,
        );
        return {
          stdout: `${JSON.stringify({
            ok: true,
            result: "Done.",
            debugTrace: harnessDebugTrace,
          })}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    );
    sandboxMocks.createOrConnectSandbox.mockResolvedValue({
      sandboxId: "sbx_1",
      files: { write: vi.fn(async () => {}) },
      commands: { run },
    });
    const reportStage = vi.fn(async () => {});

    await executeGoatTask({
      task: goatTask(),
      env: runnerEnv(),
      signal: new AbortController().signal,
      reportStage,
    });

    expect(reportStage).toHaveBeenCalledWith(
      "running",
      expect.objectContaining({
        sandboxId: "sbx_1",
        debugTrace: expect.objectContaining({
          planner: expect.any(Object),
          harness: progressTrace.harness,
        }),
      }),
    );
  });

  it("fails before sandbox execution when Google tools need a public callback URL", async () => {
    const gmailHarnessSpec: GoatHarnessSpec = {
      ...harnessSpec,
      tools: ["exa", "gmail", "goat_result"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(gmailHarnessSpec) } }],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      executeGoatTask({
        task: goatTask({ harnessSpec: gmailHarnessSpec }),
        env: runnerEnv({ publicUrl: undefined }),
        signal: new AbortController().signal,
        reportStage: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("Goat Google tools require RUNNER_LLM_BROKER_PUBLIC_URL");
    expect(sandboxMocks.createOrConnectSandbox).not.toHaveBeenCalled();
  });
});

function goatTask(overrides: Partial<GoatTask> = {}): GoatTask {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "user_1",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "running",
    stage: "planning",
    result: null,
    error: null,
    harnessSpec,
    debugTrace: {},
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runnerEnv(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
