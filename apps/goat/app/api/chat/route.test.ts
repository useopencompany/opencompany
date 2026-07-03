import { streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { runGoatBrainCliForUser } from "@/lib/brain-cli";
import { createGoatChatUserTurn } from "@/lib/chat";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/brain-cli", () => ({
  runGoatBrainCliForUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(() => ({})),
  createGoatChatUserTurn: vi.fn(),
  newGoatChatMessageId: vi.fn(() => "assistant_1"),
  persistGoatChatAssistantMessage: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  createGoatTaskForUser: vi.fn(),
}));

vi.mock("ai", () => ({
  convertToModelMessages: vi.fn(async () => []),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((count: number) => ({ count })),
  streamText: vi.fn(),
  tool: vi.fn((definition: unknown) => definition),
}));

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
  });

  it("rejects unauthenticated requests", async () => {
    mockCurrentGoatUser().mockResolvedValue(null);

    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(401);
  });

  it("rejects malformed chat messages", async () => {
    mockAuth();

    const response = await POST(jsonRequest({ message: { role: "assistant" } }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid chat message.");
  });

  it("rejects oversized messages before model streaming", async () => {
    mockAuth();

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "x".repeat(GOAT_CHAT_PROMPT_MAX_LENGTH + 1) }],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Messages can be at most");
  });

  it("wires the personal brain CLI tool into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockRunGoatBrainCliForUser().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "No issues found.",
      stderr: "",
    });
    let brainToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { goat_brain?: { execute?: unknown } } }).tools
        ?.goat_brain;
      if (typeof tool?.execute !== "function") {
        throw new Error("goat_brain execute function was not configured.");
      }
      brainToolPromise = tool.execute({ args: "doctor" }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const request = jsonRequest({
      model: "openai/gpt-5.4-mini",
      message: {
        id: "ui_user_1",
        role: "user",
        parts: [{ type: "text", text: "check my brain health" }],
      },
    });
    const response = await POST(request);
    await brainToolPromise;

    expect(response.status).toBe(200);
    expect(runGoatBrainCliForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      args: "doctor",
      gatewayApiKey: "test-key",
      signal: request.signal,
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://goat.test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function mockAuth() {
  mockCurrentGoatUser().mockResolvedValue({
    authUser: {
      id: "user_1",
      email: "user@example.com",
    } as never,
    user: {
      workosUserId: "user_1",
      email: "user@example.com",
      firstName: null,
      lastName: null,
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

function mockCreateTurn() {
  mockCreateGoatChatUserTurn().mockResolvedValue({
    session: {
      id: "session_1",
      model: "openai/gpt-5.4-mini",
    },
    userMessage: {
      id: "user_message_1",
    },
    messages: [],
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser as unknown as () => Promise<unknown>);
}

function mockCreateGoatChatUserTurn() {
  return vi.mocked(createGoatChatUserTurn as unknown as () => Promise<unknown>);
}

function mockRunGoatBrainCliForUser() {
  return vi.mocked(runGoatBrainCliForUser);
}

function mockStreamText() {
  return vi.mocked(streamText);
}
