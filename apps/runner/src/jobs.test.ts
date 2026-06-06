import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import {
  claimNextRunnerJob,
  type EnqueueRunnerJobInput,
  enqueueRunnerJob,
  RUNNER_JOB_HARD_ATTEMPT_CAP,
  RUNNER_JOB_MAX_ATTEMPTS,
  type RunnerJob,
  type RunnerJobHandlers,
  type RunnerJobStatus,
  type RunnerJobStore,
  runClaimedRunnerJob,
  startRunnerJobWorker,
} from "./jobs";
import { RunLeaseBusyError } from "./run-control";
import { MessageTurnFailedError, ToolStepLimitExceededError } from "./runner-errors";

afterEach(() => {
  vi.useRealTimers();
});

describe("runner job enqueue", () => {
  it("deduplicates all session lifecycle job kinds by idempotency key", async () => {
    const store = createMemoryRunnerJobStore();

    await enqueueRunnerJob({ kind: "start", sessionId: "ses_123" }, store);
    await enqueueRunnerJob({ kind: "start", sessionId: "ses_123" }, store);
    await enqueueRunnerJob({ kind: "message", sessionId: "ses_123", messageId: "msg_123" }, store);
    await enqueueRunnerJob({ kind: "title", sessionId: "ses_123", messageId: "msg_123" }, store);
    await enqueueRunnerJob(
      { kind: "after_session", sessionId: "ses_123", messageId: "msg_123" },
      store,
    );

    expect(store.jobs.map((job) => job.idempotencyKey).sort()).toEqual([
      "after_session:ses_123:msg_123",
      "message:ses_123:msg_123",
      "start:ses_123",
      "title:ses_123:msg_123",
    ]);
  });

  it("leaves running and completed duplicate nudges unchanged", async () => {
    const store = createMemoryRunnerJobStore();
    const running = await enqueueRunnerJob(
      { kind: "message", sessionId: "ses_123", messageId: "msg_123" },
      store,
    );
    running.status = "running";
    running.leaseId = "lease_123";
    running.leaseOwner = "runner-a";
    running.leaseExpiresAt = new Date("2026-05-27T12:05:00.000Z");

    await enqueueRunnerJob({ kind: "message", sessionId: "ses_123", messageId: "msg_123" }, store);

    expect(store.jobs).toHaveLength(1);
    expect(firstJob(store)).toMatchObject({
      status: "running",
      leaseId: "lease_123",
      leaseOwner: "runner-a",
    });

    firstJob(store).status = "completed";
    await enqueueRunnerJob({ kind: "message", sessionId: "ses_123", messageId: "msg_123" }, store);

    expect(store.jobs).toHaveLength(1);
    expect(firstJob(store).status).toBe("completed");
  });

  it("reactivates failed jobs for explicit retries", async () => {
    const store = createMemoryRunnerJobStore();
    const job = await enqueueRunnerJob(
      { kind: "message", sessionId: "ses_123", messageId: "msg_123" },
      store,
    );
    Object.assign(job, {
      status: "failed" satisfies RunnerJobStatus,
      attempts: RUNNER_JOB_MAX_ATTEMPTS,
      leaseId: "lease_123",
      leaseOwner: "runner-a",
      lastError: "boom",
    });

    await enqueueRunnerJob({ kind: "message", sessionId: "ses_123", messageId: "msg_123" }, store);

    expect(firstJob(store)).toMatchObject({
      status: "pending",
      attempts: 0,
      leaseId: null,
      leaseOwner: null,
      lastError: null,
    });
  });
});

