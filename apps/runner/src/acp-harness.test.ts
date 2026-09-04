import { describe, expect, it, vi } from "vitest";
import { CLAUDE_ACP_ENGINE_ADAPTER, CODEX_ACP_ENGINE_ADAPTER } from "./acp-engine-adapters";
import { AcpHarness, type AcpHarnessTurnInput } from "./acp-harness";
import { CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import type { SandboxHandle } from "./sandbox";

type JsonRpcMessage = Record<string, unknown>;

function fakeAcpSandbox(
  respond: (
    message: JsonRpcMessage,
    emit: (message: JsonRpcMessage) => Promise<void>,
  ) => Promise<void>,
) {
  let onStdout: ((data: string) => void | Promise<void>) | null = null;
  const requests: JsonRpcMessage[] = [];
  const kill = vi.fn(async () => true);
  const sendStdin = vi.fn(async (_pid: number, data: string) => {
    for (const line of data.split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as JsonRpcMessage;
      requests.push(message);
      await respond(message, async (reply) => {
        await onStdout?.(`${JSON.stringify(reply)}\n`);
      });
    }
  });
  const run = vi.fn(
    async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
      onStdout = options.onStdout ?? null;
      return { pid: 41, wait: () => new Promise<never>(() => {}) };
    },
  );
  const sandbox = {
    commands: { run, sendStdin, kill },
  } as unknown as SandboxHandle;
  return { sandbox, requests, run, kill };
}

function harnessInput(
  sandbox: SandboxHandle,
  overrides: Partial<AcpHarnessTurnInput> = {},
): AcpHarnessTurnInput {
  return {
    adapter: CLAUDE_ACP_ENGINE_ADAPTER,
    sandbox,
    workdir: "/home/user/opencompany-goat/claude-chat",
    task: "Inspect the repository.",
    prepareFreshTask: vi.fn(async () => "Recover with full history."),
    existingSessionId: null,
    mcpServers: [],
    envs: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
    timeoutMs: 5_000,
    redact: (value) => value.replaceAll("secret", "[redacted]"),
    checkAbort: vi.fn(async () => {}),
    onRuntimeEvents: vi.fn(async () => {}),
    onEngineSessionId: vi.fn(async () => {}),
    onExistingSessionInvalidated: vi.fn(async () => {}),
    onPermissionRequest: vi.fn(async () => ({
      outcome: { outcome: "selected" as const, optionId: "allow-once" },
    })),
    ...overrides,
  };
}

