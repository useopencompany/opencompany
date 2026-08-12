import type {
  GoatCodexChatSession,
  GoatCodexChatTurn,
  GoatTask,
} from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import {
  GoatCodexChatHandoffError,
  GoatCodexChatLeaseLostError,
  GoatCodexChatRetryableInfrastructureError,
} from "./goat-codex-chat-errors";
import {
  claimNextGoatCodexChatTurn,
  goatCodexChatLeaseTtlMs,
  goatCodexChatRetryAt,
  heartbeatGoatCodexChatTurn,
  resolveGoatCodexChatWorkerConcurrency,
  runClaimedTurn,
  startGoatCodexChatWorker,
  sweepTerminalGoatCodexChatSandboxes,
} from "./goat-codex-chat-worker";

const sessionRows = vi.hoisted(() => [] as GoatCodexChatSession[]);
const claimedTaskContext = vi.hoisted(() => ({
  task: null as GoatTask | null,
}));

const dbMock = vi.hoisted(() => {
  const db = {
    execute: vi.fn(),
    select: vi.fn(() => db),
    from: vi.fn(() => db),
    leftJoin: vi.fn(() => db),
    where: vi.fn(() => db),
    limit: vi.fn(async () =>
      sessionRows.map((session) => ({
        session,
        task: claimedTaskContext.task,
      })),
    ),
  };
  return db;
});

const chatMocks = vi.hoisted(() => ({
  runGoatCodexChatTurn: vi.fn(),
  runGoatOpenCompanyChatTurn: vi.fn(),
}));

const telemetry = vi.hoisted(() => ({
  recordGoatCounter: vi.fn(),
  recordGoatHistogram: vi.fn(),
}));
const sandboxMocks = vi.hoisted(() => ({
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeoutById: vi.fn(),
}));

vi.mock("@opencompany/goat-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/goat-observability")>();
  return {
    ...actual,
    recordGoatCounter: telemetry.recordGoatCounter,
    recordGoatHistogram: telemetry.recordGoatHistogram,
  };
});

const eventMocks = vi.hoisted(() => ({
  fail: vi.fn(),
  createGoatCodexChatProjector: vi.fn(() => ({ fail: eventMocks.fail })),
  loadCodexChatAssistantMessageParts: vi.fn(async () => []),
}));

vi.mock("./db", () => ({
  getDb: () => dbMock,
}));

vi.mock("./goat-codex-chat", () => ({
  runGoatCodexChatTurn: chatMocks.runGoatCodexChatTurn,
}));

vi.mock("./goat-opencompany-chat", () => ({
  runGoatOpenCompanyChatTurn: chatMocks.runGoatOpenCompanyChatTurn,
}));

vi.mock("./goat-codex-chat-events", () => ({
  createGoatCodexChatProjector: eventMocks.createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts: eventMocks.loadCodexChatAssistantMessageParts,
}));

vi.mock("./sandbox", () => ({
  armSandboxActiveTimeoutById: sandboxMocks.armSandboxActiveTimeoutById,
  armSandboxIdleTimeoutById: sandboxMocks.armSandboxIdleTimeoutById,
}));

describe("claimNextGoatCodexChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [claimedTurnRow()] });
  });

  it("atomically moves the claimed session from queued to starting", async () => {
    await expect(
      claimNextGoatCodexChatTurn({ leaseOwner: "runner_1", leaseTtlMs: 300_000 }),
    ).resolves.toMatchObject({ id: "goat_codex_chat_turn_1", status: "running", attempts: 1 });

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("claimed AS");
    expect(statement).toContain("UPDATE goat.codex_chat_sessions AS session");
    expect(statement).toContain("SET status = 'starting'");
  });

  it("only lets due delayed turns participate in claiming and per-session FIFO", async () => {
    await expect(
      claimNextGoatCodexChatTurn({ leaseOwner: "runner_1", leaseTtlMs: 300_000 }),
    ).resolves.toMatchObject({
      id: "goat_codex_chat_turn_1",
      runAfter: new Date("2026-07-10T08:59:00.000Z"),
    });

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement.match(/run_after IS NULL OR (?:turn|earlier)\.run_after <=/g)).toHaveLength(2);
    expect(statement).toContain("session.status <> 'closed'");
    expect(statement).toContain("chat.closed_at IS NULL");
  });

  it("returns no work when the database skips a not-yet-due turn", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await expect(
      claimNextGoatCodexChatTurn({ leaseOwner: "runner_1", leaseTtlMs: 300_000 }),
    ).resolves.toBeNull();
  });
});

