import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerCommandPlan,
  coalesceCodexAppServerNotifications,
  createCodexAppServerAccumulator,
  runCodexAppServerTurn,
} from "./codex-app-server";

const codexHome = "/home/user/.opencompany-codex/session";
const codexWorkRoot = "/home/user/workspace/codex";
const apiAuth = {
  kind: "api" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "CODEX_API_KEY",
  apiKeyValue: "codex_secret_123",
  brokered: false,
};

describe("buildCodexAppServerCommandPlan", () => {
  it("builds stable daemon and proxy commands without embedding secrets", () => {
    const plan = buildCodexAppServerCommandPlan({
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      auth: apiAuth,
      githubAuth: {
        githubToken: "github_token_123",
        githubAuthHeader: "Authorization: Basic github_basic_secret",
      },
    });

    expect(plan.codexEnv).toMatchObject({
      CODEX_HOME: codexHome,
      CODEX_API_KEY: "codex_secret_123",
      GH_TOKEN: "github_token_123",
      GIT_CONFIG_VALUE_0: "Authorization: Basic github_basic_secret",
    });
    expect(plan.socketPath).toBe("ws://127.0.0.1:47345");
    expect(plan.statePath).toBe(`${codexHome}/app-server-state.json`);
    expect(plan.proxyPath).toBe(`${codexHome}/app-server-proxy.mjs`);
    expect(plan.daemonCommand).toContain("codex app-server --listen");
    expect(plan.daemonCommand).toContain("ws://127.0.0.1:47345");
    expect(plan.proxyCommand).toContain("bun");
    expect(plan.proxyCommand).toContain(`${codexHome}/app-server-proxy.mjs`);
    expect(plan.daemonCommand).not.toContain("codex_secret_123");
    expect(plan.daemonCommand).not.toContain("github_token_123");
    expect(plan.proxyCommand).not.toContain("codex_secret_123");
    expect(plan.forceRestart).toBe(false);
  });

  it("forces daemon restart for brokered auth", () => {
    const plan = buildCodexAppServerCommandPlan({
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      auth: { ...apiAuth, brokered: true },
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.forceRestart).toBe(true);
  });

  it("includes the materialized skills fingerprint in daemon reuse decisions", () => {
    const first = buildCodexAppServerCommandPlan({
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });
    const second = buildCodexAppServerCommandPlan({
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_b",
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});

describe("createCodexAppServerAccumulator", () => {
  it("accumulates final agent text, thread id, status, and usage", async () => {
    const accumulator = createCodexAppServerAccumulator();

    accumulator.push({
      method: "thread/started",
      params: { thread: { id: "thread_123" } },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { delta: "Done" },
    });
    accumulator.push({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "Done final" } },
    });
    accumulator.push({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40 },
        },
      },
    });
    accumulator.push({
      method: "turn/completed",
      params: { threadId: "thread_123", turn: { status: "completed" } },
    });
    await accumulator.completed;

    expect(accumulator.summary()).toMatchObject({
      sessionId: "thread_123",
      status: "success",
      result: "Done final",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        output_tokens: 40,
      },
    });
  });

  it("preserves whitespace-only text deltas", async () => {
    const accumulator = createCodexAppServerAccumulator();

    accumulator.push({
      method: "item/agentMessage/delta",
      params: { delta: "Hello" },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { delta: " " },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { delta: "world" },
    });
    accumulator.push({
      method: "turn/completed",
      params: { threadId: "thread_123", turn: { status: "completed" } },
    });
    await accumulator.completed;

    expect(accumulator.summary().result).toBe("Hello world");
  });

  it("does not return visible activity for agent text deltas", () => {
    const accumulator = createCodexAppServerAccumulator();

    expect(
      accumulator.push({
        method: "item/agentMessage/delta",
        params: { delta: "I" },
      }),
    ).toBeNull();
    expect(
      accumulator.push({
        method: "item/agentMessage/delta",
        params: { delta: "'ll " },
      }),
    ).toBeNull();
    expect(
      accumulator.push({
        method: "item/agentMessage/delta",
        params: { delta: "clone" },
      }),
    ).toBeNull();

    expect(accumulator.summary().result).toBe("I'll clone");
  });

  it("returns visible activity when an agent message completes", () => {
    const accumulator = createCodexAppServerAccumulator();

    expect(
      accumulator.push({
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Done final" } },
      }),
    ).toContain("Done final");
  });

  it("uses only the latest agent-message delta item as the fallback final result", async () => {
    const accumulator = createCodexAppServerAccumulator();

    accumulator.push({
      method: "item/agentMessage/delta",
      params: { itemId: "item_progress", delta: "I am checking " },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { itemId: "item_progress", delta: "the repository." },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { itemId: "item_final", delta: "Done" },
    });
    accumulator.push({
      method: "item/agentMessage/delta",
      params: { itemId: "item_final", delta: "." },
    });
    accumulator.push({
      method: "turn/completed",
      params: { threadId: "thread_123", turn: { status: "completed" } },
    });
    await accumulator.completed;

    expect(accumulator.summary().result).toBe("Done.");
  });

  it("maps interrupted turns to an error summary", async () => {
    const accumulator = createCodexAppServerAccumulator();

    accumulator.push({
      method: "turn/completed",
      params: { threadId: "thread_123", turn: { status: "interrupted" } },
    });
    await accumulator.completed;

    expect(accumulator.summary()).toMatchObject({
      sessionId: "thread_123",
      status: "error",
      error: "Codex was interrupted before finishing.",
    });
  });

  it("tracks goal updates and waits for terminal goal status in goal mode", async () => {
    const accumulator = createCodexAppServerAccumulator({ goalMode: true });

    accumulator.setGoal({
      objective: "Fix the tests",
      status: "active",
      tokenBudget: 200_000,
      tokensUsed: null,
      timeUsedSeconds: null,
    });
    accumulator.push({
      method: "turn/completed",
      params: { threadId: "thread_123", turn: { status: "completed" } },
    });

    let didComplete = false;
    void accumulator.completed.then(() => {
      didComplete = true;
    });
    await Promise.resolve();
    expect(didComplete).toBe(false);

    accumulator.push({
      method: "thread/goal/updated",
      params: {
        threadId: "thread_123",
        goal: {
          objective: "Fix the tests",
          status: "complete",
          tokenBudget: 200_000,
          tokensUsed: 1234,
          timeUsedSeconds: 45,
        },
      },
    });
    await accumulator.completed;

    expect(accumulator.summary()).toMatchObject({
      sessionId: "thread_123",
      status: "success",
      goal: {
        objective: "Fix the tests",
        status: "complete",
        tokenBudget: 200_000,
        tokensUsed: 1234,
        timeUsedSeconds: 45,
      },
    });
  });
});