describe("runner job claiming", () => {
  it("claims due pending jobs and expired running jobs only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const store = createMemoryRunnerJobStore([
      job({ id: 1, nextRunAt: new Date("2026-05-27T12:05:00.000Z") }),
      job({ id: 2, nextRunAt: new Date("2026-05-27T11:59:00.000Z") }),
      job({
        id: 3,
        status: "running",
        leaseExpiresAt: new Date("2026-05-27T12:05:00.000Z"),
      }),
      job({
        id: 4,
        status: "running",
        leaseExpiresAt: new Date("2026-05-27T11:59:00.000Z"),
      }),
      job({ id: 5, status: "completed" }),
    ]);

    await expect(claimNextRunnerJob({ leaseOwner: "runner-b", store })).resolves.toMatchObject({
      id: 2,
      status: "running",
      attempts: 1,
      leaseOwner: "runner-b",
    });
    await expect(claimNextRunnerJob({ leaseOwner: "runner-b", store })).resolves.toMatchObject({
      id: 4,
      status: "running",
      attempts: 1,
      leaseOwner: "runner-b",
    });
    await expect(claimNextRunnerJob({ leaseOwner: "runner-b", store })).resolves.toBeNull();
  });

  it("extends a running job lease with heartbeats", async () => {
    const store = createMemoryRunnerJobStore([
      job({ id: 1, status: "running", leaseId: "lease_123", leaseOwner: "runner-a" }),
    ]);
    const nextExpiry = new Date("2026-05-27T12:10:00.000Z");

    await expect(
      store.heartbeat({
        id: 1,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
        now: new Date("2026-05-27T12:00:00.000Z"),
        leaseExpiresAt: nextExpiry,
      }),
    ).resolves.toBe(true);

    expect(firstJob(store).leaseExpiresAt).toEqual(nextExpiry);
  });
});

describe("runner job execution", () => {
  it("marks successful jobs completed", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "start",
        status: "running",
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);
    const startSession = vi.fn(async () => undefined);

    await runClaimedRunnerJob({
      job: firstJob(store),
      env: env(),
      store,
      handlers: handlers({ startSession }),
    });

    expect(startSession).toHaveBeenCalledWith("ses_123", env());
    expect(firstJob(store)).toMatchObject({
      status: "completed",
      leaseId: null,
      leaseOwner: null,
    });
  });

  it("dispatches resume_approval with the toolCallId carried in messageId", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "resume_approval",
        messageId: "call_ask",
        status: "running",
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);
    const resumeApproval = vi.fn(async () => undefined);

    await runClaimedRunnerJob({
      job: firstJob(store),
      env: env(),
      store,
      handlers: handlers({ resumeApproval }),
    });

    expect(resumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_123", toolCallId: "call_ask", env: env() }),
    );
    expect(firstJob(store)).toMatchObject({ status: "completed" });
  });

  it("requeues failed jobs with backoff until the max attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: 1,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new Error("model unavailable");
          }),
        }),
      }),
    ).rejects.toThrow("model unavailable");

    expect(firstJob(store).status).toBe("pending");
    expect(firstJob(store).nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(firstJob(store).lastError).toBe("model unavailable");
  });

  it("marks non-retryable runner errors failed without requeueing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: 1,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new ToolStepLimitExceededError();
          }),
        }),
      }),
    ).rejects.toThrow("Agent reached the tool-step limit before producing a final answer.");

    expect(firstJob(store).status).toBe("failed");
    expect(firstJob(store).nextRunAt).toEqual(new Date("2026-05-27T12:00:00.000Z"));
    expect(firstJob(store).lastError).toBe(
      "Agent reached the tool-step limit before producing a final answer. Send another message to continue.",
    );
  });

  it("marks failed message turns failed without replaying side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: 1,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new MessageTurnFailedError(new Error("tool call JSON was invalid"));
          }),
        }),
      }),
    ).rejects.toThrow("tool call JSON was invalid");

    expect(firstJob(store).status).toBe("failed");
    expect(firstJob(store).nextRunAt).toEqual(new Date("2026-05-27T12:00:00.000Z"));
    expect(firstJob(store).lastError).toBe("tool call JSON was invalid");
  });

  it("marks failed resume turns failed without replaying side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "resume_question",
        status: "running",
        attempts: 1,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          resumeQuestionResponse: vi.fn(async () => {
            throw new MessageTurnFailedError(new Error("model stream dropped mid-turn"));
          }),
        }),
      }),
    ).rejects.toThrow("model stream dropped mid-turn");

    expect(firstJob(store).status).toBe("failed");
    expect(firstJob(store).nextRunAt).toEqual(new Date("2026-05-27T12:00:00.000Z"));
    expect(firstJob(store).lastError).toBe("model stream dropped mid-turn");
  });

  it("marks jobs failed after the max attempt", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: RUNNER_JOB_MAX_ATTEMPTS,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new Error("still broken");
          }),
        }),
      }),
    ).rejects.toThrow("still broken");

    expect(firstJob(store).status).toBe("failed");
    expect(firstJob(store).leaseId).toBeNull();
    expect(firstJob(store).lastError).toBe("still broken");
  });

  it("keeps lease-busy jobs pending even after the max attempt", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: RUNNER_JOB_MAX_ATTEMPTS,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new RunLeaseBusyError();
          }),
        }),
      }),
    ).rejects.toThrow(RunLeaseBusyError);

    expect(firstJob(store).status).toBe("pending");
    expect(firstJob(store).leaseId).toBeNull();
    expect(firstJob(store).lastError).toBe("Run lease is busy.");
  });

  it("gives up a pathologically re-claimed lease-busy job at the hard attempt cap", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "running",
        attempts: RUNNER_JOB_HARD_ATTEMPT_CAP,
        leaseId: "lease_123",
        leaseOwner: "runner-a",
      }),
    ]);

    await expect(
      runClaimedRunnerJob({
        job: firstJob(store),
        env: env(),
        store,
        handlers: handlers({
          runMessage: vi.fn(async () => {
            throw new RunLeaseBusyError();
          }),
        }),
      }),
    ).rejects.toThrow(RunLeaseBusyError);

    expect(firstJob(store).status).toBe("failed");
  });
});

