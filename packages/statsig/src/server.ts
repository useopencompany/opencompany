import { createLogger } from "@opencompany/observability";
import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import type { StatsigEventName, StatsigEventProperties } from "./events";

const logger = createLogger({ service: "opencompany-statsig", runtime: "server" });

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function getSecretKey() {
  return process.env.STATSIG_SERVER_SECRET_KEY;
}

function debugLog(message: string, payload?: unknown) {
  if (!isDebugEnabled()) return;
  logger.info(`Statsig ${message}`, {
    event: "opencompany.statsig_debug",
    payload,
  });
}

// A single long-lived Statsig instance is reused across invocations (node-core is designed
// to be shared, and Fluid Compute keeps the instance warm). Init failures reset the cache so
// a later request can retry. Analytics must never throw into a request path.
let clientPromise: Promise<Statsig | null> | null = null;

function getStatsig(): Promise<Statsig | null> {
  const secret = getSecretKey();
  if (!secret) {
    debugLog("server disabled: missing STATSIG_SERVER_SECRET_KEY");
    return Promise.resolve(null);
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const statsig = new Statsig(secret);
        await statsig.initialize();
        debugLog("server initialized");
        return statsig;
      } catch (error) {
        debugLog("server init failed", error);
        clientPromise = null;
        return null;
      }
    })();
  }

  return clientPromise;
}

export async function captureStatsigServerEvent<EventName extends StatsigEventName>(
  event: EventName,
  distinctId: string,
  properties: StatsigEventProperties<EventName>,
) {
  debugLog("server capture", { event, distinctId, properties });

  const statsig = await getStatsig();
  if (!statsig) return;

  try {
    const workspaceId =
      "workspace_id" in properties
        ? (properties as { workspace_id?: string }).workspace_id
        : undefined;

    const user = new StatsigUser({
      userID: distinctId,
      ...(workspaceId ? { custom: { workspace_id: workspaceId } } : {}),
    });

    statsig.logEvent(
      user,
      event,
      undefined,
      properties as Record<string, string | number | boolean | null | undefined>,
    );

    // Flush immediately so events aren't lost when a short-lived function is frozen.
    await statsig.flushEvents();
  } catch (error) {
    debugLog("server capture failed", error);
  }
}
