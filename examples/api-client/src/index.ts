import { randomUUID } from "node:crypto";
import {
  createApiClient,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  streamRunEvents,
} from "@opencompany/protocol";

const baseUrl = requiredEnv("OPENCOMPANY_API_URL");
const token = requiredEnv("OPENCOMPANY_API_TOKEN");
const authorizedFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};
const client = createApiClient(baseUrl, { fetch: authorizedFetch });

// The canonical API intentionally creates a Conversation atomically with its first Message.
const clientConversationId = `conversation_example_${randomUUID()}`;
const clientMessageId = `message_example_${randomUUID()}`;
const response = await client.v1.messages.$post({
  header: {
    "idempotency-key": clientMessageId,
    [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
  },
  json: {
    clientConversationId,
    clientMessageId,
    content: process.env.OPENCOMPANY_MESSAGE?.trim() || "Summarize what opencompany can do.",
    engine: { type: "opencompany", schemaVersion: 1 },
  },
});

if (!response.ok) throw await responseError(response);
const { data } = await response.json();
console.log(`Conversation ${data.conversationId} created; Run ${data.runId} accepted.`);

for await (const event of streamRunEvents({
  baseUrl,
  runId: data.runId,
  fetch: authorizedFetch,
})) {
  console.log(event.type, JSON.stringify(event.payload));
}

async function responseError(response: Response) {
  const body = await response.text();
  return new Error(`opencompany API returned ${response.status}: ${body.slice(0, 1_000)}`);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
