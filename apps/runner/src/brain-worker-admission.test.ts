import { EventEmitter } from "node:events";
import type { PooledDbClient, PooledDbHandle } from "@opencompany/db/pool";
import { BRAIN_WORKER_ADMISSION_CHANNEL } from "@opencompany/db/worker-admission";
import { describe, expect, it, vi } from "vitest";
import { startBrainWorkerAdmissionListener } from "./brain-worker-admission";

const telemetry = vi.hoisted(() => ({ recordGauge: vi.fn() }));

vi.mock("@opencompany/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/telemetry")>()),
  recordGauge: telemetry.recordGauge,
}));

type Pool = PooledDbHandle["pool"];
type Notification = {
  processId: number;
  channel: string;
  payload?: string;
};

describe("startBrainWorkerAdmissionListener", () => {
  it("routes valid durable admission hints and ignores malformed payloads", async () => {
    const client = fakeClient();
    const callbacks = {
      brain_import: vi.fn(),
      brain_ingest: vi.fn(),
      google_drive_sync: vi.fn(),
    };
    const listener = startBrainWorkerAdmissionListener({
      pool: { connect: vi.fn(async () => client as unknown as PooledDbClient) } as unknown as Pool,
      callbacks,
    });

    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith("LISTEN goat_brain_worker_admission_v1"),
    );
    client.emit("notification", notification(JSON.stringify({ worker: "brain_import" })));
    client.emit("notification", notification(JSON.stringify({ worker: "brain_ingest" })));
    client.emit("notification", notification(JSON.stringify({ worker: "google_drive_sync" })));
    client.emit("notification", notification("not json"));
    client.emit("notification", {
      ...notification(JSON.stringify({ worker: "brain_import" })),
      channel: "other_channel",
    });

    expect(callbacks.brain_import).toHaveBeenCalledOnce();
    expect(callbacks.brain_ingest).toHaveBeenCalledOnce();
    expect(callbacks.google_drive_sync).toHaveBeenCalledOnce();

    await listener.stop();
    expect(client.query).toHaveBeenLastCalledWith("UNLISTEN goat_brain_worker_admission_v1");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("leaves recovery to polling when the listener cannot connect", async () => {
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as Pool;
    const listener = startBrainWorkerAdmissionListener({
      pool,
      callbacks: {
        brain_import: vi.fn(),
        brain_ingest: vi.fn(),
        google_drive_sync: vi.fn(),
      },
      reconnectDelayMs: 60_000,
    });

    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledOnce());
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("reports global notification queue usage from the listener connection", async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (query: string) =>
      query.includes("pg_notification_queue_usage")
        ? { rows: [{ usage: 0.125 }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const listener = startBrainWorkerAdmissionListener({
      pool: { connect: vi.fn(async () => client as unknown as PooledDbClient) } as unknown as Pool,
      callbacks: {
        brain_import: vi.fn(),
        brain_ingest: vi.fn(),
        google_drive_sync: vi.fn(),
      },
      notificationQueuePollIntervalMs: 10,
    });

    await vi.waitFor(() =>
      expect(telemetry.recordGauge).toHaveBeenCalledWith("goat.postgres.notify_queue_usage", 0.125),
    );

    await listener.stop();
  });

  it("reconnects after a dedicated listener connection fails", async () => {
    const firstClient = fakeClient();
    const secondClient = fakeClient();
    const pool = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(firstClient as unknown as PooledDbClient)
        .mockResolvedValueOnce(secondClient as unknown as PooledDbClient),
    } as unknown as Pool;
    const callbacks = {
      brain_import: vi.fn(),
      brain_ingest: vi.fn(),
      google_drive_sync: vi.fn(),
    };
    const listener = startBrainWorkerAdmissionListener({
      pool,
      callbacks,
      reconnectDelayMs: 10,
    });

    await vi.waitFor(() => expect(firstClient.query).toHaveBeenCalledOnce());
    firstClient.emit("error", new Error("connection lost"));
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(2));

    secondClient.emit(
      "notification",
      notification(JSON.stringify({ worker: "google_drive_sync" })),
    );
    expect(callbacks.google_drive_sync).toHaveBeenCalledOnce();
    expect(firstClient.release).toHaveBeenCalledWith(true);

    await listener.stop();
  });
});

function fakeClient() {
  const client = new EventEmitter() as EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  client.query = vi.fn(async () => undefined);
  client.release = vi.fn();
  return client;
}

function notification(payload: string): Notification {
  return {
    processId: 1,
    channel: BRAIN_WORKER_ADMISSION_CHANNEL,
    payload,
  };
}
