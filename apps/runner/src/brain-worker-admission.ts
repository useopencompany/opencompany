import type { PooledDbClient, PooledDbHandle, PooledDbNotification } from "@opencompany/db/pool";
import {
  BRAIN_WORKER_ADMISSION_CHANNEL,
  type BrainWorker,
  parseBrainWorkerAdmission,
} from "@opencompany/db/worker-admission";
import { createLogger } from "@opencompany/observability";

type Pool = PooledDbHandle["pool"];

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-brain-worker-admission",
});
const RECONNECT_DELAY_MS = 1_000;

export type BrainWorkerAdmissionCallbacks = Record<BrainWorker, () => void>;

export function startBrainWorkerAdmissionListener(input: {
  pool: Pool;
  callbacks: BrainWorkerAdmissionCallbacks;
  reconnectDelayMs?: number;
}) {
  const reconnectDelayMs = Math.max(10, input.reconnectDelayMs ?? RECONNECT_DELAY_MS);
  let stopped = false;
  let client: PooledDbClient | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  };

  const releaseClient = (current: PooledDbClient, failed: boolean) => {
    if (client !== current) return;
    client = null;
    current.removeListener("notification", onNotification);
    current.removeListener("error", onError);
    current.release(failed);
  };

  const onNotification = (notification: PooledDbNotification) => {
    if (notification.channel !== BRAIN_WORKER_ADMISSION_CHANNEL || !notification.payload) {
      return;
    }
    const worker = parseBrainWorkerAdmission(notification.payload);
    if (worker) input.callbacks[worker]();
  };

  const onError = (error: Error) => {
    const current = client;
    if (current) releaseClient(current, true);
    logger.warn("Brain worker admission listener disconnected; polling remains active", {
      event: "opencompany.goat_brain_worker_admission_listener_disconnected",
      error,
    });
    scheduleReconnect();
  };

  const connect = () => {
    if (stopped || client) return Promise.resolve();
    if (connecting) return connecting;
    connecting = input.pool
      .connect()
      .then(async (connected) => {
        if (stopped) {
          connected.release();
          return;
        }
        connected.on("notification", onNotification);
        connected.on("error", onError);
        client = connected;
        try {
          await connected.query(`LISTEN ${BRAIN_WORKER_ADMISSION_CHANNEL}`);
          logger.info("Brain worker admission listener connected", {
            event: "opencompany.goat_brain_worker_admission_listener_connected",
            channel: BRAIN_WORKER_ADMISSION_CHANNEL,
          });
        } catch (error) {
          releaseClient(connected, true);
          throw error;
        }
      })
      .catch((error) => {
        logger.warn("Brain worker admission listener is unavailable; polling remains active", {
          event: "opencompany.goat_brain_worker_admission_listener_unavailable",
          error,
        });
        scheduleReconnect();
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };

  void connect();

  return {
    stop: async () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      await connecting;
      const current = client;
      if (!current) return;
      client = null;
      current.removeListener("notification", onNotification);
      current.removeListener("error", onError);
      await current.query(`UNLISTEN ${BRAIN_WORKER_ADMISSION_CHANNEL}`).catch(() => undefined);
      current.release();
    },
  };
}