describe("heartbeatGoatCodexChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renews a running turn only while no durable interrupt is requested", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [{ id: "goat_codex_chat_turn_1" }] });

    await expect(
      heartbeatGoatCodexChatTurn({
        turnId: "goat_codex_chat_turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        leaseTtlMs: 300_000,
      }),
    ).resolves.toBe(true);

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain(
      "SET lease_id = CASE WHEN interrupt_requested_at IS NULL THEN lease_id ELSE NULL END",
    );
    expect(statement).toContain(
      "lease_owner = CASE WHEN interrupt_requested_at IS NULL THEN lease_owner ELSE NULL END",
    );
    expect(statement).toContain("WITH heartbeat AS");
    expect(statement).toContain("WHEN interrupt_requested_at IS NULL THEN");
    expect(statement).toContain("WHERE interrupt_requested_at IS NULL");
  });

  it("expires the current lease and reports ownership lost after a durable interrupt", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await expect(
      heartbeatGoatCodexChatTurn({
        turnId: "goat_codex_chat_turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        leaseTtlMs: 300_000,
      }),
    ).resolves.toBe(false);

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("ELSE NULL END");
    expect(statement).toContain("WHEN lease_expires_at IS NULL OR lease_expires_at >");
    expect(statement).toContain("ELSE lease_expires_at");
    expect(statement).toContain("SELECT id");
    expect(statement).toContain("WHERE interrupt_requested_at IS NULL");
  });
});

describe("resolveGoatCodexChatWorkerConcurrency", () => {
  it("uses the runner-wide concurrency by default", () => {
    expect(resolveGoatCodexChatWorkerConcurrency({ workerConcurrency: 40 })).toBe(40);
  });

  it("honors an explicit test override", () => {
    expect(resolveGoatCodexChatWorkerConcurrency({ workerConcurrency: 40 }, 2)).toBe(2);
  });
});

describe("goatCodexChatLeaseTtlMs", () => {
  it("uses the dedicated durable chat lease when configured", () => {
    expect(
      goatCodexChatLeaseTtlMs({
        jobLeaseTtlMs: 300_000,
        goatCodexChatLeaseTtlMs: 90_000,
      }),
    ).toBe(90_000);
  });

  it("falls back to the generic job lease for older env fixtures", () => {
    expect(goatCodexChatLeaseTtlMs({ jobLeaseTtlMs: 300_000 })).toBe(300_000);
  });
});

