import type { PooledDbClient, PooledDbHandle, PooledDbNotification } from "@opencompany/db/pool";
import {
  BRAIN_WORKER_ADMISSION_CHANNEL,
  type BrainWorker,
  parseBrainWorkerAdmission,
} from "@opencompany/db/worker-admission";
import { createLogger } from "@opencompany/observability";
import { METRICS, recordGauge } from "@opencompany/telemetry";

type Pool = PooledDbHandle["pool"];

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-brain-worker-admission",
});
const RECONNECT_DELAY_MS = 1_000;
const NOTIFICATION_QUEUE_POLL_INTERVAL_MS = 60_000;
const NOTIFICATION_QUEUE_WARN_THRESHOLD = 0.25;

export type BrainWorkerAdmissionCallbacks = Record<BrainWorker, () => void>;

export function startBrainWorkerAdmissionListener(input: {
  pool: Pool;
  callbacks: BrainWorkerAdmissionCallbacks;
  reconnectDelayMs?: number;
  notificationQueuePollIntervalMs?: number;
  notificationQueueWarnThreshold?: number;
}) {
  const reconnectDelayMs = Math.max(10, input.reconnectDelayMs ?? RECONNECT_DELAY_MS);
  const notificationQueuePollIntervalMs = Math.max(
    10,
    input.notificationQueuePollIntervalMs ?? NOTIFICATION_QUEUE_POLL_INTERVAL_MS,
  );
  const notificationQueueWarnThreshold = Math.min(
    1,
    Math.max(0.01, input.notificationQueueWarnThreshold ?? NOTIFICATION_QUEUE_WARN_THRESHOLD),
  );
  let stopped = false;
  let client: PooledDbClient | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationQueueTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationQueueWarningActive = false;

  const clearNotificationQueueTimer = () => {
    if (notificationQueueTimer) clearTimeout(notificationQueueTimer);
    notificationQueueTimer = null;
  };

  const scheduleNotificationQueueCheck = () => {
    if (stopped || !client || notificationQueueTimer) return;
    notificationQueueTimer = setTimeout(() => {
      notificationQueueTimer = null;
      void sampleNotificationQueueUsage();
    }, notificationQueuePollIntervalMs);
    notificationQueueTimer.unref?.();
  };

  const sampleNotificationQueueUsage = async () => {
    const current = client;
    if (stopped || !current) return;
    try {
      const result = await current.query<{ usage: number | string }>(
        "SELECT pg_notification_queue_usage() AS usage",
      );
      if (client !== current) return;
      const usage = Number(result.rows[0]?.usage);
      if (!Number.isFinite(usage) || usage < 0 || usage > 1) {
        throw new Error("Postgres returned an invalid notification queue usage ratio.");
      }
      recordGauge(METRICS.postgresNotifyQueueUsage, usage);
      if (usage >= notificationQueueWarnThreshold && !notificationQueueWarningActive) {
        notificationQueueWarningActive = true;
        logger.warn("Postgres notification queue usage is elevated", {
          event: "opencompany.postgres_notify_queue_usage_elevated",
          queue_usage: usage,
          warning_threshold: notificationQueueWarnThreshold,
        });
      } else if (usage < notificationQueueWarnThreshold / 2) {
        notificationQueueWarningActive = false;
      }
    } catch (error) {
      logger.warn("Postgres notification queue usage check failed", {
        event: "opencompany.postgres_notify_queue_usage_check_failed",
        error,
      });
    } finally {
      if (client === current) scheduleNotificationQueueCheck();
    }
  };

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
    clearNotificationQueueTimer();
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
          // NOTIFY takes a global commit lock before PostgreSQL 19. This listener is
          // only a latency hint over durable polling; do not add channels/consumers
          // without revisiting the tradeoff. New wakeups use the poll+wake pattern.
          // https://www.recall.ai/blog/postgres-listen-notify-does-not-scale
          await connected.query(`LISTEN ${BRAIN_WORKER_ADMISSION_CHANNEL}`);
          scheduleNotificationQueueCheck();
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
      clearNotificationQueueTimer();
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