describe("runner job worker wake", () => {
  it("claims a newly enqueued job on notify() instead of waiting for the poll interval", async () => {
    // A poll interval far longer than the test timeout proves the claim was driven by
    // notify(), not by the fallback poll.
    const store = createMemoryRunnerJobStore();
    const runMessage = vi.fn(async () => undefined);
    const worker = startRunnerJobWorker(env(), {
      store,
      handlers: handlers({ runMessage }),
      pollIntervalMs: 60_000,
    });

    try {
      // Let the worker run its initial claim pass (store is empty) and settle into its wait.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runMessage).not.toHaveBeenCalled();

      await enqueueRunnerJob(
        { kind: "message", sessionId: "ses_123", messageId: "msg_123" },
        store,
      );
      worker.notify();

      await vi.waitFor(() => expect(runMessage).toHaveBeenCalledOnce());
      expect(firstJob(store).status).toBe("completed");
    } finally {
      await worker.stop();
    }
  });
});

describe("runner job worker shutdown", () => {
  it("waits for active jobs to finish before stop resolves", async () => {
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "pending",
        nextRunAt: new Date("2026-05-27T00:00:00.000Z"),
      }),
    ]);
    const releaseRun = deferred<void>();
    const runMessage = vi.fn(async () => releaseRun.promise);
    const worker = startRunnerJobWorker(env(), {
      store,
      handlers: handlers({ runMessage }),
      pollIntervalMs: 50,
    });

    await vi.waitFor(() => expect(runMessage).toHaveBeenCalledOnce());

    let stopped = false;
    const stopPromise = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseRun.resolve();
    await stopPromise;

    expect(firstJob(store).status).toBe("completed");
    expect(stopped).toBe(true);
  });

  it("runs the interrupt hook when active jobs outlive the shutdown deadline", async () => {
    vi.useFakeTimers();
    const store = createMemoryRunnerJobStore([
      job({
        id: 1,
        kind: "message",
        status: "pending",
        nextRunAt: new Date("2026-05-27T00:00:00.000Z"),
      }),
    ]);
    const runMessage = vi.fn(async () => new Promise<void>(() => undefined));
    const onInterrupt = vi.fn();
    const worker = startRunnerJobWorker(env(), {
      store,
      handlers: handlers({ runMessage }),
      pollIntervalMs: 50,
    });

    await vi.waitFor(() => expect(runMessage).toHaveBeenCalledOnce());

    const stopPromise = worker.stop({ interruptAfterMs: 250, onInterrupt });
    await vi.advanceTimersByTimeAsync(250);
    await stopPromise;

    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(firstJob(store).status).toBe("running");
  });
});

