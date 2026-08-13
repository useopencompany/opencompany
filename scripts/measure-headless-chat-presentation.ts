import { createApiApp } from "../apps/api/src/app";
import {
  consumeGoatOpenCompanyChatStream,
  type GoatOpenCompanyChatProjection,
} from "../apps/runner/src/goat-opencompany-chat";
import { RedisChatPresentationStream } from "../packages/chat-presentation/src/index";
import type { RunEvent } from "../packages/core/src/chat";
import { streamRunEvents } from "../packages/protocol/src/client";

const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) throw new Error("REDIS_URL is required for the presentation cadence measurement.");
const sampleCount = 90;

const runId = `run_measure_${Date.now()}`;
const assistantMessageId = `message_measure_${Date.now()}`;
const occurredAt = new Date();
const durableEvents: RunEvent[] = [
  {
    id: "event_1",
    runId,
    attemptId: "attempt_1",
    sequence: 1,
    type: "run.started",
    payload: { attemptNumber: 1 },
    createdAt: occurredAt,
  },
];
let terminal = false;
let sequence = 1;
const publisher = new RedisChatPresentationStream({ url: redisUrl });
const reader = new RedisChatPresentationStream({ url: redisUrl });
const chat = {
  async getRun() {
    return {
      id: runId,
      conversationId: "conversation_measure",
      triggerMessageId: "message_user_measure",
      status: terminal ? ("completed" as const) : ("running" as const),
      engine: "opencompany" as const,
      model: "measure/model",
      attemptCount: 1,
      createdAt: occurredAt,
      updatedAt: new Date(),
    };
  },
  async listRunEvents(_actor: unknown, input: { afterSequence: number }) {
    const events = durableEvents.filter((event) => event.sequence > input.afterSequence);
    return { events, nextSequence: events.at(-1)?.sequence ?? input.afterSequence };
  },
};
const app = createApiApp({
  chat: chat as never,
  attachments: { upload: async () => Promise.reject(new Error("not used")) },
  authenticate: async () => ({
    actor: {
      userId: "user_measure",
      workspaceId: "workspace_measure",
      role: "admin",
      permissions: ["chat:read"],
      authenticationMethod: "session",
    },
  }),
  identify: async () => ({
    userId: "measure-user",
    organizationId: "measure-organization",
    activeWorkspaceId: "measure-workspace",
    method: "session" as const,
  }),
  presentation: reader,
});

const providerTimes: number[] = [];
const presentationTimes: number[] = [];
const consumeSse = (async () => {
  for await (const event of streamRunEvents({
    baseUrl: "https://measure.opencompany.test",
    runId,
    fetch: ((input, init) => app.request(String(input), init)) as typeof fetch,
  })) {
    if (event.type === "message.presentation_delta") presentationTimes.push(performance.now());
  }
})();

const finalProjection = await consumeGoatOpenCompanyChatStream({
  fullStream: controlledProviderStream(providerTimes),
  signal: new AbortController().signal,
  sink: {
    present(delta) {
      publisher.publish({
        runId,
        attemptNumber: 1,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        type: "message.presentation_delta",
        payload: { messageId: assistantMessageId, ...delta },
      });
    },
    async project(projection: GoatOpenCompanyChatProjection) {
      const content = projection.parts
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("")
        .trim();
      durableEvents.push({
        id: `event_${sequence + 1}`,
        runId,
        attemptId: "attempt_1",
        sequence: ++sequence,
        type: "message.content_updated",
        payload: { messageId: assistantMessageId, content, complete: false },
        createdAt: new Date(),
      });
    },
    async recordStepUsage() {},
  },
});

await delay(100);
const finalContent = finalProjection.parts
  .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
  .join("")
  .trim();
durableEvents.push(
  {
    id: `event_${sequence + 1}`,
    runId,
    attemptId: "attempt_1",
    sequence: ++sequence,
    type: "message.content_updated",
    payload: { messageId: assistantMessageId, content: finalContent, complete: true },
    createdAt: new Date(),
  },
  {
    id: `event_${sequence + 1}`,
    runId,
    attemptId: "attempt_1",
    sequence: ++sequence,
    type: "run.completed",
    payload: { messageId: assistantMessageId },
    createdAt: new Date(),
  },
);
terminal = true;
await consumeSse;
if (presentationTimes.length !== providerTimes.length) {
  throw new Error(
    `Expected ${providerTimes.length} presentation samples, received ${presentationTimes.length}.`,
  );
}

const result = {
  sampleCount: presentationTimes.length,
  legacyDirectMs: summarizeIntervals(providerTimes),
  redisPresentationMs: summarizeIntervals(presentationTimes),
  redisDeliveryLatencyMs: summarizeValues(
    presentationTimes.map((time, index) => time - (providerTimes[index] ?? time)),
  ),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await Promise.all([publisher.close(), reader.close()]);

async function* controlledProviderStream(times: number[]) {
  yield { type: "text-start", id: "text_1" };
  for (let index = 0; index < sampleCount; index += 1) {
    await delay(50);
    times.push(performance.now());
    yield { type: "text-delta", id: "text_1", text: "x" };
  }
  yield { type: "text-end", id: "text_1" };
}

function summarizeIntervals(times: number[]) {
  return summarizeValues(times.slice(1).map((time, index) => time - (times[index] ?? time)));
}

function summarizeValues(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
