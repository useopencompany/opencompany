import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerCommandPlan,
  coalesceCodexAppServerNotifications,
  codexAppServerProxyScript,
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
    expect(plan.socketPath).toBe(`${codexHome}/app-server.sock`);
    expect(plan.statePath).toBe(`${codexHome}/app-server-state.json`);
    expect(plan.proxyPath).toBe(`${codexHome}/app-server-proxy.mjs`);
    expect(plan.proxyStatePath).toBe(`${codexHome}/app-server-proxy-state.json`);
    expect(plan.daemonCommand).toContain("codex app-server --listen");
    expect(plan.daemonCommand).toContain("unix://");
    expect(plan.daemonCommand).toContain(`${codexHome}/app-server.sock`);
    expect(plan.proxyCommand).toContain("bun");
    expect(plan.proxyCommand).toContain(`${codexHome}/app-server-proxy.mjs`);
    expect(plan.daemonCommand).not.toContain("codex_secret_123");
    expect(plan.daemonCommand).not.toContain("github_token_123");
    expect(plan.proxyCommand).not.toContain("codex_secret_123");
    expect(plan.forceRestart).toBe(false);
  });

  it("generates a syntactically valid Unix-socket WebSocket proxy", () => {
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: codexAppServerProxyScript(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).not.toThrow();
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
          last: {
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheCreationInputTokens: 5,
            outputTokens: 40,
          },
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
        cache_creation_input_tokens: 5,
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
    const persistedEngineIds: string[] = [];
    const baselineSnapshots: string[][] = [];

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
      onEngineSessionId: async (threadId) => {
        persistedEngineIds.push(`thread:${threadId}`);
      },
      onEngineTurnId: async (turnId) => {
        persistedEngineIds.push(`turn:${turnId}`);
      },
      onBeforeEngineTurnStart: async (baselineTurnIds) => {
        baselineSnapshots.push(baselineTurnIds);
        expect(sandbox.sentMethods()).not.toContain("turn/start");
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
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-5.5",
              reasoning_effort: "xhigh",
              developer_instructions: null,
            },
          },
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
    expect(
      sandbox.startedCommandRuns().find(({ command }) => command.includes("app-server-proxy.mjs"))
        ?.options,
    ).toMatchObject({
      background: true,
      stdin: true,
      timeoutMs: 0,
    });
    expect(summary).toMatchObject({
      sessionId: "thread_started",
      status: "success",
      result: "Codex completed.",
    });
    expect(runtimeEvents.map((event) => event.method)).toContain("turn/completed");
    expect(baselineSnapshots).toEqual([[]]);
    expect(persistedEngineIds).toEqual(["thread:thread_started", "turn:turn_1"]);
  });

  it("resumes an existing thread id on follow-up turns", async () => {
    const sandbox = fakeSandbox();
    const prepareBootstrapTurn = vi.fn(async () => ({ task: "durable history" }));

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "continue",
      prepareBootstrapTurn,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      dynamicTools: [
        {
          spec: {
            type: "function",
            name: "goat_brain",
            description: "Read the Brain.",
            inputSchema: { type: "object" },
          },
          execute: vi.fn(),
        },
      ],
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
    expect(JSON.stringify(resumeMessage?.params)).not.toContain("dynamicTools");
    expect(sandbox.sentMessages().find((message) => message.method === "turn/start")).toMatchObject(
      {
        params: {
          input: [{ type: "text", text: "continue", text_elements: [] }],
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.5",
              reasoning_effort: "medium",
              developer_instructions: null,
            },
          },
        },
      },
    );
    expect(prepareBootstrapTurn).not.toHaveBeenCalled();
    expect(summary.sessionId).toBe("thread_existing");
  });

  it("bootstraps durable history when a follow-up thread cannot be resumed", async () => {
    const sandbox = fakeSandbox({ resumeError: true });
    const persistedThreadIds: string[] = [];
    const prepareBootstrapTurn = vi.fn(async () => ({
      task: "durable conversation history\n\ncurrent user request",
    }));

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "current user request",
      prepareBootstrapTurn,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_missing",
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onEngineSessionId: async (threadId) => {
        persistedThreadIds.push(threadId);
      },
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    expect(sandbox.sentMessages().find((message) => message.method === "turn/start")).toMatchObject(
      {
        params: {
          input: [
            {
              type: "text",
              text: "durable conversation history\n\ncurrent user request",
              text_elements: [],
            },
          ],
        },
      },
    );
    expect(persistedThreadIds).toEqual(["thread_started"]);
    expect(prepareBootstrapTurn).toHaveBeenCalledOnce();
    expect(summary.sessionId).toBe("thread_started");
  });

  it("reattaches to the original active turn without starting a duplicate", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "active" });

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "recovery fallback only",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_existing",
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(summary).toMatchObject({ status: "success", result: "Codex completed." });
  });

  it("reattaches an unpersisted turn only when it is absent from the durable baseline", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "active" });
    const persistedTurnIds: string[] = [];

    await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "recovery fallback only",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: null,
      existingEngineTurnBaselineIds: [],
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onEngineTurnId: async (turnId) => {
        persistedTurnIds.push(turnId);
      },
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(persistedTurnIds).toEqual(["turn_existing"]);
  });

  it("does not adopt an unrelated active turn from before the durable baseline", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "active" });
    const onRecoveryStart = vi.fn(async () => undefined);

    await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "inspect state before continuing",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: null,
      existingEngineTurnBaselineIds: ["turn_existing"],
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onRecoveryStart,
      onActivity: async () => undefined,
    });

    expect(onRecoveryStart).toHaveBeenCalledOnce();
    expect(sandbox.sentMethods()).toContain("turn/start");
  });

  it("reattaches a guarded replacement when the prior engine id is unavailable", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "active" });
    const onRecoveryStart = vi.fn(async () => undefined);

    await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "inspect state before continuing",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_missing",
      existingEngineTurnBaselineIds: [],
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onRecoveryStart,
      onActivity: async () => undefined,
    });

    expect(onRecoveryStart).not.toHaveBeenCalled();
    expect(sandbox.sentMethods()).not.toContain("turn/start");
  });

  it("bootstraps a guarded recovery turn when the prior thread cannot be resumed", async () => {
    // A hard worker death mid-turn (e.g. a deploy that SIGKILLs the pod before it can hand off) can
    // leave the sandbox's thread state unresumable. Recovery must continue with a fresh guarded turn
    // instead of throwing, which previously surfaced as a terminal "Response stopped".
    const sandbox = fakeSandbox({ resumeError: true });
    const onRecoveryStart = vi.fn(async () => undefined);
    const persistedThreadIds: string[] = [];
    const persistedTurnIds: string[] = [];
    const prepareBootstrapTurn = vi.fn(async () => ({
      task: "durable conversation history\n\ncontinue the migration",
    }));

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "continue the migration",
      prepareBootstrapTurn,
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_existing",
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onEngineSessionId: async (threadId) => {
        persistedThreadIds.push(threadId);
      },
      onEngineTurnId: async (turnId) => {
        persistedTurnIds.push(turnId);
      },
      onRecoveryStart,
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    // The recovery guard still runs, so a genuine poison loop is bounded by the recovery ceiling.
    expect(onRecoveryStart).toHaveBeenCalledOnce();
    expect(prepareBootstrapTurn).toHaveBeenCalledOnce();
    expect(persistedThreadIds).toEqual(["thread_started"]);
    expect(persistedTurnIds).toEqual(["turn_1"]);
    expect(sandbox.sentMessages().find((message) => message.method === "turn/start")).toMatchObject(
      {
        params: {
          input: [
            {
              type: "text",
              text: "durable conversation history\n\ncontinue the migration",
              text_elements: [],
            },
          ],
        },
      },
    );
    expect(summary).toMatchObject({ status: "success", result: "Codex completed." });
  });

  it("reconciles a completion missed while no runner was connected", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "completed" });

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "recovery fallback only",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_existing",
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onActivity: async () => undefined,
    });

    expect(sandbox.sentMethods()).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(summary).toMatchObject({ status: "success", result: "Already finished." });
  });

  it("reads rather than resets goal state while reattaching", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "completed" });

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "finish the goal",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      goalMode: { objective: "Finish the goal" },
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_existing",
      reattachExistingTurn: true,
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
      "thread/goal/get",
    ]);
    expect(summary).toMatchObject({
      status: "success",
      goal: { objective: "Finish the goal", status: "complete" },
    });
  });

  it("starts one guarded recovery only when the original turn is unavailable", async () => {
    const sandbox = fakeSandbox({ resumedTurn: "active" });
    const onRecoveryStart = vi.fn(async () => undefined);

    await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "inspect state before continuing",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
      existingEngineSessionId: "thread_existing",
      existingEngineTurnId: "turn_missing",
      reattachExistingTurn: true,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => undefined,
      onRecoveryStart,
      onActivity: async () => undefined,
    });

    expect(onRecoveryStart).toHaveBeenCalledOnce();
    expect(sandbox.sentMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
  });

  it("detaches from a handed-off turn without interrupting Codex", async () => {
    vi.useFakeTimers();
    const sandbox = fakeSandbox({ completeTurn: false });
    const handoff = new Error("runner handoff");
    try {
      const running = runCodexAppServerTurn({
        sandbox: sandbox as never,
        codexWorkRoot,
        codexHome,
        skillFingerprint: "skills_a",
        task: "keep running",
        model: "gpt-5.5",
        reasoningEffort: "high",
        planModeReasoningEffort: null,
        existingEngineSessionId: null,
        auth: apiAuth,
        githubAuth: { githubToken: null, githubAuthHeader: null },
        timeoutMs: 60_000,
        checkAbort: async () => {
          throw handoff;
        },
        detachOnAbort: (error) => error === handoff,
        onRuntimeEvents: async () => undefined,
        onActivity: async () => undefined,
      });
      const rejection = running.then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(rejection).resolves.toBe(handoff);
      expect(sandbox.sentMethods()).not.toContain("turn/interrupt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles server-initiated user-input requests and returns the answer", async () => {
    const sandbox = fakeSandbox({ requestUserInput: true });
    const callOrder: string[] = [];
    const onServerRequest = vi.fn(async () => {
      callOrder.push("request");
      return {
        answers: { scope: { answers: ["Foundational"] } },
      };
    });

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "trace plan mode",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: "high",
      existingEngineSessionId: null,
      auth: apiAuth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
      timeoutMs: 60_000,
      checkAbort: async () => undefined,
      onRuntimeEvents: async () => {
        callOrder.push("events");
      },
      onServerRequest,
      onActivity: async () => undefined,
    });

    expect(onServerRequest).toHaveBeenCalledWith({
      id: "server_question_1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread_started",
        turnId: "turn_1",
        itemId: "question_1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How broad should the fix be?",
            options: [{ label: "Foundational", description: "Harden the full path." }],
          },
        ],
      },
    });
    expect(sandbox.sentMessages()).toContainEqual({
      id: "server_question_1",
      result: { answers: { scope: { answers: ["Foundational"] } } },
    });
    expect(callOrder.slice(0, 2)).toEqual(["events", "request"]);
    expect(summary).toMatchObject({ status: "success", result: "Codex completed." });
  });

  it("registers dynamic tools on new threads and handles host tool calls", async () => {
    const sandbox = fakeSandbox({ requestDynamicTool: true });
    const runtimeEvents: Record<string, unknown>[] = [];
    const execute = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: '{"hits":[]}' }],
    }));

    const summary = await runCodexAppServerTurn({
      sandbox: sandbox as never,
      codexWorkRoot,
      codexHome,
      skillFingerprint: "skills_a",
      task: "search the Brain",
      dynamicTools: [
        {
          spec: {
            type: "function",
            name: "goat_brain",
            description: "Read the Brain.",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
          execute,
        },
      ],
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: null,
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

    expect(
      sandbox.sentMessages().find((message) => message.method === "thread/start"),
    ).toMatchObject({
      params: {
        dynamicTools: [
          {
            type: "function",
            name: "goat_brain",
            description: "Read the Brain.",
          },
        ],
      },
    });
    expect(execute).toHaveBeenCalledWith({
      threadId: "thread_started",
      turnId: "turn_1",
      callId: "call_brain_1",
      namespace: null,
      tool: "goat_brain",
      arguments: { command: "query", flags: { text: "pricing" } },
    });
    expect(sandbox.sentMessages()).toContainEqual({
      id: "server_dynamic_1",
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: '{"hits":[]}' }],
      },
    });
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "item/started",
          params: expect.objectContaining({
            item: expect.objectContaining({ type: "dynamicToolCall", tool: "goat_brain" }),
          }),
        }),
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({
              type: "dynamicToolCall",
              tool: "goat_brain",
              success: true,
            }),
          }),
        }),
      ]),
    );
    expect(summary).toMatchObject({ status: "success", result: "Codex completed." });
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

