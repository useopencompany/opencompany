import { agentSessions } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeCodexPlanModeForLease, resumableCodexSessionId } from "./codex-session";

vi.mock("./db", () => ({
  getDb: () => globalThis.__codexSessionTestDb,
}));

declare global {
  // eslint-disable-next-line no-var
  var __codexSessionTestDb: unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__codexSessionTestDb = undefined;
});

describe("consumeCodexPlanModeForLease", () => {
  it("clears the one-shot Codex plan mode latch under the active run lease", async () => {
    const returning = vi.fn(async () => [{ id: "ses_123" }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    globalThis.__codexSessionTestDb = { update };

    await consumeCodexPlanModeForLease({
      sessionId: "ses_123",
      leaseId: "lease_123",
      leaseOwner: "runner-a",
    });

    expect(update).toHaveBeenCalledWith(agentSessions);
    expect(set).toHaveBeenCalledWith({
      codexPlanModeEnabled: false,
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledWith({ id: agentSessions.id });
  });
});

describe("resumableCodexSessionId", () => {
  it("keeps a Codex session id from failed turns so retry messages can resume context", () => {
    expect(
      resumableCodexSessionId({
        sessionId: "019efe9c-a0a5-7f81-98a4-6fab601b4a76",
      }),
    ).toBe("019efe9c-a0a5-7f81-98a4-6fab601b4a76");
  });

  it("does not persist a missing Codex session id", () => {
    expect(resumableCodexSessionId({ sessionId: null })).toBeNull();
  });
});