describe("Goat Codex chat worker shutdown", () => {
  it("reclaims an interrupted silent turn and then runs the queued successor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:00.000Z"));
    const claimedTurnIds: string[] = [];
    let firstClaimed = false;
    let interruptHeartbeatObserved = false;
    let interruptedTurnReclaimed = false;
    let successorClaimed = false;
    dbMock.execute.mockImplementation(async (query) => {
      const statement = sqlText(query);
      if (statement.includes("WITH candidate AS")) {
        if (!firstClaimed) {
          firstClaimed = true;
          const row = claimedTurnRow();
          claimedTurnIds.push(row.id);
          return { rows: [row] };
        }
        if (!interruptHeartbeatObserved) return { rows: [] };
        if (!interruptedTurnReclaimed) {
          interruptedTurnReclaimed = true;
          const row = {
            ...claimedTurnRow(),
            attempts: 2,
            lease_id: "lease_2",
            interrupt_requested_at: "2026-07-10T09:00:05.000Z",
          };
          claimedTurnIds.push(row.id);
          return { rows: [row] };
        }
        if (!successorClaimed) {
          successorClaimed = true;
          const row = {
            ...claimedTurnRow(),
            id: "goat_codex_chat_turn_2",
            user_message_id: "goat_chat_msg_user_2",
            assistant_message_id: "goat_chat_msg_assistant_2",
            codex_turn_id: null,
            lease_id: "lease_3",
            interrupt_requested_at: null,
            created_at: "2026-07-10T09:00:01.000Z",
          };
          claimedTurnIds.push(row.id);
          return { rows: [row] };
        }
        return { rows: [] };
      }
      if (statement.includes("WITH heartbeat AS")) {
        interruptHeartbeatObserved = true;
        return { rows: [] };
      }
      return { rows: [{ id: "updated" }] };
    });
    sessionRows.length = 0;
    sessionRows.push(session());
    claimedTaskContext.task = null;
    let releaseSilentTurn: (() => void) | undefined;
    chatMocks.runGoatCodexChatTurn
      .mockImplementationOnce(
        () =>
          new Promise<"settled">((resolve) => {
            releaseSilentTurn = () => resolve("settled");
          }),
      )
      .mockResolvedValue("settled");

    const worker = startGoatCodexChatWorker(env({ jobLeaseTtlMs: 15_000 }), {
      concurrency: 1,
      pollIntervalMs: 50,
    });

    try {
      await vi.waitFor(() => expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_050);
      await vi.waitFor(() => expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledTimes(3));

      expect(claimedTurnIds).toEqual([
        "goat_codex_chat_turn_1",
        "goat_codex_chat_turn_1",
        "goat_codex_chat_turn_2",
      ]);
      expect(chatMocks.runGoatCodexChatTurn.mock.calls[1]?.[0]).toMatchObject({
        turn: expect.objectContaining({
          id: "goat_codex_chat_turn_1",
          attempts: 2,
          interruptRequestedAt: new Date("2026-07-10T09:00:05.000Z"),
        }),
      });
    } finally {
      releaseSilentTurn?.();
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("lets active turns finish during the drain window without handing them off", async () => {
    vi.clearAllMocks();
    let claimed = false;
    dbMock.execute.mockImplementation(async (query) => {
      if (sqlText(query).includes("WITH candidate AS")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedTurnRow()] };
      }
      return { rows: [{ id: "updated" }] };
    });
    sessionRows.length = 0;
    sessionRows.push(session());
    let finishTurn: (() => void) | undefined;
    chatMocks.runGoatCodexChatTurn.mockImplementationOnce(
      () =>
        new Promise<"settled">((resolve) => {
          finishTurn = () => resolve("settled");
        }),
    );
    const onHandoff = vi.fn();
    const worker = startGoatCodexChatWorker(env(), { concurrency: 1, pollIntervalMs: 50 });

    await vi.waitFor(() => expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledOnce());
    const stopping = worker.stop({
      handoffAfterMs: 1_000,
      postHandoffWaitMs: 1_000,
      onHandoff,
    });
    finishTurn?.();
    await stopping;

    expect(onHandoff).not.toHaveBeenCalled();
    expect(worker.activeCount()).toBe(0);
    expect(
      dbMock.execute.mock.calls.some(([query]) => sqlText(query).includes("SET lease_id = NULL")),
    ).toBe(false);
  });

  it("bounds shutdown and hands active turns to the next worker", async () => {
    vi.clearAllMocks();
    let claimed = false;
    dbMock.execute.mockImplementation(async (query) => {
      const statement = sqlText(query);
      if (statement.includes("WITH candidate AS")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedTurnRow()] };
      }
      return { rows: [{ id: "updated" }] };
    });
    sessionRows.length = 0;
    sessionRows.push(session());
    chatMocks.runGoatCodexChatTurn.mockImplementationOnce(async (input) => {
      while (!input.shouldAbort()) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(input.shouldAbort()).toBeInstanceOf(GoatCodexChatHandoffError);
      return "handed_off";
    });
    const onHandoff = vi.fn();
    const worker = startGoatCodexChatWorker(env(), { concurrency: 1, pollIntervalMs: 50 });

    await vi.waitFor(() => expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledOnce());
    await worker.stop({
      handoffAfterMs: 1,
      postHandoffWaitMs: 1_000,
      onHandoff,
    });

    expect(onHandoff).toHaveBeenCalledWith(1);
    expect(sqlText(dbMock.execute.mock.calls.at(-1)?.[0])).toContain("SET lease_id = NULL");
  });

  it("expires the lease after the post-handoff deadline when setup cannot observe the abort", async () => {
    vi.clearAllMocks();
    let claimed = false;
    dbMock.execute.mockImplementation(async (query) => {
      if (sqlText(query).includes("WITH candidate AS")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedTurnRow()] };
      }
      return { rows: [{ id: "updated" }] };
    });
    sessionRows.length = 0;
    sessionRows.push(session());
    let finishTurn: (() => void) | undefined;
    chatMocks.runGoatCodexChatTurn.mockImplementationOnce(
      () =>
        new Promise<"settled">((resolve) => {
          finishTurn = () => resolve("settled");
        }),
    );
    const worker = startGoatCodexChatWorker(env(), { concurrency: 1, pollIntervalMs: 50 });

    await vi.waitFor(() => expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledOnce());
    await expect(worker.stop({ handoffAfterMs: 1, postHandoffWaitMs: 1 })).resolves.toBeUndefined();
    expect(worker.activeCount()).toBe(1);
    expect(
      dbMock.execute.mock.calls.some(([query]) => sqlText(query).includes("SET lease_id = NULL")),
    ).toBe(true);

    finishTurn?.();
    await vi.waitFor(() => expect(worker.activeCount()).toBe(0));
  });
});