type FakeProxyMessage = {
  method?: string;
  params?: unknown;
  id?: number | string;
  result?: unknown;
  error?: unknown;
};

type FakeSandboxOptions = {
  completeTurn?: boolean;
  completeGoalDelayMs?: number;
  requestDynamicTool?: boolean;
  requestUserInput?: boolean;
  resumeError?: boolean;
  resumedTurn?: "active" | "completed";
};

function fakeSandbox(options: FakeSandboxOptions = {}) {
  const files = new Map<string, string>();
  let proxyStdout: ((data: string) => void | Promise<void>) | null = null;
  let nextPid = 100;
  const commands: string[] = [];
  const commandRuns: Array<{
    command: string;
    options?: {
      background?: boolean;
      stdin?: boolean;
      timeoutMs?: number;
      onStdout?: (data: string) => void | Promise<void>;
    };
  }> = [];
  const messages: FakeProxyMessage[] = [];

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
          timeoutMs?: number;
          onStdout?: (data: string) => void | Promise<void>;
        },
      ) => {
        commands.push(command);
        commandRuns.push({ command, ...(options ? { options } : {}) });
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
          const message = JSON.parse(line) as FakeProxyMessage;
          messages.push(message);
          await respondToProxyMessage(message, proxyStdout, options);
        }
      },
      kill: async () => true,
    },
    sentMethods: () => messages.flatMap((message) => (message.method ? [message.method] : [])),
    sentMessages: () => messages,
    startedCommands: () => commands,
    startedCommandRuns: () => commandRuns,
  };

  return sandbox;
}

