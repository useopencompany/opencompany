import { jsonSchema, type LanguageModelUsage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityEnvelope,
  type GoatCapabilityWorkerContext,
  type ResolvedGoatCapability,
} from "@/lib/capabilities/types";
import {
  clampEnvelope,
  ENVELOPE_MAX_ENTITIES,
  ENVELOPE_MAX_SUMMARY_CHARS,
  runGoatCapabilityWorker,
} from "@/lib/capabilities/worker";

const ATTRIBUTION = { user: "goat-test", tags: ["app:goat"] };

function makeUsage(inputTokens: number, outputTokens: number): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: 0 },
    totalTokens: inputTokens + outputTokens,
  };
}

function makeContext(signal?: AbortSignal): GoatCapabilityWorkerContext {
  return {
    userWorkosId: "user_1",
    signal: signal ?? new AbortController().signal,
    currentDate: new Date("2026-07-18T12:00:00.000Z"),
    userContext: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      timezone: "Europe/London",
    },
  };
}

function makeCapability(overrides: Partial<ResolvedGoatCapability> = {}): ResolvedGoatCapability {
  return {
    id: "slack",
    operations: ["read"],
    workerModel: "openai/gpt-5.4-mini",
    indexLine: "slack — reads things.",
    recipeLines: ["Use the fake tool once."],
    createTools: async () => ({
      tools: {
        fake_tool: {
          description: "A fake read tool.",
          inputSchema: jsonSchema<{ q: string }>({ type: "object" }),
          execute: async () => ({ ok: true, items: [1, 2] }),
        },
      },
    }),
    ...overrides,
  };
}

