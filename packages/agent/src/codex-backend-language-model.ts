import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider";
import {
  CodexCredentialNeedsReauthError,
  loadFreshCodexAccessToken,
  markCodexCredentialNeedsReauth,
} from "@opencompany/db/codex-auth";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_CLIENT_VERSION = "0.148.0";
const CODEX_PROVIDER_METADATA_KEY = "codex";

type DbLike = any;
type JsonRecord = Record<string, unknown>;

export class CodexApiError extends Error {
  constructor(message = "Codex API error. Try again or switch models.") {
    super(message);
    this.name = "CodexApiError";
  }
}

export class CodexUsageLimitError extends CodexApiError {
  constructor(retryAfter: string | null) {
    const retryAfterLabel = safeRetryAfterLabel(retryAfter);
    super(
      retryAfterLabel
        ? `ChatGPT usage limit reached — try again after ${retryAfterLabel} or switch models.`
        : "ChatGPT usage limit reached — try again later or switch models.",
    );
    this.name = "CodexUsageLimitError";
  }
}

function safeRetryAfterLabel(value: string | null) {
  const trimmed = value?.trim() ?? "";
  if (/^\d{1,8}$/u.test(trimmed)) return `${trimmed} seconds`;
  const timestamp = Date.parse(trimmed);
  return trimmed && Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : null;
}

