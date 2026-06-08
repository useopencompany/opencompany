import { agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRuntimeEvent } from "./events";
import {
  generateSessionTitle,
  generateSessionTitleForMessage,
  sanitizeSessionTitle,
} from "./session-title";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

const aiMocks = vi.hoisted(() => ({
  createGateway: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("ai", () => ({
  createGateway: aiMocks.createGateway,
  generateText: aiMocks.generateText,
}));

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
}));

const env = {
  databaseUrl: "postgres://example",
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  e2bApiKey: "e2b",
  vercelAiGatewayApiKey: "gateway",
  integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
  exaApiKey: undefined,
  xApiBearerToken: undefined,
  supadataApiKey: undefined,
  ampApiKey: undefined,
  e2bTemplate: undefined,
  ampE2bTemplate: undefined,
  e2bSandboxIdleTimeoutMs: 30_000,
  opencodeTimeoutMs: 1_200_000,
  toolArgRepairEnabled: false,
  jobLeaseTtlMs: 300_000,
  jobMaxLeaseBusyAttempts: 10,
  workerConcurrency: 2,
  port: 3040,
  allowedOrigins: ["https://app.example.com"],
  instanceId: "runner-test",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("sanitizeSessionTitle", () => {
  it("trims wrappers, whitespace, and trailing punctuation", () => {
    expect(sanitizeSessionTitle('  "Fix the billing import!!!"  ', "Fallback")).toBe(
      "Fix the billing import",
    );
  });

  it("falls back when the generated title is empty", () => {
    expect(sanitizeSessionTitle("...", "Plan onboarding flow")).toBe("Plan onboarding flow");
  });

  it("caps generated titles at 60 characters", () => {
    expect(sanitizeSessionTitle("A".repeat(80), "Fallback")).toBe(`${"A".repeat(57)}...`);
  });
});

describe("generateSessionTitle", () => {
  it("uses the prompt-derived fallback when model output is unusable", async () => {
    aiMocks.createGateway.mockReturnValue((model: string) => ({ model }));
    aiMocks.generateText.mockResolvedValue({ text: "..." });

    await expect(
      generateSessionTitle({
        content: "Explain revenue churn",
        fallbackTitle: "Explain revenue churn",
        apiKey: "gateway",
      }),
    ).resolves.toBe("Explain revenue churn");
  });
});

describe("generateSessionTitleForMessage", () => {
  it("updates the session title for the first user message", async () => {
    aiMocks.createGateway.mockReturnValue((model: string) => ({ model }));
    aiMocks.generateText.mockResolvedValue({ text: '"Analyze customer churn."' });
    const db = createTitleDb({
      sessionExists: true,
      firstUserMessage: {
        id: "msg_first",
        content: "Can you analyze customer churn by segment?",
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      generateSessionTitleForMessage({
        sessionId: "ses_123",
        messageId: "msg_first",
        env,
      }),
    ).resolves.toEqual({ ok: true, title: "Analyze customer churn" });

    expect(db.state.title).toBe("Analyze customer churn");
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_123",
        messageId: "msg_first",
        type: "session.title_updated",
        payload: { title: "Analyze customer churn" },
      }),
    );
  });

  it("skips later user messages", async () => {
    const db = createTitleDb({
      sessionExists: true,
      firstUserMessage: {
        id: "msg_first",
        content: "First request",
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      generateSessionTitleForMessage({
        sessionId: "ses_123",
        messageId: "msg_second",
        env,
      }),
    ).resolves.toEqual({ ok: false, skipped: "message_not_first_user_message" });

    expect(aiMocks.generateText).not.toHaveBeenCalled();
    expect(db.state.title).toBe("Untitled session");
    expect(appendRuntimeEvent).not.toHaveBeenCalled();
  });
});

function createTitleDb(input: {
  sessionExists: boolean;
  firstUserMessage: { id: string; content: string } | null;
}) {
  const state = {
    title: "Untitled session",
  };

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async limit() {
                      if (table !== agentSessionMessages || !input.firstUserMessage) return [];
                      return [input.firstUserMessage];
                    },
                  };
                },
                async limit() {
                  if (table !== agentSessions || !input.sessionExists) return [];
                  return [{ id: "ses_123" }];
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: { title?: string }) {
          return {
            where() {
              return {
                async returning() {
                  if (table !== agentSessions || !input.sessionExists) return [];
                  if (values.title) state.title = values.title;
                  return [{ id: "ses_123" }];
                },
              };
            },
          };
        },
      };
    },
  };
}