describe("AcpHarness", () => {
  it("retries an initialize timeout because no engine execution has started", async () => {
    vi.useFakeTimers();
    try {
      const transport = fakeAcpSandbox(async () => {});
      const run = new AcpHarness().runTurn(
        harnessInput(transport.sandbox, {
          adapter: CODEX_ACP_ENGINE_ADAPTER,
        }),
      );
      const rejected = expect(run).rejects.toMatchObject({
        name: CodexChatRetryableInfrastructureError.name,
        message: 'Codex ACP request "initialize" failed before execution started.',
        cause: expect.objectContaining({
          message: 'ACP request "initialize" timed out.',
        }),
        diagnosticMessage: '[acp_initialize] Error: ACP request "initialize" timed out.',
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await rejected;
      expect(transport.requests).toContainEqual(expect.objectContaining({ method: "initialize" }));
      expect(transport.kill).toHaveBeenCalledWith(41);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts Claude with core MCP tools ready while plugin MCP tools stay deferred", async () => {
    let resolvePermission: (() => void) | null = null;
    const permissionAnswered = new Promise<void>((resolve) => {
      resolvePermission = resolve;
    });
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/new") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "session_new",
            configOptions: [{ id: "model" }, { id: "effort" }, { id: "mode" }],
          },
        });
      } else if (message.method === "session/set_config_option") {
        await emit({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "session/prompt") {
        await emit({
          jsonrpc: "2.0",
          method: "_claude/sdkMessage",
          params: {
            sessionId: "session_new",
            message: {
              type: "system",
              subtype: "init",
              tools: ["mcp__opencompany__list_actions", "mcp__opencompany__use_action"],
              mcp_servers: [{ name: "opencompany", status: "connected" }],
            },
          },
        });
        await emit({
          jsonrpc: "2.0",
          id: "permission_1",
          method: "session/request_permission",
          params: {
            sessionId: "session_new",
            toolCall: { toolCallId: "command_1", title: "Run tests" },
            options: [{ optionId: "allow-once", kind: "allow_once" }],
          },
        });
        await permissionAnswered;
        await emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session_new",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done" },
            },
          },
        });
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 1 } },
        });
      } else if (message.id === "permission_1") {
        resolvePermission?.();
      }
    });
    const runtimeEvents: Record<string, unknown>[] = [];
    const onPermissionRequest = vi.fn(async () => ({
      outcome: { outcome: "selected" as const, optionId: "allow-once" },
    }));
    const onNotification = vi.fn(async () => undefined);
    const onEngineStopped = vi.fn(async () => undefined);
    const input = harnessInput(transport.sandbox, {
      mcpServers: [
        {
          name: "opencompany",
          type: "http",
          url: "https://runner.example.test/mcp",
          headers: [{ name: "x-opencompany-tool-ticket", value: "ticket" }],
        },
        {
          name: "plugin-linear",
          type: "http",
          url: "https://plugins.example.test/linear/mcp",
          headers: [{ name: "authorization", value: "Bearer plugin-ticket" }],
        },
      ],
      onRuntimeEvents: vi.fn(async (events) => {
        runtimeEvents.push(...events);
      }),
      onNotification,
      onPermissionRequest,
      onEngineStopped,
      model: "claude-sonnet-5",
      reasoningEffort: "xhigh",
      permissionMode: "default",
    });

    const result = await new AcpHarness().runTurn(input);

    expect(result).toMatchObject({
      sessionId: "session_new",
      loadedSession: false,
      promptResponse: { stopReason: "end_turn" },
    });
    expect(transport.requests.find((request) => request.method === "session/new")).toMatchObject({
      params: {
        mcpServers: [
          {
            name: "plugin-linear",
            type: "http",
            url: "https://plugins.example.test/linear/mcp",
            headers: [{ name: "authorization", value: "Bearer plugin-ticket" }],
          },
        ],
        _meta: {
          claudeCode: {
            emitRawSDKMessages: [{ type: "system", subtype: "init" }],
            options: {
              maxTurns: 250,
              strictMcpConfig: true,
              mcpServers: {
                opencompany: {
                  type: "http",
                  url: "https://runner.example.test/mcp",
                  headers: { "x-opencompany-tool-ticket": "ticket" },
                  alwaysLoad: true,
                },
              },
            },
          },
        },
      },
    });
    expect(input.onEngineSessionId).toHaveBeenCalledWith("session_new");
    expect(onNotification).toHaveBeenCalledWith({
      method: "_claude/sdkMessage",
      params: expect.objectContaining({ sessionId: "session_new" }),
    });
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "permission_1", method: "session/request_permission" }),
    );
    expect(transport.requests).toContainEqual({
      jsonrpc: "2.0",
      id: "permission_1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    expect(
      transport.requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params),
    ).toEqual([
      { sessionId: "session_new", configId: "model", value: "claude-sonnet-5" },
      { sessionId: "session_new", configId: "effort", value: "max" },
      { sessionId: "session_new", configId: "mode", value: "default" },
    ]);
    expect(runtimeEvents.map((event) => event.method)).toEqual([
      "session/started",
      "session/update",
      "session/prompt_result",
    ]);
    expect(transport.kill).toHaveBeenCalledWith(41);
    expect(onEngineStopped).toHaveBeenCalledOnce();
    expect(transport.kill.mock.invocationCallOrder[0]).toBeLessThan(
      onEngineStopped.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    {
      failure: "times out",
      errorName: "SandboxError",
      message: "2: [unknown] The operation timed out.",
    },
    {
      failure: "loses its control socket",
      errorName: "SandboxError",
      message:
        "2: [unknown] The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    },
    {
      failure: "receives an incomplete envelope",
      errorName: "InvalidArgumentError",
      message: "3: [invalid_argument] protocol error: incomplete envelope",
    },
    {
      failure: "rejects with a new SDK error shape",
      errorName: "UnexpectedDecoderError",
      message: "The command stream decoder rejected a frame.",
    },
  ])(
    "reattaches to the running ACP process when its E2B command watch $failure",
    async ({ errorName, message: streamErrorMessage }) => {
      let rejectInitialWatch: ((error: Error) => void) | null = null;
      const initialWatch = new Promise<never>((_resolve, reject) => {
        rejectInitialWatch = reject;
      });
      let resolveConnected: (() => void) | null = null;
      const connected = new Promise<void>((resolve) => {
        resolveConnected = resolve;
      });
      let onStdout: ((data: string) => void | Promise<void>) | null = null;
      const requests: JsonRpcMessage[] = [];
      const kill = vi.fn(async () => true);
      const disconnect = vi.fn(async () => undefined);
      const run = vi.fn(
        async (
          _command: string,
          options: { onStdout?: (data: string) => void | Promise<void> },
        ) => {
          onStdout = options.onStdout ?? null;
          return { pid: 41, wait: () => initialWatch };
        },
      );
      const connect = vi.fn(
        async (_pid: number, options: { onStdout?: (data: string) => void | Promise<void> }) => {
          onStdout = options.onStdout ?? null;
          resolveConnected?.();
          return { pid: 41, wait: () => new Promise<never>(() => {}), disconnect };
        },
      );
      const sendStdin = vi.fn(async (_pid: number, data: string) => {
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as JsonRpcMessage;
          requests.push(message);
          if (message.method === "initialize") {
            await onStdout?.(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { agentCapabilities: { loadSession: true } },
              })}\n`,
            );
          } else if (message.method === "session/new") {
            await onStdout?.(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { sessionId: "session_reconnected" },
              })}\n`,
            );
          } else if (message.method === "session/prompt") {
            const streamError = new Error(streamErrorMessage);
            streamError.name = errorName;
            rejectInitialWatch?.(streamError);
            await connected;
            await onStdout?.(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { stopReason: "end_turn" },
              })}\n`,
            );
          }
        }
      });
      const sandbox = {
        commands: { run, connect, sendStdin, kill },
      } as unknown as SandboxHandle;

      const result = await new AcpHarness().runTurn(harnessInput(sandbox));

      expect(result).toMatchObject({
        sessionId: "session_reconnected",
        promptResponse: { stopReason: "end_turn" },
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledWith(
        41,
        expect.objectContaining({ timeoutMs: 0, onStdout: expect.any(Function) }),
      );
      expect(requests.filter((request) => request.method === "session/prompt")).toHaveLength(1);
      expect(kill).toHaveBeenCalledWith(41);
    },
  );

  it("keeps a non-zero ACP adapter exit terminal", async () => {
    let rejectInitialWatch: ((error: Error) => void) | null = null;
    const initialWatch = new Promise<never>((_resolve, reject) => {
      rejectInitialWatch = reject;
    });
    let onStdout: ((data: string) => void | Promise<void>) | null = null;
    const exitError = Object.assign(new Error("ACP adapter exited with code 1."), {
      name: "CommandExitError",
      result: { exitCode: 1, stdout: "", stderr: "adapter crashed" },
    });
    const connect = vi.fn(async () => {
      throw new Error("should not reconnect");
    });
    const kill = vi.fn(async () => true);
    const run = vi.fn(
      async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
        onStdout = options.onStdout ?? null;
        return { pid: 41, wait: () => initialWatch };
      },
    );
    const sendStdin = vi.fn(async (_pid: number, data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.method === "initialize") {
          await onStdout?.(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { agentCapabilities: { loadSession: true } },
            })}\n`,
          );
        } else if (message.method === "session/new") {
          await onStdout?.(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: "session_exit" },
            })}\n`,
          );
        } else if (message.method === "session/prompt") {
          rejectInitialWatch?.(exitError);
        }
      }
    });
    const sandbox = {
      commands: { run, connect, sendStdin, kill },
    } as unknown as SandboxHandle;

    await expect(new AcpHarness().runTurn(harnessInput(sandbox))).rejects.toBe(exitError);
    expect(connect).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(41);
  });

  it("defers the durable turn when every command-watch reconnect attempt fails", async () => {
    let rejectInitialWatch: ((error: Error) => void) | null = null;
    const initialWatch = new Promise<never>((_resolve, reject) => {
      rejectInitialWatch = reject;
    });
    let onStdout: ((data: string) => void | Promise<void>) | null = null;
    const streamError = new Error("The command stream decoder rejected a frame.");
    streamError.name = "UnexpectedDecoderError";
    const connectError = new Error("The process could not be reattached.");
    const connect = vi.fn(async () => {
      throw connectError;
    });
    const kill = vi.fn(async () => true);
    const run = vi.fn(
      async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
        onStdout = options.onStdout ?? null;
        return { pid: 41, wait: () => initialWatch };
      },
    );
    const sendStdin = vi.fn(async (_pid: number, data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.method === "initialize") {
          await onStdout?.(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { agentCapabilities: { loadSession: true } },
            })}\n`,
          );
        } else if (message.method === "session/new") {
          await onStdout?.(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: "session_disconnect" },
            })}\n`,
          );
        } else if (message.method === "session/prompt") {
          rejectInitialWatch?.(streamError);
        }
      }
    });
    const sandbox = {
      commands: { run, connect, sendStdin, kill },
    } as unknown as SandboxHandle;

    await expect(
      new AcpHarness().runTurn(
        harnessInput(sandbox, {
          redact: (value) => value.replaceAll("decoder", "[redacted]"),
        }),
      ),
    ).rejects.toMatchObject({
      name: CodexChatRetryableInfrastructureError.name,
      cause: streamError,
      diagnosticMessage:
        "[run_turn] UnexpectedDecoderError: The command stream [redacted] rejected a frame.",
    });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledWith(41);
  });

  // Any application-level (JSON-RPC) session/load failure means the saved thread is unusable on
  // this process — including the sticky variants that previously escaped the message-regex allowlist
  // and permanently bricked the session (-32603 "Internal error", "no rollout found …").
  it.each([
    { errorCode: -32002, errorText: "Session not found", label: "a missing session" },
    { errorCode: -32603, errorText: "Internal error", label: "an internal error" },
    {
      errorCode: -32000,
      errorText: "no rollout found for thread id 9b5fee11",
      label: "a non-matching error message",
    },
  ])(
    "invalidates the stored session and starts fresh when session/load fails with $label",
    async ({ errorCode, errorText }) => {
      const transport = fakeAcpSandbox(async (message, emit) => {
        if (message.method === "initialize") {
          await emit({
            jsonrpc: "2.0",
            id: message.id,
            result: { agentCapabilities: { loadSession: true } },
          });
        } else if (message.method === "session/load") {
          await emit({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: errorCode, message: errorText },
          });
        } else if (message.method === "session/new") {
          await emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session_fresh" } });
        } else if (message.method === "session/prompt") {
          await emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        }
      });
      const prepareFreshTask = vi.fn(async () => "Recover with full history.");
      const onExistingSessionInvalidated = vi.fn(async () => {});
      const input = harnessInput(transport.sandbox, {
        existingSessionId: "session_stale",
        prepareFreshTask,
        onExistingSessionInvalidated,
      });

      const result = await new AcpHarness().runTurn(input);

      expect(result).toMatchObject({ sessionId: "session_fresh", loadedSession: false });
      expect(onExistingSessionInvalidated).toHaveBeenCalledOnce();
      expect(prepareFreshTask).toHaveBeenCalledOnce();
      const prompt = transport.requests.find((request) => request.method === "session/prompt");
      expect(prompt).toMatchObject({
        params: {
          sessionId: "session_fresh",
          prompt: [{ type: "text", text: "Recover with full history." }],
        },
      });
    },
  );

  it("aborts the turn without invalidating the thread when session/load fails at the transport level", async () => {
    let resolveExit: (() => void) | null = null;
    let onStdout: ((data: string) => void | Promise<void>) | null = null;
    const requests: JsonRpcMessage[] = [];
    const kill = vi.fn(async () => true);
    const sendStdin = vi.fn(async (_pid: number, data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as JsonRpcMessage;
        requests.push(message);
        if (message.method === "initialize") {
          await onStdout?.(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { agentCapabilities: { loadSession: true } },
            })}\n`,
          );
        } else if (message.method === "session/load") {
          // Simulate the adapter process dying mid-load: the client fails every pending request
          // with a plain (non-AcpRpcError) transport error.
          resolveExit?.();
        }
      }
    });
    const run = vi.fn(
      async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
        onStdout = options.onStdout ?? null;
        return {
          pid: 41,
          wait: () =>
            new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
        };
      },
    );
    const sandbox = { commands: { run, sendStdin, kill } } as unknown as SandboxHandle;
    const onExistingSessionInvalidated = vi.fn(async () => {});
    const input = harnessInput(sandbox, {
      existingSessionId: "session_dead",
      onExistingSessionInvalidated,
    });

    await expect(new AcpHarness().runTurn(input)).rejects.toMatchObject({
      name: CodexChatRetryableInfrastructureError.name,
      message: 'Claude Code ACP request "session/load" failed before execution started.',
      cause: expect.objectContaining({ message: expect.stringMatching(/exited unexpectedly/) }),
    });
    expect(onExistingSessionInvalidated).not.toHaveBeenCalled();
    expect(requests.find((request) => request.method === "session/new")).toBeUndefined();
  });

  it("applies Codex configuration, goals, multimodal prompts, and elicitation", async () => {
    let resolveElicitation: (() => void) | null = null;
    const elicitationAnswered = new Promise<void>((resolve) => {
      resolveElicitation = resolve;
    });
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            agentCapabilities: { loadSession: true },
            _meta: {
              goal: {
                version: 1,
                controlMethod: "_custom/session_goal",
                actions: ["set", "pause", "resume", "clear"],
              },
            },
          },
        });
      } else if (message.method === "session/new") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "codex_session",
            configOptions: [
              { id: "model" },
              { id: "reasoning_effort" },
              { id: "mode" },
              { id: "collaboration_mode" },
            ],
          },
        });
      } else if (
        message.method === "session/set_config_option" ||
        message.method === "_custom/session_goal"
      ) {
        await emit({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "session/prompt") {
        await emit({
          jsonrpc: "2.0",
          id: "elicitation_1",
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Choose a branch",
            requestedSchema: {
              type: "object",
              properties: { branch: { type: "string" } },
              required: ["branch"],
            },
          },
        });
        await elicitationAnswered;
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" },
        });
      } else if (message.id === "elicitation_1") {
        resolveElicitation?.();
      }
    });
    const onElicitationRequest = vi.fn(async () => ({
      action: "accept" as const,
      content: { branch: "feature/acp" },
    }));
    const input = harnessInput(transport.sandbox, {
      adapter: CODEX_ACP_ENGINE_ADAPTER,
      workdir: "/home/user/opencompany-goat/codex-chat",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "bypassPermissions",
      collaborationMode: "plan",
      goal: { objective: "Finish issue 1324", tokenBudget: 50_000 },
      prompt: [
        { type: "text", text: "Inspect this screenshot." },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      onElicitationRequest,
    });

    await new AcpHarness().runTurn(input);

    expect(
      transport.requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params),
    ).toEqual([
      { sessionId: "codex_session", configId: "model", value: "gpt-5.6-sol" },
      { sessionId: "codex_session", configId: "reasoning_effort", value: "xhigh" },
      { sessionId: "codex_session", configId: "mode", value: "agent-full-access" },
      { sessionId: "codex_session", configId: "collaboration_mode", value: "plan" },
    ]);
    expect(transport.requests).toContainEqual({
      jsonrpc: "2.0",
      id: expect.any(Number),
      method: "_custom/session_goal",
      params: {
        sessionId: "codex_session",
        action: "set",
        objective: "Finish issue 1324",
        tokenBudget: 50_000,
      },
    });
    expect(transport.requests.find((request) => request.method === "session/prompt")).toMatchObject(
      {
        params: {
          prompt: [
            { type: "text", text: "Inspect this screenshot." },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
      },
    );
    expect(onElicitationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "elicitation_1", method: "elicitation/create" }),
    );
    expect(transport.requests).toContainEqual({
      jsonrpc: "2.0",
      id: "elicitation_1",
      result: { action: "accept", content: { branch: "feature/acp" } },
    });
  });

  it("falls back to a normal prompt when the adapter does not advertise Goal controls", async () => {
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/new") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: "codex_session", configOptions: [] },
        });
      } else if (message.method === "session/prompt") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" },
        });
      }
    });

    await new AcpHarness().runTurn(
      harnessInput(transport.sandbox, {
        adapter: CODEX_ACP_ENGINE_ADAPTER,
        goal: { objective: "Finish issue 1324" },
      }),
    );

    expect(transport.requests.some((request) => String(request.method).includes("goal"))).toBe(
      false,
    );
    expect(transport.requests.some((request) => request.method === "session/prompt")).toBe(true);
  });

  it("lets an advertised Goal control run beyond the setup request timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = fakeAcpSandbox(async (message, emit) => {
        if (message.method === "initialize") {
          await emit({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              agentCapabilities: { loadSession: true },
              _meta: {
                goal: {
                  version: 1,
                  controlMethod: "_session/goal",
                  actions: ["set"],
                },
              },
            },
          });
        } else if (message.method === "session/new") {
          await emit({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "codex_session", configOptions: [] },
          });
        } else if (message.method === "_session/goal") {
          setTimeout(() => {
            void emit({ jsonrpc: "2.0", id: message.id, result: {} });
          }, 31_000);
        } else if (message.method === "session/prompt") {
          await emit({
            jsonrpc: "2.0",
            id: message.id,
            result: { stopReason: "end_turn" },
          });
        }
      });
      const run = new AcpHarness().runTurn(
        harnessInput(transport.sandbox, {
          adapter: CODEX_ACP_ENGINE_ADAPTER,
          goal: { objective: "Finish issue 1324" },
          timeoutMs: 60_000,
        }),
      );

      await vi.advanceTimersByTimeAsync(31_000);

      await expect(run).resolves.toMatchObject({ promptResponse: { stopReason: "end_turn" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads a stored session without projecting its replayed transcript", async () => {
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/load") {
        await emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session_existing",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Historical answer" },
            },
          },
        });
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { configOptions: [] },
        });
      } else if (message.method === "session/prompt") {
        await emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session_existing",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Current answer" },
            },
          },
        });
        await emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const runtimeEvents: Record<string, unknown>[] = [];
    const input = harnessInput(transport.sandbox, {
      existingSessionId: "session_existing",
      onRuntimeEvents: vi.fn(async (events) => {
        runtimeEvents.push(...events);
      }),
    });

    const result = await new AcpHarness().runTurn(input);

    expect(result.loadedSession).toBe(true);
    expect(JSON.stringify(runtimeEvents)).not.toContain("Historical answer");
    expect(JSON.stringify(runtimeEvents)).toContain("Current answer");
  });

  it("fails the active prompt when a notification observer rejects", async () => {
    const observerError = new Error("Required runtime capability was unavailable.");
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/new") {
        await emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session_guarded" } });
      } else if (message.method === "session/prompt") {
        await emit({
          jsonrpc: "2.0",
          method: "_claude/sdkMessage",
          params: {
            sessionId: "session_guarded",
            message: { type: "system", subtype: "init" },
          },
        });
        await Promise.resolve();
        await emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session_guarded",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Do not project after the observer fails." },
            },
          },
        });
      }
    });
    const runtimeEvents: Record<string, unknown>[] = [];
    const input = harnessInput(transport.sandbox, {
      onNotification: vi.fn(async (notification) => {
        if (notification.method === "_claude/sdkMessage") throw observerError;
      }),
      onRuntimeEvents: vi.fn(async (events) => {
        runtimeEvents.push(...events);
      }),
    });

    await expect(new AcpHarness().runTurn(input)).rejects.toBe(observerError);

    expect(JSON.stringify(runtimeEvents)).not.toContain("Do not project");
    expect(transport.kill).toHaveBeenCalledWith(41);
  });

  it("injects Codex steering through the provider extension while a prompt is active", async () => {
    let promptRequestId: number | string | null = null;
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/new") {
        await emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "codex_steer" } });
      } else if (message.method === "session/prompt") {
        promptRequestId = message.id as number | string;
      } else if (message.method === "_session/steering") {
        await emit({ jsonrpc: "2.0", id: message.id, result: { outcome: "injected" } });
        await emit({
          jsonrpc: "2.0",
          id: promptRequestId,
          result: { stopReason: "end_turn" },
        });
      }
    });
    async function* steering() {
      yield [{ type: "text" as const, text: "Also inspect the worker registry." }];
    }

    await new AcpHarness().runTurn(
      harnessInput(transport.sandbox, {
        adapter: CODEX_ACP_ENGINE_ADAPTER,
        steering: steering(),
      }),
    );

    expect(transport.requests).toContainEqual({
      jsonrpc: "2.0",
      id: expect.any(Number),
      method: "_session/steering",
      params: {
        sessionId: "codex_steer",
        prompt: [{ type: "text", text: "Also inspect the worker registry." }],
      },
    });
  });

  it("cancels an interrupted prompt after persisting its partial updates", async () => {
    let promptRequestId: unknown = null;
    const transport = fakeAcpSandbox(async (message, emit) => {
      if (message.method === "initialize") {
        await emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/new") {
        await emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session_cancel" } });
      } else if (message.method === "session/prompt") {
        promptRequestId = message.id;
        await emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session_cancel",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Keep this partial output" },
            },
          },
        });
      } else if (message.method === "session/cancel") {
        await emit({
          jsonrpc: "2.0",
          id: promptRequestId,
          result: { stopReason: "cancelled" },
        });
      }
    });
    const interrupted = new Error("Turn interrupted");
    const onRuntimeEvents = vi.fn(async () => {});
    const input = harnessInput(transport.sandbox, {
      checkAbort: vi.fn(async () => {
        throw interrupted;
      }),
      onRuntimeEvents,
    });

    await expect(new AcpHarness().runTurn(input)).rejects.toBe(interrupted);

    expect(transport.requests).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session_cancel" },
    });
    expect(onRuntimeEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        method: "session/update",
        params: expect.objectContaining({ sessionId: "session_cancel" }),
      }),
    ]);
  });
});