export function createCodexBackendLanguageModel(input: {
  modelId: string;
  providerUserWorkosId: string;
  db: DbLike;
  fetchImpl?: typeof fetch;
}): LanguageModelV2 {
  const backendModelId = input.modelId.replace(/^openai\//, "");
  const fetchImpl = input.fetchImpl ?? fetch;

  const doStream: LanguageModelV2["doStream"] = async (options) => {
    const body = codexRequestBody(backendModelId, options);
    const response = await codexFetch({
      body,
      db: input.db,
      providerUserWorkosId: input.providerUserWorkosId,
      fetchImpl,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (!response.body) throw new CodexApiError();
    return {
      stream: codexResponseStream(response.body, options.includeRawChunks === true),
      request: { body },
    };
  };

  return {
    specificationVersion: "v2",
    provider: "codex-subscription",
    modelId: input.modelId,
    supportedUrls: { "image/*": [/^data:/, /^https:\/\//] },
    doStream,
    async doGenerate(options) {
      const result = await doStream(options);
      const content: Array<
        | { kind: "text"; id: string; text: string; metadata?: SharedV2ProviderMetadata }
        | { kind: "reasoning"; id: string; text: string; metadata?: SharedV2ProviderMetadata }
        | { kind: "content"; value: LanguageModelV2Content }
      > = [];
      const textParts = new Map<string, (typeof content)[number]>();
      const reasoningParts = new Map<string, (typeof content)[number]>();
      let finishReason: LanguageModelV2FinishReason = "unknown";
      let usage = emptyUsage();
      let responseMetadata: { id?: string; timestamp?: Date; modelId?: string } | undefined;

      for await (const part of readableStreamValues(result.stream)) {
        if (part.type === "text-start") {
          const item = { kind: "text" as const, id: part.id, text: "" };
          textParts.set(part.id, item);
          content.push(item);
        } else if (part.type === "text-delta") {
          const item = textParts.get(part.id);
          if (item?.kind === "text") item.text += part.delta;
        } else if (part.type === "text-end") {
          const item = textParts.get(part.id);
          if (item?.kind === "text" && part.providerMetadata) {
            item.metadata = part.providerMetadata;
          }
        } else if (part.type === "reasoning-start") {
          const item = { kind: "reasoning" as const, id: part.id, text: "" };
          reasoningParts.set(part.id, item);
          content.push(item);
        } else if (part.type === "reasoning-delta") {
          const item = reasoningParts.get(part.id);
          if (item?.kind === "reasoning") item.text += part.delta;
        } else if (part.type === "reasoning-end") {
          const item = reasoningParts.get(part.id);
          if (item?.kind === "reasoning" && part.providerMetadata) {
            item.metadata = part.providerMetadata;
          }
        } else if (part.type === "tool-call") {
          content.push({ kind: "content", value: part });
        } else if (part.type === "response-metadata") {
          responseMetadata = {
            ...(part.id ? { id: part.id } : {}),
            ...(part.timestamp ? { timestamp: part.timestamp } : {}),
            ...(part.modelId ? { modelId: part.modelId } : {}),
          };
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = part.usage;
        } else if (part.type === "error") {
          throw part.error;
        }
      }

      return {
        content: content.flatMap((part): LanguageModelV2Content[] => {
          if (part.kind === "content") return [part.value];
          if (part.kind === "text") {
            return part.text
              ? [
                  {
                    type: "text",
                    text: part.text,
                    ...(part.metadata ? { providerMetadata: part.metadata } : {}),
                  },
                ]
              : [];
          }
          return [
            {
              type: "reasoning",
              text: part.text,
              ...(part.metadata ? { providerMetadata: part.metadata } : {}),
            },
          ];
        }),
        finishReason,
        usage,
        warnings: [],
        ...(responseMetadata ? { response: responseMetadata } : {}),
        ...(result.request ? { request: result.request } : {}),
      };
    },
  };
}

async function codexFetch(input: {
  body: JsonRecord;
  signal?: AbortSignal;
  db: DbLike;
  providerUserWorkosId: string;
  fetchImpl: typeof fetch;
}) {
  let credential = await loadFreshCodexAccessToken({
    db: input.db,
    userWorkosId: input.providerUserWorkosId,
    fetchImpl: input.fetchImpl,
  });
  let response = await safeCodexRequest(input, credential);
  if (response.status === 401) {
    credential = await loadFreshCodexAccessToken({
      db: input.db,
      userWorkosId: input.providerUserWorkosId,
      rejectedAccessToken: credential.accessToken,
      fetchImpl: input.fetchImpl,
    });
    response = await safeCodexRequest(input, credential);
    if (response.status === 401) {
      await markCodexCredentialNeedsReauth({
        db: input.db,
        userWorkosId: input.providerUserWorkosId,
        statusReason: "Codex authentication was rejected. Reconnect Codex in opencompany settings.",
      });
      throw new CodexCredentialNeedsReauthError();
    }
  }
  if (response.status === 429) {
    throw new CodexUsageLimitError(response.headers.get("retry-after"));
  }
  if (!response.ok) throw new CodexApiError();
  return response;
}

async function safeCodexRequest(
  input: Parameters<typeof sendCodexRequest>[0],
  credential: Parameters<typeof sendCodexRequest>[1],
) {
  try {
    return await sendCodexRequest(input, credential);
  } catch {
    // Fetch implementations can attach request objects to network failures.
    // Replace them with a stable error so bearer headers can never reach logs,
    // traces, persisted debug state, or the UI.
    throw new CodexApiError();
  }
}

function sendCodexRequest(
  input: {
    body: JsonRecord;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
  },
  credential: { accessToken: string; accountId: string },
) {
  const url = new URL(CODEX_BACKEND_URL);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  return input.fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${credential.accessToken}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      "chatgpt-account-id": credential.accountId,
      originator: "opencompany",
      version: CODEX_CLIENT_VERSION,
    },
    body: JSON.stringify(input.body),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function codexRequestBody(model: string, options: LanguageModelV2CallOptions): JsonRecord {
  const instructions = options.prompt
    .flatMap((message) => (message.role === "system" ? [message.content.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const request: JsonRecord = {
    model,
    instructions: instructions || "You are a helpful assistant.",
    input: responseInput(options),
    tools: responseTools(options),
    tool_choice: responseToolChoice(options),
    parallel_tool_calls: true,
    reasoning: {
      effort: reasoningEffort(options),
      summary: "auto",
    },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (options.responseFormat?.type === "json" && options.responseFormat.schema) {
    request.text = {
      format: {
        type: "json_schema",
        name: options.responseFormat.name || "response",
        schema: options.responseFormat.schema,
        strict: true,
      },
    };
  }
  // maxOutputTokens is intentionally unsupported by the Codex backend and is
  // omitted instead of forwarding a value that the endpoint rejects.
  return request;
}

function responseInput(options: LanguageModelV2CallOptions): JsonRecord[] {
  const items: JsonRecord[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: message.content.map((part) =>
          part.type === "text"
            ? { type: "input_text", text: part.text }
            : { type: "input_image", image_url: fileDataUrl(part.data, part.mediaType) },
        ),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type === "reasoning") {
        const encryptedContent = codexMetadataString(part.providerOptions, "encryptedContent");
        if (encryptedContent) {
          items.push({
            type: "reasoning",
            encrypted_content: encryptedContent,
            summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
          });
        }
      } else if (part.type === "text") {
        if (part.text) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text, annotations: [] }],
          });
        }
      } else if (part.type === "tool-call") {
        items.push({
          type: "function_call",
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input ?? {}),
        });
      } else if (part.type === "tool-result") {
        items.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolOutputText(part.output),
        });
      }
    }
  }
  return items;
}

