import { describe, expect, it, vi } from "vitest";
import { CLAUDE_ACP_ENGINE_ADAPTER, CODEX_ACP_ENGINE_ADAPTER } from "./acp-engine-adapters";
import { AcpHarness, type AcpHarnessTurnInput } from "./acp-harness";
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
  it("runs an ACP turn, streams updates, and answers permission requests", async () => {
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
    const input = harnessInput(transport.sandbox, {
      mcpServers: [
        {
          name: "opencompany-actions",
          type: "http",
          url: "https://runner.example.test/mcp",
          headers: [{ name: "x-opencompany-tool-ticket", value: "ticket" }],
        },
      ],
      onRuntimeEvents: vi.fn(async (events) => {
        runtimeEvents.push(...events);
      }),
      onPermissionRequest,
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
            name: "opencompany-actions",
            type: "http",
            url: "https://runner.example.test/mcp",
            headers: [{ name: "x-opencompany-tool-ticket", value: "ticket" }],
          },
        ],
        _meta: { claudeCode: { options: { maxTurns: 250, strictMcpConfig: true } } },
      },
    });
    expect(input.onEngineSessionId).toHaveBeenCalledWith("session_new");
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
  });

  it("reattaches to the running ACP process when the E2B command watch times out", async () => {
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
      async (_command: string, options: { onStdout?: (data: string) => void | Promise<void> }) => {
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
          const streamError = new Error("2: [unknown] The operation timed out.");
          streamError.name = "SandboxError";
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

    await expect(new AcpHarness().runTurn(input)).rejects.toThrow(/exited unexpectedly/);
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
          result: { agentCapabilities: { loadSession: true } },
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
        message.method === "_session/goal"
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
      method: "_session/goal",
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