describe("terminal Goat Codex sandbox reconciliation", () => {
  it("parks a terminal sandbox left active by a hard runner stop", async () => {
    vi.clearAllMocks();
    dbMock.execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "session_1",
            sandbox_id: "sbx_1",
            updated_at: "2026-07-10T12:00:00.000Z",
            chat_kind: "chat",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "session_1" }] });
    sandboxMocks.armSandboxIdleTimeoutById.mockResolvedValueOnce(true);

    await expect(sweepTerminalGoatCodexChatSandboxes({ idleTimeoutMs: 300_000 })).resolves.toBe(1);

    expect(sqlText(dbMock.execute.mock.calls[0]?.[0])).toContain("sandbox_id IS NOT NULL");
    expect(sandboxMocks.armSandboxIdleTimeoutById).toHaveBeenCalledWith("sbx_1", 300_000);
    expect(sqlText(dbMock.execute.mock.calls[1]?.[0])).toContain("sandbox_timeout_armed_at");
  });

  it("caps terminal task sandbox reconciliation at 5 minutes", async () => {
    vi.clearAllMocks();
    dbMock.execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "session_1",
            sandbox_id: "sbx_1",
            updated_at: "2026-07-10T12:00:00.000Z",
            chat_kind: "task",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "session_1" }] });
    sandboxMocks.armSandboxIdleTimeoutById.mockResolvedValueOnce(true);

    await expect(
      sweepTerminalGoatCodexChatSandboxes({ idleTimeoutMs: 30 * 60 * 1000 }),
    ).resolves.toBe(1);

    expect(sqlText(dbMock.execute.mock.calls[0]?.[0])).toContain(
      "INNER JOIN goat.chat_sessions AS chat",
    );
    expect(sandboxMocks.armSandboxIdleTimeoutById).toHaveBeenCalledWith("sbx_1", 300_000);
  });

  it("restores the active timeout when a new turn wins the reconciliation race", async () => {
    vi.clearAllMocks();
    dbMock.execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "session_1",
            sandbox_id: "sbx_1",
            updated_at: "2026-07-10T12:00:00.000Z",
            chat_kind: "chat",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "running" }] });
    sandboxMocks.armSandboxIdleTimeoutById.mockResolvedValueOnce(true);
    sandboxMocks.armSandboxActiveTimeoutById.mockResolvedValueOnce(true);

    await expect(sweepTerminalGoatCodexChatSandboxes({ idleTimeoutMs: 300_000 })).resolves.toBe(1);

    expect(sandboxMocks.armSandboxActiveTimeoutById).toHaveBeenCalledWith("sbx_1");
  });
});