function createMemoryRunnerJobStore(initialJobs: RunnerJob[] = []): RunnerJobStore & {
  jobs: RunnerJob[];
} {
  const jobs = [...initialJobs];
  let nextId = Math.max(0, ...jobs.map((item) => item.id)) + 1;

  return {
    jobs,
    async enqueue(input) {
      const existing = jobs.find((item) => item.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.status === "pending" || existing.status === "failed") {
          Object.assign(existing, {
            status: "pending" satisfies RunnerJobStatus,
            attempts: existing.status === "failed" ? 0 : existing.attempts,
            nextRunAt: input.now,
            leaseId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: input.now,
          });
        }
        return existing;
      }

      const created = job({
        id: nextId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        messageId: input.messageId ?? null,
        kind: input.kind,
        nextRunAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      });
      nextId += 1;
      jobs.push(created);
      return created;
    },
    async claimNext(input) {
      const claimable = jobs
        .filter(
          (item) =>
            (item.status === "pending" && item.nextRunAt <= input.now) ||
            (item.status === "running" &&
              item.leaseExpiresAt !== null &&
              item.leaseExpiresAt < input.now),
        )
        .sort(
          (left, right) =>
            left.nextRunAt.getTime() - right.nextRunAt.getTime() || left.id - right.id,
        )[0];
      if (!claimable) return null;

      Object.assign(claimable, {
        status: "running" satisfies RunnerJobStatus,
        attempts: claimable.attempts + 1,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      });
      return claimable;
    },
    async heartbeat(input) {
      const item = findLeasedJob(jobs, input);
      if (!item) return false;
      item.leaseExpiresAt = input.leaseExpiresAt;
      item.updatedAt = input.now;
      return true;
    },
    async complete(input) {
      const item = findLeasedJob(jobs, input);
      if (!item) return false;
      Object.assign(item, {
        status: "completed" satisfies RunnerJobStatus,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: input.now,
      });
      return true;
    },
    async fail(input) {
      const item = findLeasedJob(jobs, input);
      if (!item) return false;
      Object.assign(item, {
        status: input.status,
        nextRunAt: input.nextRunAt,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: input.lastError,
        updatedAt: input.now,
      });
      return true;
    },
  };
}

function findLeasedJob(
  jobs: RunnerJob[],
  input: { id: number; leaseId: string; leaseOwner: string },
) {
  return jobs.find(
    (item) =>
      item.id === input.id &&
      item.leaseId === input.leaseId &&
      item.leaseOwner === input.leaseOwner &&
      item.status === "running",
  );
}

function firstJob(store: { jobs: RunnerJob[] }) {
  const item = store.jobs[0];
  if (!item) throw new Error("Expected at least one runner job.");
  return item;
}

function job(overrides: Partial<RunnerJob> = {}): RunnerJob {
  const now = new Date("2026-05-27T12:00:00.000Z");
  const id = overrides.id ?? 1;
  const input: EnqueueRunnerJobInput = {
    kind: overrides.kind ?? "message",
    sessionId: overrides.sessionId ?? "ses_123",
    messageId: overrides.messageId ?? "msg_123",
  };
  return {
    id,
    idempotencyKey:
      overrides.idempotencyKey ?? `${input.kind}:${input.sessionId}:${input.messageId}`,
    sessionId: input.sessionId,
    messageId: input.messageId ?? null,
    kind: input.kind,
    status: "pending",
    attempts: 0,
    nextRunAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function handlers(overrides: Partial<RunnerJobHandlers> = {}): RunnerJobHandlers {
  const base: RunnerJobHandlers = {
    startSession: async () => undefined,
    runMessage: async () => undefined,
    generateSessionTitleForMessage: async () => ({ ok: true as const, title: "Generated title" }),
    runAfterSession: async () => undefined,
    resumeApproval: async () => undefined,
    resumeQuestionResponse: async () => undefined,
  };
  return { ...base, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa_test",
    xApiBearerToken: "x_test",
    supadataApiKey: "supadata_test",
    ampApiKey: "amp_test",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    toolArgRepairEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-a",
    ...overrides,
  };
}