describe("coalesceCodexAppServerNotifications", () => {
  it("coalesces adjacent deltas for the same stream and preserves lifecycle order", () => {
    expect(
      coalesceCodexAppServerNotifications([
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread_1", itemId: "item_1", delta: "Hello" },
        },
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread_1", itemId: "item_1", delta: " " },
        },
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread_1", itemId: "item_1", delta: "world" },
        },
        {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "cmd_1", stream: "stdout", delta: "one" },
        },
        {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "cmd_1", stream: "stderr", delta: "two" },
        },
        {
          method: "turn/completed",
          params: { threadId: "thread_1", turn: { status: "completed" } },
        },
      ]),
    ).toEqual([
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread_1", itemId: "item_1", delta: "Hello world" },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "cmd_1", stream: "stdout", delta: "one" },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "cmd_1", stream: "stderr", delta: "two" },
      },
      {
        method: "turn/completed",
        params: { threadId: "thread_1", turn: { status: "completed" } },
      },
    ]);
  });
});

describe("runCodexAppServerTurn", () => {
  it("starts a thread for a first turn and streams completion", async () => {
    const sandbox = fakeSandbox();
    const runtimeEvents: Record<string, unknown>[] = [];

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "implement the request",
      skills: [
        {
          name: "coding-work",
          path: "/home/user/work/.agents/skills/coding-work/SKILL.md",
        },
      ],
      localImages: [{ path: "/home/user/work/screenshot.png", detail: "original" }],
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: "xhigh",
      existingEngineSessionId: null,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async (events) => {
        runtimeEvents.push(...events);
      },
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(
      sandbox.sentMessages().find((message) => message.method === "thread/start"),
    ).toMatchObject({
      params: {
        config: {
          model_reasoning_effort: "high",
          plan_mode_reasoning_effort: "xhigh",
        },
      },
    });
    expect(sandbox.sentMessages().find((message) => message.method === "turn/start")).toMatchObject(
      {
        params: {
          input: [
            { type: "text", text: "implement the request", text_elements: [] },
            {
              type: "skill",
              name: "coding-work",
              path: "/home/user/work/.agents/skills/coding-work/SKILL.md",
            },
            {
              type: "localImage",
              path: "/home/user/work/screenshot.png",
              detail: "original",
            },
          ],
        },
      },
    );
    expect(sandbox.startedCommands()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("codex app-server --listen"),
        expect.stringContaining("app-server-proxy.mjs"),
      ]),
    );
    expect(summary).toMatchObject({
      sessionId: "thread_started",
      status: "success",
      result: "Codex completed.",
    });
    expect(runtimeEvents.map((event) => event.method)).toContain("turn/completed");
  });

  it("resumes an existing thread id on follow-up turns", async () => {
    const sandbox = fakeSandbox();

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "continue",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
    expect(
      sandbox.sentMessages().find((message) => message.method === "thread/resume"),
    ).toMatchObject({
      params: {
        threadId: "thread_existing",
        config: {
          model_reasoning_effort: "medium",
        },
      },
    });
    const resumeMessage = sandbox
      .sentMessages()
      .find((message) => message.method === "thread/resume");
    expect(JSON.stringify(resumeMessage?.params)).not.toContain("plan_mode_reasoning_effort");
    expect(summary.sessionId).toBe("thread_existing");
  });

  it("sets a Codex goal after materializing the thread and before starting the turn", async () => {
    const sandbox = fakeSandbox({ completeGoalDelayMs: 5 });
    const activities: string[] = [];

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "fix tests",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      goalMode: {
        objective: "Fix tests and verify they pass.",
        tokenBudget: 200_000,
      },
      existingEngineSessionId: null,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onActivity: async (activity) => {
        activities.push(activity);
      },
    });

    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/goal/set",
      "turn/start",
    ]);
    expect(
      sandbox.sentMessages().find((message) => message.method === "thread/goal/set"),
    ).toMatchObject({
      params: {
        threadId: "thread_started",
        objective: "Fix tests and verify they pass.",
        status: "active",
        tokenBudget: 200_000,
      },
    });
    expect(summary).toMatchObject({
      status: "success",
      goal: {
        objective: "Fix tests and verify they pass.",
        status: "complete",
        tokenBudget: 200_000,
        tokensUsed: 3456,
        timeUsedSeconds: 12,
      },
    });
    expect(activities.join("\n")).toContain("Codex goal: complete");
  });

  it("interrupts and returns timeout when the turn does not complete", async () => {
    const sandbox = fakeSandbox({ completeTurn: false });

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "continue",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      planModeReasoningEffort: null,
      existingEngineSessionId: null,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 1,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toContain("turn/interrupt");
    expect(summary).toMatchObject({
      status: "timeout",
      error: "Codex timed out before finishing. The partial output is shown below.",
    });
  });
});