describe("runClaimedTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRows.length = 0;
    sessionRows.push(session());
    chatMocks.runGoatCodexChatTurn.mockResolvedValue(undefined);
    chatMocks.runGoatOpenCompanyChatTurn.mockResolvedValue(undefined);
    dbMock.execute.mockResolvedValue({ rows: [{ id: "updated" }] });
  });

  it("runs first attempts normally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:05.000Z"));
    try {
      await runClaimedTurn(turn({ attempts: 1 }), env());
    } finally {
      vi.useRealTimers();
    }

    const input = chatMocks.runGoatCodexChatTurn.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        turn: expect.objectContaining({ attempts: 1 }),
        canonicalAttemptId: "updated",
      }),
    );
    expect(input).not.toHaveProperty("recovery");
    expect(dbMock.select).toHaveBeenCalledOnce();
    expect(dbMock.leftJoin).toHaveBeenCalledOnce();
    expect(
      dbMock.execute.mock.calls.some(([query]) =>
        sqlText(query).includes("INSERT INTO goat.run_attempts"),
      ),
    ).toBe(true);
    expect(
      dbMock.execute.mock.calls.some(([query]) =>
        sqlText(query).includes("INSERT INTO goat.run_events"),
      ),
    ).toBe(true);
    expect(telemetry.recordGoatHistogram).toHaveBeenCalledWith(
      "goat.codex_chat.queue_wait_ms",
      5_000,
      {
        "goat.engine": "codex",
        "goat.model": "gpt-5.5",
        "goat.status": "running",
        "goat.attempt": 1,
      },
    );
  });

  it("does not count a scheduled delay as queue wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:05.000Z"));
    try {
      await runClaimedTurn(
        turn({
          attempts: 1,
          createdAt: new Date("2026-07-10T08:00:00.000Z"),
          runAfter: new Date("2026-07-10T09:00:00.000Z"),
        }),
        env(),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(telemetry.recordGoatHistogram).toHaveBeenCalledWith(
      "goat.codex_chat.queue_wait_ms",
      5_000,
      expect.any(Object),
    );
  });

  it("dispatches OpenCompany turns without coding-engine recovery state", async () => {
    sessionRows.length = 0;
    sessionRows.push(session({ engine: "opencompany", model: "anthropic/claude-sonnet-5" }));

    await runClaimedTurn(
      turn({
        attempts: 2,
        codexTurnId: "legacy-value-that-must-be-ignored",
        engineRecoveryRequired: true,
      }),
      env(),
    );

    expect(chatMocks.runGoatOpenCompanyChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ engine: "opencompany" }),
        turn: expect.objectContaining({ attempts: 2 }),
      }),
    );
    expect(chatMocks.runGoatOpenCompanyChatTurn.mock.calls[0]?.[0]).not.toHaveProperty("recovery");
    expect(chatMocks.runGoatCodexChatTurn).not.toHaveBeenCalled();
  });

  it("propagates heartbeat lease loss into an active OpenCompany stream", async () => {
    vi.useFakeTimers();
    sessionRows.length = 0;
    sessionRows.push(session({ engine: "opencompany", model: "anthropic/claude-sonnet-5" }));
    dbMock.execute.mockImplementation(async (query) =>
      sqlText(query).includes("WITH heartbeat AS") ? { rows: [] } : { rows: [{ id: "updated" }] },
    );
    chatMocks.runGoatOpenCompanyChatTurn.mockImplementationOnce(
      (input) =>
        new Promise<"settled">((_resolve, reject) => {
          const timer = setInterval(() => {
            const error = input.shouldAbort();
            if (!error) return;
            clearInterval(timer);
            reject(error);
          }, 10);
        }),
    );

    try {
      const running = runClaimedTurn(turn(), env({ jobLeaseTtlMs: 15_000 }));
      const outcome = running.catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_020);
      await expect(outcome).resolves.toBeInstanceOf(GoatCodexChatLeaseLostError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a persisted engine turn across the migration rollout", async () => {
    await runClaimedTurn(turn({ attempts: 2, engineRecoveryRequired: false }), env());

    expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ attempts: 2 }),
        recovery: { reason: "lease_reclaimed" },
      }),
    );
    expect(eventMocks.fail).not.toHaveBeenCalled();
    expect(telemetry.recordGoatHistogram).not.toHaveBeenCalled();
  });

  it("recovers after crossing the engine boundary before an id was persisted", async () => {
    await runClaimedTurn(
      turn({
        attempts: 3,
        codexTurnId: null,
        engineRecoveryRequired: true,
      }),
      env(),
    );

    expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ attempts: 3 }),
        recovery: { reason: "lease_reclaimed" },
      }),
    );
    expect(eventMocks.fail).not.toHaveBeenCalled();
  });

  it("retries pre-engine acquisition failures as a fresh turn", async () => {
    await runClaimedTurn(
      turn({
        attempts: 2,
        codexTurnId: null,
        engineRecoveryRequired: false,
      }),
      env(),
    );

    const input = chatMocks.runGoatCodexChatTurn.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty("recovery");
  });

  it("releases its lease only after the Codex proxy reports a handoff", async () => {
    const handoff = new AbortController();
    handoff.abort();
    chatMocks.runGoatCodexChatTurn.mockImplementationOnce(async (input) => {
      expect(input.shouldAbort()).toBeInstanceOf(GoatCodexChatHandoffError);
      return "handed_off";
    });

    await runClaimedTurn(turn(), env(), { handoffSignal: handoff.signal });

    const release = sqlText(dbMock.execute.mock.calls.at(-1)?.[0]);
    expect(release).toContain("SET lease_id = NULL");
    expect(release).toContain("lease_owner = NULL");
    expect(release).toContain("status = 'running'");
  });

  it("defers transient infrastructure failures with durable backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:00.000Z"));
    try {
      const capacity = new Error("500: Failed to place sandbox");
      capacity.name = "SandboxError";
      chatMocks.runGoatCodexChatTurn.mockRejectedValueOnce(
        new GoatCodexChatRetryableInfrastructureError(
          "Codex sandbox capacity is temporarily unavailable.",
          capacity,
        ),
      );

      await runClaimedTurn(turn({ attempts: 1 }), env());
    } finally {
      vi.useRealTimers();
    }

    const deferred = sqlText(dbMock.execute.mock.calls.at(-1)?.[0]);
    expect(deferred).toContain("WITH deferred AS");
    expect(deferred).toContain("lease_id = NULL");
    expect(deferred).toContain("lease_owner = NULL");
    expect(deferred).toContain("lease_expires_at");
    expect(deferred).toContain("SET status = 'queued'");
    expect(eventMocks.fail).not.toHaveBeenCalled();
  });

  it("caps infrastructure retry backoff at one minute", () => {
    const now = new Date("2026-07-10T09:00:00.000Z");

    expect(goatCodexChatRetryAt(now, 1)).toEqual(new Date("2026-07-10T09:00:05.000Z"));
    expect(goatCodexChatRetryAt(now, 20)).toEqual(new Date("2026-07-10T09:01:00.000Z"));
  });
});