function responseTools(options: LanguageModelV2CallOptions) {
  return (options.tools ?? []).flatMap((tool) =>
    tool.type === "function"
      ? [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          },
        ]
      : [],
  );
}

function responseToolChoice(options: LanguageModelV2CallOptions): unknown {
  const choice = options.toolChoice;
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "none" || choice.type === "required") return choice.type;
  return { type: "function", name: choice.toolName };
}

function reasoningEffort(options: LanguageModelV2CallOptions) {
  const openai = options.providerOptions?.openai;
  const value = openai?.reasoningEffort;
  return typeof value === "string" && ["low", "medium", "high", "xhigh"].includes(value)
    ? value
    : "medium";
}

function codexResponseStream(body: ReadableStream<Uint8Array>, includeRaw: boolean) {
  return new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      const state = createStreamState(controller, includeRaw);
      try {
        for await (const event of parseSseJson(body)) {
          if (includeRaw) controller.enqueue({ type: "raw", rawValue: event });
          projectCodexEvent(event, state);
        }
        if (!state.finished)
          throw new CodexApiError("Codex API error: the response stream ended early.");
        controller.close();
      } catch (error) {
        controller.enqueue({ type: "error", error });
        controller.close();
      }
    },
  });
}

function createStreamState(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  includeRaw: boolean,
) {
  return {
    controller,
    includeRaw,
    textStarted: new Set<string>(),
    textEnded: new Set<string>(),
    reasoningStarted: new Set<string>(),
    reasoningEnded: new Set<string>(),
    calls: new Map<
      string,
      { callId: string; name: string; arguments: string; finished: boolean }
    >(),
    responseId: undefined as string | undefined,
    responseModel: undefined as string | undefined,
    finished: false,
  };
}

type StreamState = ReturnType<typeof createStreamState>;