describe("runGoatCapabilityWorker", () => {
  it("runs the loop, finalizes an envelope, and sums usage across calls", async () => {
    const close = vi.fn(async () => {});
    const capability = makeCapability({
      createTools: async () => ({
        tools: {
          fake_tool: {
            description: "A fake read tool.",
            inputSchema: jsonSchema<{ q: string }>({ type: "object" }),
            execute: async () => ({ ok: true }),
          },
        },
        close,
      }),
    });

    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        system: string;
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
        onStepFinish?: (step: { usage: LanguageModelUsage }) => void;
      };
      expect(opts.system).toContain("focused read worker");
      expect(opts.system).toContain("Use the fake tool once.");
      expect(opts.system).toContain("Ada Lovelace (ada@example.com)");
      expect(opts.system).toContain("Current date: 2026-07-18");
      await opts.tools.fake_tool?.execute({ q: "pricing" }, { toolCallId: "t1", messages: [] });
      opts.onStepFinish?.({ usage: makeUsage(10, 5) });
      return { text: "Found two messages.", finishReason: "stop", steps: [] };
    });
    const generateObjectImpl = vi.fn(async (options: never) => {
      const opts = options as { prompt: string };
      expect(opts.prompt).toContain("<request>find pricing messages</request>");
      expect(opts.prompt).toContain("fake_tool");
      return {
        object: {
          summary: "Two messages discuss pricing.",
          entities: [{ type: "slack_message", id: "C1:1", url: "https://x.slack.com/1" }],
        },
        usage: makeUsage(3, 2),
      };
    });

    const result = await runGoatCapabilityWorker({
      capability,
      operation: "read",
      request: "find pricing messages",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.summary).toBe("Two messages discuss pricing.");
    expect(result.envelope.entities).toHaveLength(1);
    expect(result.envelope.error).toBeUndefined();
    expect(result.usage.inputTokens).toBe(13);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.debug.outcome).toBe("success");
    expect(result.debug.operation).toBe("read");
    expect(result.debug.steps).toBe(1);
    expect(result.debug.transcript).toHaveLength(1);
    expect(result.debug.transcript[0]?.tool).toBe("fake_tool");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("gives write workers a narrow authorization prompt", async () => {
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as { system: string };
      expect(opts.system).toContain("one explicitly requested change");
      expect(opts.system).toContain("only the exact external changes stated in the request");
      expect(opts.system).toContain("Never retry a mutation");
      expect(opts.system).not.toContain("All tools are read-only");
      return { text: "Created G-123.", finishReason: "stop", steps: [] };
    });
    const generateObjectImpl = vi.fn(async () => ({
      object: {
        summary: "Created G-123.",
        entities: [{ type: "linear_issue", id: "G-123" }],
      },
      usage: makeUsage(1, 1),
    }));

    const result = await runGoatCapabilityWorker({
      capability: makeCapability({
        id: "linear",
        operations: ["read", "write"],
      }),
      operation: "write",
      request: "Create one issue named Fix login.",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.summary).toBe("Created G-123.");
    expect(result.debug.operation).toBe("write");
  });

  it("rejects a write operation before creating tools for a read-only capability", async () => {
    const createTools = vi.fn(async () => ({ tools: {} }));
    const generateTextImpl = vi.fn();

    const result = await runGoatCapabilityWorker({
      capability: makeCapability({ createTools }),
      operation: "write",
      request: "Post a message.",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
    });

    expect(result.envelope.error?.code).toBe("invalid_request");
    expect(createTools).not.toHaveBeenCalled();
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it("maps auth errors from tool creation to an error envelope without model calls", async () => {
    const generateTextImpl = vi.fn();
    const capability = makeCapability({
      createTools: async () => {
        throw new GoatCapabilityAuthError("not_connected", "Slack is not connected.");
      },
    });

    const result = await runGoatCapabilityWorker({
      capability,
      operation: "read",
      request: "anything",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
    });

    expect(result.envelope.error?.code).toBe("not_connected");
    expect(result.envelope.error?.hint).toContain("not connected");
    expect(result.debug.outcome).toBe("error");
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it("terminates with auth_expired when a provider rejects a tool call", async () => {
    const close = vi.fn(async () => {});
    const generateObjectImpl = vi.fn();
    const capability = makeCapability({
      createTools: async () => ({
        tools: {
          revoked_tool: {
            description: "A provider tool with a revoked credential.",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new GoatCapabilityAuthError("auth_expired", "Reconnect the integration.");
            },
          },
        },
        close,
      }),
    });
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
      };
      await opts.tools.revoked_tool?.execute({}, { toolCallId: "t1", messages: [] });
      throw new Error("unreachable");
    });

    const result = await runGoatCapabilityWorker({
      capability,
      operation: "read",
      request: "anything",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope).toMatchObject({
      summary: "",
      error: { code: "auth_expired", hint: "Reconnect the integration." },
    });
    expect(result.debug.transcript[0]?.outputPreview).toContain("Reconnect the integration");
    expect(generateObjectImpl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns a timeout envelope without a finalizer call when the loop aborts empty", async () => {
    const parent = new AbortController();
    let workerSignal: AbortSignal | undefined;
    const generateObjectImpl = vi.fn();
    const generateTextImpl = vi.fn(async () => {
      parent.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    const result = await runGoatCapabilityWorker({
      capability: makeCapability({
        createTools: async (context) => {
          workerSignal = context.signal;
          return { tools: {} };
        },
      }),
      operation: "read",
      request: "anything",
      context: makeContext(parent.signal),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.error?.code).toBe("timeout");
    expect(workerSignal).not.toBe(parent.signal);
    expect(workerSignal?.aborted).toBe(true);
    expect(generateObjectImpl).not.toHaveBeenCalled();
  });

  it("skips the finalizer when the chat turn aborted after tools already ran", async () => {
    const parent = new AbortController();
    const generateObjectImpl = vi.fn();
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
      };
      await opts.tools.fake_tool?.execute({ q: "x" }, { toolCallId: "t1", messages: [] });
      parent.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    const result = await runGoatCapabilityWorker({
      capability: makeCapability(),
      operation: "read",
      request: "anything",
      context: makeContext(parent.signal),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.error?.code).toBe("timeout");
    expect(result.debug.transcript).toHaveLength(1);
    expect(generateObjectImpl).not.toHaveBeenCalled();
  });

  it("falls back to the worker's plain-text answer when the finalizer fails", async () => {
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
      };
      await opts.tools.fake_tool?.execute({ q: "x" }, { toolCallId: "t1", messages: [] });
      return {
        text: "The transcript covers the launch-week bug.",
        finishReason: "stop",
        steps: [],
      };
    });
    const generateObjectImpl = vi.fn(async () => {
      throw new Error("Invalid schema for response_format 'response'");
    });

    const result = await runGoatCapabilityWorker({
      capability: makeCapability(),
      operation: "read",
      request: "transcribe the video",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.summary).toBe("The transcript covers the launch-week bug.");
    expect(result.envelope.entities).toEqual([]);
    expect(result.envelope.error).toBeUndefined();
    expect(result.debug.outcome).toBe("partial");
  });

  it("strips schema-mandated nulls from finalized envelopes", async () => {
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
      };
      await opts.tools.fake_tool?.execute({ q: "x" }, { toolCallId: "t1", messages: [] });
      return { text: "done", finishReason: "stop", steps: [] };
    });
    // Strict structured outputs express optionality as null unions; the
    // envelope crossing back to the main model must not carry those nulls.
    const generateObjectImpl = vi.fn(async () => ({
      object: {
        summary: "One issue found.",
        entities: [{ type: "linear_issue", id: "ENG-1", url: null, title: null }],
        error: null,
      },
      usage: makeUsage(1, 1),
    }));

    const result = await runGoatCapabilityWorker({
      capability: makeCapability(),
      operation: "read",
      request: "anything",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.error).toBeUndefined();
    expect(result.envelope.entities).toEqual([{ type: "linear_issue", id: "ENG-1" }]);
    expect(result.debug.outcome).toBe("success");
  });

  it("returns a provider_error envelope when the loop fails before gathering anything", async () => {
    const close = vi.fn(async () => {});
    const generateObjectImpl = vi.fn();
    const generateTextImpl = vi.fn(async () => {
      throw new Error("gateway exploded");
    });

    const result = await runGoatCapabilityWorker({
      capability: makeCapability({
        createTools: async () => ({ tools: {}, close }),
      }),
      operation: "read",
      request: "anything",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.envelope.error?.code).toBe("provider_error");
    expect(result.envelope.error?.hint).toContain("gateway exploded");
    expect(close).toHaveBeenCalledTimes(1);
    expect(generateObjectImpl).not.toHaveBeenCalled();
  });

  it("records tool failures in the transcript instead of killing the loop", async () => {
    const capability = makeCapability({
      createTools: async () => ({
        tools: {
          fake_tool: {
            description: "A fake read tool.",
            inputSchema: jsonSchema<{ q: string }>({ type: "object" }),
            execute: async () => {
              throw new Error("slack said no");
            },
          },
        },
      }),
    });
    const generateTextImpl = vi.fn(async (options: never) => {
      const opts = options as {
        tools: Record<string, { execute: (args: unknown, o: unknown) => Promise<unknown> }>;
      };
      const output = await opts.tools.fake_tool?.execute({ q: "x" }, { toolCallId: "t1" });
      expect(output).toEqual({ error: "slack said no" });
      return { text: "The tool failed.", finishReason: "stop", steps: [] };
    });
    const generateObjectImpl = vi.fn(async () => ({
      object: {
        summary: "",
        entities: [],
        error: { code: "provider_error", hint: "Slack rejected the request." },
      },
      usage: makeUsage(1, 1),
    }));

    const result = await runGoatCapabilityWorker({
      capability,
      operation: "read",
      request: "anything",
      context: makeContext(),
      gatewayApiKey: "test-key",
      attribution: ATTRIBUTION,
      generateTextImpl: generateTextImpl as never,
      generateObjectImpl: generateObjectImpl as never,
    });

    expect(result.debug.transcript[0]?.outputPreview).toContain("slack said no");
    expect(result.envelope.error?.code).toBe("provider_error");
    expect(result.debug.outcome).toBe("partial");
  });
});