function claimedTurnRow() {
  return {
    id: "goat_codex_chat_turn_1",
    user_workos_id: "user_1",
    codex_chat_session_id: "goat_codex_chat_1",
    chat_session_id: "goat_chat_1",
    user_message_id: "goat_chat_msg_user",
    assistant_message_id: "goat_chat_msg_assistant",
    codex_turn_id: null,
    status: "running",
    prompt: "Fix the bug.",
    settings: {},
    error: null,
    interrupt_requested_at: null,
    attempts: 1,
    recovery_attempts: 0,
    engine_recovery_required: false,
    engine_turn_baseline_ids: null,
    lease_id: "lease_1",
    lease_owner: "runner_1",
    lease_expires_at: "2026-07-10T09:05:00.000Z",
    run_after: "2026-07-10T08:59:00.000Z",
    completed_at: null,
    created_at: "2026-07-10T09:00:00.000Z",
    updated_at: "2026-07-10T09:00:00.000Z",
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (
        chunk &&
        typeof chunk === "object" &&
        "value" in chunk &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        return ((chunk as { value: unknown[] }).value ?? []).join("");
      }
      return "";
    })
    .join("");
}

function turn(overrides: Partial<GoatCodexChatTurn> = {}): GoatCodexChatTurn {
  const now = new Date("2026-07-10T09:00:00.000Z");
  return {
    id: "goat_codex_chat_turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    userMessageId: "goat_chat_msg_user",
    assistantMessageId: "goat_chat_msg_assistant",
    codexTurnId: "turn_1",
    status: "running",
    prompt: "Fix the bug.",
    settings: {},
    error: null,
    interruptRequestedAt: null,
    attempts: 1,
    recoveryAttempts: 0,
    engineRecoveryRequired: false,
    engineTurnBaselineIds: null,
    eventSequence: 0,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-07-10T09:05:00.000Z"),
    runAfter: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function session(overrides: Partial<GoatCodexChatSession> = {}): GoatCodexChatSession {
  const now = new Date("2026-07-10T09:00:00.000Z");
  return {
    id: "goat_codex_chat_1",
    userWorkosId: "user_1",
    chatSessionId: "goat_chat_1",
    engine: "codex",
    model: "gpt-5.5",
    brainRef: null,
    workspaceId: null,
    hostToolContractVersion: null,
    sandboxId: "sbx_1",
    codexThreadId: "thread_1",
    activeTurnId: "goat_codex_chat_turn_1",
    status: "running",
    error: null,
    sandboxTimeoutArmedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    internalToken: "internal",
    streamTokenSecret: "stream",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex",
    exaApiKey: "exa",
    goatBrowserEnabled: false,
    codexE2bTemplate: undefined,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    goatCodexChatIdleTimeoutMs: 1_800_000,
    jobLeaseTtlMs: 300_000,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