function projectCodexEvent(event: JsonRecord, state: StreamState) {
  const type = stringValue(event.type);
  if (type === "response.created") {
    const response = recordValue(event.response);
    state.responseId = stringValue(response?.id) ?? undefined;
    state.responseModel = stringValue(response?.model) ?? undefined;
    state.controller.enqueue({
      type: "response-metadata",
      ...(state.responseId ? { id: state.responseId } : {}),
      ...(state.responseModel ? { modelId: state.responseModel } : {}),
      ...(numberValue(response?.created_at) !== null
        ? { timestamp: new Date((numberValue(response?.created_at) ?? 0) * 1000) }
        : {}),
    });
    return;
  }
  if (type === "response.output_item.added") {
    const item = recordValue(event.item);
    if (item?.type === "reasoning") ensureReasoningStarted(itemId(event, item), state);
    if (item?.type === "function_call") beginFunctionCall(item, state);
    return;
  }
  if (type === "response.output_text.delta") {
    const id = itemId(event);
    ensureTextStarted(id, state);
    state.controller.enqueue({ type: "text-delta", id, delta: stringValue(event.delta) ?? "" });
    return;
  }
  if (type === "response.output_text.done") {
    endText(itemId(event), state);
    return;
  }
  if (type === "response.reasoning_summary_text.delta") {
    const id = itemId(event);
    ensureReasoningStarted(id, state);
    state.controller.enqueue({
      type: "reasoning-delta",
      id,
      delta: stringValue(event.delta) ?? "",
    });
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const call = findFunctionCall(event, state);
    if (!call) return;
    const delta = stringValue(event.delta) ?? "";
    call.arguments += delta;
    state.controller.enqueue({ type: "tool-input-delta", id: call.callId, delta });
    return;
  }
  if (type === "response.function_call_arguments.done") {
    finishFunctionCall(event, state);
    return;
  }
  if (type === "response.output_item.done") {
    const item = recordValue(event.item);
    if (item?.type === "reasoning") finishReasoningItem(itemId(event, item), item, state);
    if (item?.type === "function_call") finishFunctionCall(item, state);
    if (item?.type === "message") finishMessageItem(itemId(event, item), item, state);
    return;
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const response = recordValue(event.response) ?? {};
    const output = Array.isArray(response.output) ? response.output : [];
    const hasToolCalls = output.some((item) => recordValue(item)?.type === "function_call");
    state.controller.enqueue({
      type: "finish",
      usage: responseUsage(recordValue(response.usage)),
      finishReason: responseFinishReason(response, hasToolCalls),
      providerMetadata: { [CODEX_PROVIDER_METADATA_KEY]: { costSource: "subscription_covered" } },
    });
    state.finished = true;
    return;
  }
  if (type === "response.failed" || type === "error") {
    const error = recordValue(event.error) ?? recordValue(recordValue(event.response)?.error);
    const code = stringValue(error?.code) ?? "";
    if (code.includes("usage_limit") || code.includes("rate_limit")) {
      throw new CodexUsageLimitError(null);
    }
    throw new CodexApiError();
  }
}

function beginFunctionCall(item: JsonRecord, state: StreamState) {
  const itemKey = stringValue(item.id) ?? stringValue(item.call_id) ?? crypto.randomUUID();
  const callId = stringValue(item.call_id) ?? itemKey;
  const name = stringValue(item.name) ?? "unknown_tool";
  const call = {
    callId,
    name,
    arguments: stringValue(item.arguments) ?? "",
    finished: false,
  };
  state.calls.set(itemKey, call);
  state.calls.set(callId, call);
  state.controller.enqueue({ type: "tool-input-start", id: callId, toolName: name });
  if (call.arguments) {
    state.controller.enqueue({ type: "tool-input-delta", id: callId, delta: call.arguments });
  }
}

function findFunctionCall(event: JsonRecord, state: StreamState) {
  const key = stringValue(event.item_id) ?? stringValue(event.call_id);
  return key ? state.calls.get(key) : undefined;
}

function finishFunctionCall(event: JsonRecord, state: StreamState) {
  let call = findFunctionCall(event, state);
  if (!call && (event.type === "function_call" || event.name)) {
    beginFunctionCall(event, state);
    call = findFunctionCall(event, state);
  }
  if (!call || call.finished) return;
  const completeArguments = stringValue(event.arguments);
  if (completeArguments !== null && completeArguments !== call.arguments) {
    const remainder = completeArguments.startsWith(call.arguments)
      ? completeArguments.slice(call.arguments.length)
      : completeArguments;
    if (remainder) {
      state.controller.enqueue({ type: "tool-input-delta", id: call.callId, delta: remainder });
    }
    call.arguments = completeArguments;
  }
  call.finished = true;
  state.controller.enqueue({ type: "tool-input-end", id: call.callId });
  state.controller.enqueue({
    type: "tool-call",
    toolCallId: call.callId,
    toolName: call.name,
    input: call.arguments || "{}",
  });
}