async function respondToProxyMessage(
  message: FakeProxyMessage,
  onStdout: ((data: string) => void | Promise<void>) | null,
  options: FakeSandboxOptions,
) {
  if (!onStdout || message.id == null) return;
  if (message.id === "server_question_1" && options.requestUserInput) {
    await completeFakeTurn(onStdout, "thread_started");
    return;
  }
  if (message.id === "server_dynamic_1" && options.requestDynamicTool) {
    await onStdout(
      `${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread_started",
          turnId: "turn_1",
          item: {
            id: "dynamic_1",
            type: "dynamicToolCall",
            tool: "goat_brain",
            arguments: { command: "query", flags: { text: "pricing" } },
            status: "completed",
            success: true,
            contentItems: [{ type: "inputText", text: '{"hits":[]}' }],
          },
        },
      })}\n`,
    );
    await completeFakeTurn(onStdout, "thread_started");
    return;
  }
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
    if (options.resumeError) {
      await onStdout(
        `${JSON.stringify({
          id: message.id,
          error: { code: -32600, message: "Thread not found" },
        })}\n`,
      );
      return;
    }
    const resumedTurn =
      options.resumedTurn === "active"
        ? { id: "turn_existing", status: "inProgress", items: [] }
        : options.resumedTurn === "completed"
          ? {
              id: "turn_existing",
              status: "completed",
              items: [{ id: "item_existing", type: "agentMessage", text: "Already finished." }],
            }
          : null;
    await onStdout(
      `${JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: "thread_existing",
            ...(resumedTurn ? { turns: [resumedTurn] } : {}),
          },
        },
      })}\n`,
    );
    if (options.resumedTurn === "active") {
      await completeFakeTurn(onStdout, "thread_existing", "turn_existing");
    }
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
  if (message.method === "thread/goal/get") {
    await onStdout(
      `${JSON.stringify({
        id: message.id,
        result: {
          goal: {
            objective: "Finish the goal",
            status: "complete",
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
    if (options.requestUserInput) {
      await onStdout(
        `${JSON.stringify({
          method: "item/plan/delta",
          params: { threadId, turnId: "turn_1", itemId: "plan_1", delta: "1. Inspect" },
        })}\n`,
      );
      await onStdout(
        `${JSON.stringify({
          id: "server_question_1",
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId: "turn_1",
            itemId: "question_1",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "How broad should the fix be?",
                options: [{ label: "Foundational", description: "Harden the full path." }],
              },
            ],
          },
        })}\n`,
      );
      return;
    }
    if (options.requestDynamicTool) {
      await onStdout(
        `${JSON.stringify({
          method: "item/started",
          params: {
            threadId,
            turnId: "turn_1",
            item: {
              id: "dynamic_1",
              type: "dynamicToolCall",
              tool: "goat_brain",
              arguments: { command: "query", flags: { text: "pricing" } },
              status: "inProgress",
            },
          },
        })}\n`,
      );
      await onStdout(
        `${JSON.stringify({
          id: "server_dynamic_1",
          method: "item/tool/call",
          params: {
            threadId,
            turnId: "turn_1",
            callId: "call_brain_1",
            namespace: null,
            tool: "goat_brain",
            arguments: { command: "query", flags: { text: "pricing" } },
          },
        })}\n`,
      );
      return;
    }
    await completeFakeTurn(onStdout, threadId);
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

async function completeFakeTurn(
  onStdout: (data: string) => void | Promise<void>,
  threadId: string,
  turnId = "turn_1",
) {
  await onStdout(
    `${JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item_1", delta: "Codex completed." },
    })}\n`,
  );
  await onStdout(
    `${JSON.stringify({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    })}\n`,
  );
}
