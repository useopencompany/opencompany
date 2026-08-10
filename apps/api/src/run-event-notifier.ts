import { RUN_EVENT_NOTIFY_CHANNEL } from "@opencompany/db/chat-repository";
import type { Pool, PoolClient } from "pg";

export interface RunEventNotifier {
  wait(input: { runId: string; signal: AbortSignal; timeoutMs: number }): Promise<void>;
  close?(): Promise<void>;
}

// LISTEN is only a latency hint. Every SSE loop re-queries the durable event log after this wait
// or its timeout, so dropped notifications, listener reconnects, and process restarts cannot lose
// semantic events.
export class PostgresRunEventNotifier implements RunEventNotifier {
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly pool: Pool) {}

  async wait(input: { runId: string; signal: AbortSignal; timeoutMs: number }) {
    if (input.signal.aborted || this.closed) return;
    await this.ensureListener().catch(() => undefined);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", finish);
        const runWaiters = this.waiters.get(input.runId);
        runWaiters?.delete(finish);
        if (runWaiters?.size === 0) this.waiters.delete(input.runId);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(50, input.timeoutMs));
      timer.unref?.();
      const runWaiters = this.waiters.get(input.runId) ?? new Set<() => void>();
      runWaiters.add(finish);
      this.waiters.set(input.runId, runWaiters);
      input.signal.addEventListener("abort", finish, { once: true });
    });
  }

  async close() {
    this.closed = true;
    for (const waiters of this.waiters.values()) {
      for (const wake of waiters) wake();
    }
    this.waiters.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query(`UNLISTEN ${RUN_EVENT_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
    }
  }

  private ensureListener() {
    if (this.client || this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.pool
      .connect()
      .then(async (client) => {
        if (this.closed) {
          client.release();
          return;
        }
        client.on("notification", (notification) => {
          if (notification.channel !== RUN_EVENT_NOTIFY_CHANNEL || !notification.payload) return;
          try {
            const payload = JSON.parse(notification.payload) as { runId?: unknown };
            if (typeof payload.runId !== "string") return;
            for (const wake of this.waiters.get(payload.runId) ?? []) wake();
          } catch {
            // A malformed hint is ignored; polling remains authoritative.
          }
        });
        client.on("error", () => this.releaseBrokenClient(client));
        await client.query(`LISTEN ${RUN_EVENT_NOTIFY_CHANNEL}`);
        this.client = client;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private releaseBrokenClient(client: PoolClient) {
    if (this.client !== client) return;
    this.client = null;
    client.release(true);
  }
}

export class PollingRunEventNotifier implements RunEventNotifier {
  async wait(input: { signal: AbortSignal; timeoutMs: number }) {
    if (input.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(50, input.timeoutMs));
      timer.unref?.();
      input.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