function finishReasoningItem(id: string, item: JsonRecord, state: StreamState) {
  ensureReasoningStarted(id, state);
  if (state.reasoningEnded.has(id)) return;
  state.reasoningEnded.add(id);
  const encryptedContent = stringValue(item.encrypted_content);
  state.controller.enqueue({
    type: "reasoning-end",
    id,
    ...(encryptedContent
      ? {
          providerMetadata: {
            [CODEX_PROVIDER_METADATA_KEY]: { encryptedContent },
          },
        }
      : {}),
  });
}

function finishMessageItem(id: string, item: JsonRecord, state: StreamState) {
  if (state.textEnded.has(id)) return;
  const content = Array.isArray(item.content) ? item.content : [];
  for (const partValue of content) {
    const part = recordValue(partValue);
    const text = part?.type === "output_text" ? stringValue(part.text) : null;
    if (text !== null && !state.textStarted.has(id)) {
      ensureTextStarted(id, state);
      if (text) state.controller.enqueue({ type: "text-delta", id, delta: text });
    }
  }
  if (state.textStarted.has(id)) endText(id, state);
}

function ensureTextStarted(id: string, state: StreamState) {
  if (state.textStarted.has(id)) return;
  state.textStarted.add(id);
  state.controller.enqueue({ type: "text-start", id });
}

function endText(id: string, state: StreamState) {
  ensureTextStarted(id, state);
  if (state.textEnded.has(id)) return;
  state.textEnded.add(id);
  state.controller.enqueue({ type: "text-end", id });
}

function ensureReasoningStarted(id: string, state: StreamState) {
  if (state.reasoningStarted.has(id)) return;
  state.reasoningStarted.add(id);
  state.controller.enqueue({ type: "reasoning-start", id });
}

async function* parseSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          const value: unknown = JSON.parse(data);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            yield value as JsonRecord;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* readableStreamValues<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function responseUsage(usage: JsonRecord | null): LanguageModelV2Usage {
  const inputTokens = numberValue(usage?.input_tokens) ?? 0;
  const outputTokens = numberValue(usage?.output_tokens) ?? 0;
  const inputDetails = recordValue(usage?.input_tokens_details);
  const outputDetails = recordValue(usage?.output_tokens_details);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberValue(usage?.total_tokens) ?? inputTokens + outputTokens,
    cachedInputTokens: numberValue(inputDetails?.cached_tokens) ?? 0,
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens) ?? 0,
  };
}

function emptyUsage(): LanguageModelV2Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function responseFinishReason(
  response: JsonRecord,
  hasToolCalls: boolean,
): LanguageModelV2FinishReason {
  const incomplete = recordValue(response.incomplete_details);
  if (stringValue(incomplete?.reason) === "max_output_tokens") return "length";
  if (stringValue(response.status) === "failed") return "error";
  return hasToolCalls ? "tool-calls" : "stop";
}

function toolOutputText(output: unknown) {
  const value = recordValue(output);
  if (!value) return JSON.stringify(output ?? null);
  if (value.type === "text" || value.type === "error-text") return stringValue(value.value) ?? "";
  return JSON.stringify(value.value ?? null);
}

function fileDataUrl(data: string | Uint8Array | URL, mediaType: string) {
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") {
    return data.startsWith("data:") || data.startsWith("https://")
      ? data
      : `data:${mediaType};base64,${data}`;
  }
  return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
}

function codexMetadataString(options: unknown, key: string) {
  const providerOptions = recordValue(options);
  const codex = recordValue(providerOptions?.[CODEX_PROVIDER_METADATA_KEY]);
  return stringValue(codex?.[key]);
}

function itemId(event: JsonRecord, item?: JsonRecord | null) {
  return (
    stringValue(event.item_id) ??
    stringValue(item?.id) ??
    stringValue(item?.call_id) ??
    `item_${numberValue(event.output_index) ?? 0}`
  );
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