function fakeSandbox(options: { completeTurn?: boolean; completeGoalDelayMs?: number } = {}) {
  const files = new Map<string, string>();
  let proxyStdout: ((data: string) => void | Promise<void>) | null = null;
  let nextPid = 100;
  const commands: string[] = [];
  const messages: Array<{ method: string; params?: unknown; id?: number }> = [];

  const sandbox = {
    files: {
      write: async (path: string, content: string) => {
        files.set(path, content);
      },
      read: async (path: string) => {
        if (!files.has(path)) throw new Error("missing file");
        return files.get(path)!;
      },
    },
    commands: {
      run: async (
        command: string,
        options?: {
          background?: boolean;
          stdin?: boolean;
          onStdout?: (data: string) => void | Promise<void>;
        },
      ) => {
        commands.push(command);
        if (command.includes("test -S") && command.includes("kill -0")) {
          throw new Error("not running");
        }
        if (command.includes("for i in $(seq")) return { stdout: "", stderr: "", exitCode: 0 };
        if (options?.background) {
          if (options.stdin) proxyStdout = options.onStdout ?? null;
          return { pid: nextPid++ };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      sendStdin: async (_pid: number, data: string) => {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as { method: string; params?: unknown; id?: number };
          messages.push(message);
          await respondToProxyMessage(message, proxyStdout, options);
        }
      },
      kill: async () => true,
    },
    sentMethods: () => messages.map((message) => message.method),
    sentMessages: () => messages,
    startedCommands: () => commands,
  };

  return sandbox;
}

async function respondToProxyMessage(
  message: { method: string; params?: unknown; id?: number },
  onStdout: ((data: string) => void | Promise<void>) | null,
  options: { completeTurn?: boolean; completeGoalDelayMs?: number },
) {
  if (!onStdout || message.id == null) return;
  if (message.method === "initialize") {
    await onStdout(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`);
    return;
  }
  if (message.method === "thread/start") {
    await onStdout(
      `${JSON.stringify({
        id: message.id,
        result: { thread: { id: "thread_started" } },
      })}\n`,
    );
    return;
  }
  if (message.method === "thread/resume") {
    await onStdout(
      `${JSON.stringify({
        id: message.id,
        result: { thread: { id: "thread_existing" } },
      })}\n`,
    );
    return;
  }
  if (message.method === "thread/goal/set") {
    await onStdout(
      `${JSON.stringify({
        id: message.id,
        result: {
          goal: {
            objective: "Fix tests and verify they pass.",
            status: "active",
            tokenBudget: 200_000,
          },
        },
      })}\n`,
    );
    return;
  }
  if (message.method === "turn/start") {
    const threadId =
      typeof message.params === "object" &&
      message.params &&
      "threadId" in message.params &&
      typeof message.params.threadId === "string"
        ? message.params.threadId
        : "thread_started";
    await onStdout(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } })}\n`);
    if (options.completeTurn === false) return;
    await onStdout(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: "turn_1", itemId: "item_1", delta: "Codex completed." },
      })}\n`,
    );
    await onStdout(
      `${JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: { id: "turn_1", status: "completed" } },
      })}\n`,
    );
    if (options.completeGoalDelayMs != null) {
      await new Promise((resolve) => setTimeout(resolve, options.completeGoalDelayMs));
      await onStdout(
        `${JSON.stringify({
          method: "thread/goal/updated",
          params: {
            threadId,
            goal: {
              objective: "Fix tests and verify they pass.",
              status: "complete",
              tokenBudget: 200_000,
              tokensUsed: 3456,
              timeUsedSeconds: 12,
            },
          },
        })}\n`,
      );
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    await onStdout(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
}
