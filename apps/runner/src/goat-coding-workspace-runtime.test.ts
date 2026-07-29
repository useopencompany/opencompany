import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOAT_CODING_WORKSPACE_SANDBOX_NETWORK,
  isAllowedPreviewPort,
  mintGoatCodingWorkspaceAccess,
  parseListeningPorts,
} from "./goat-coding-workspace-runtime";
import { verifyGoatCodingWorkspaceTicket } from "./goat-coding-workspace-runtime-auth";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  sandboxStatus: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({
    select: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.limit = vi.fn(async () => mocks.rows);
      return builder;
    },
  }),
}));

vi.mock("./sandbox", () => ({
  getSandboxLifecycleStatus: mocks.sandboxStatus,
}));

const secret = "test-secret-at-least-long-enough";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.sandboxStatus.mockResolvedValue("running");
});

describe("Goat coding workspace preview port discovery", () => {
  it("keeps raw sandbox traffic private for every coding engine", () => {
    expect(GOAT_CODING_WORKSPACE_SANDBOX_NETWORK).toEqual({
      allowPublicTraffic: false,
      maskRequestHost: "localhost:${PORT}",
    });
  });

  it("normalizes, de-duplicates, and filters listening ports", () => {
    expect(parseListeningPorts("5173\n3000\n22\n50005\n3000\n65536\nnot-a-port\n8080")).toEqual([
      5_173, 3_000, 8_080,
    ]);
  });

  it("rejects privileged, internal, non-integer, and out-of-range ports", () => {
    expect(isAllowedPreviewPort(80)).toBe(false);
    expect(isAllowedPreviewPort(49_983)).toBe(false);
    expect(isAllowedPreviewPort(50_005)).toBe(false);
    expect(isAllowedPreviewPort(3_000.5)).toBe(false);
    expect(isAllowedPreviewPort(65_536)).toBe(false);
    expect(isAllowedPreviewPort(3_000)).toBe(true);
  });
});

describe("Goat coding workspace access", () => {
  it.each([
    "codex",
    "claude_code",
  ] as const)("mints owner-bound access for %s sessions", async (engine) => {
    mocks.rows = [runtimeSession({ engine })];

    const access = await mintGoatCodingWorkspaceAccess({
      codingSessionId: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
      userWorkosId: "user_1",
      env: { streamTokenSecret: secret },
    });

    expect(access.sandboxStatus).toBe("running");
    expect(
      verifyGoatCodingWorkspaceTicket({
        ticket: access.ticket,
        secret,
      }),
    ).toMatchObject({
      codingSessionId: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
      userWorkosId: "user_1",
    });
  });

  it.each([
    ["foreign or missing", [], 404],
    ["closed", [runtimeSession({ status: "closed" })], 404],
    ["unsupported", [runtimeSession({ engine: "opencompany" })], 404],
    ["missing sandbox", [runtimeSession({ sandboxId: null })], 409],
  ])("rejects %s sessions", async (_case, rows, statusCode) => {
    mocks.rows = rows;

    await expect(
      mintGoatCodingWorkspaceAccess({
        codingSessionId: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
        userWorkosId: "user_1",
        env: { streamTokenSecret: secret },
      }),
    ).rejects.toMatchObject({ statusCode });
  });

  it("returns an explicit lifecycle error for deleted sandboxes", async () => {
    mocks.rows = [runtimeSession()];
    mocks.sandboxStatus.mockResolvedValue("deleted");

    await expect(
      mintGoatCodingWorkspaceAccess({
        codingSessionId: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
        userWorkosId: "user_1",
        env: { streamTokenSecret: secret },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("deleted"),
    });
  });
});

function runtimeSession(
  overrides: Partial<{
    sandboxId: string | null;
    status: string;
    engine: string;
  }> = {},
) {
  return {
    id: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
    chatSessionId: "goat_chat_1",
    userWorkosId: "user_1",
    sandboxId: "sandbox_1",
    status: "idle",
    engine: "codex",
    ...overrides,
  };
}