describe("clampEnvelope", () => {
  it("truncates the summary and slices entities", () => {
    const envelope = clampEnvelope(
      {
        summary: "x".repeat(ENVELOPE_MAX_SUMMARY_CHARS + 100),
        entities: Array.from({ length: ENVELOPE_MAX_ENTITIES + 4 }, (_, index) => ({
          type: "linear_issue",
          id: `ENG-${index}`,
        })),
      },
      "completed",
    );
    expect(envelope.summary).toHaveLength(ENVELOPE_MAX_SUMMARY_CHARS + 1); // +1 ellipsis
    expect(envelope.entities).toHaveLength(ENVELOPE_MAX_ENTITIES);
  });

  it("drops non-http urls and invalid entities, and coerces unknown error codes", () => {
    const envelope = clampEnvelope(
      {
        summary: "ok",
        entities: [
          { type: "slack_message", id: "C1:1", url: "javascript:alert(1)" },
          { type: "slack_message", id: "C1:2", url: "https://x.slack.com/2" },
          { type: "person" } as never,
        ],
        error: { code: "made_up_code" as never, hint: "?" },
      },
      "completed",
    );
    expect(envelope.entities).toHaveLength(2);
    expect(envelope.entities[0]?.url).toBeUndefined();
    expect(envelope.entities[1]?.url).toBe("https://x.slack.com/2");
    expect(envelope.error?.code).toBe("provider_error");
  });

  it("marks capped runs as partial even when the finalizer omitted the error", () => {
    const envelope: GoatCapabilityEnvelope = clampEnvelope(
      { summary: "partial findings", entities: [] },
      "step_cap",
    );
    expect(envelope.error?.code).toBe("step_cap");
  });
});
