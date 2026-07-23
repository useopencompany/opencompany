"use client";

import { createLogger } from "@opencompany/observability";
import {
  LogLevel,
  type StatsigOptions,
  StatsigProvider,
  type StatsigUser,
  useClientAsyncInit,
} from "@statsig/react-bindings";
import { StatsigAutoCapturePlugin } from "@statsig/web-analytics";
import { type ReactNode, useMemo } from "react";

export type StatsigIdentity = {
  userId: string;
  workspaceId: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
};

type StatsigAnalyticsProviderProps = {
  children: ReactNode;
  identity?: StatsigIdentity | null;
};

// The Statsig plugin classes are typed against a slightly different `StatsigClient` shape than
// `@statsig/js-client` exposes; under the repo's `exactOptionalPropertyTypes` the structural
// check fails even though they are runtime-compatible. Narrow to the option's own plugin type.
type StatsigClientPlugin = NonNullable<StatsigOptions["plugins"]>[number];

const logger = createLogger({ service: "opencompany-statsig", runtime: "browser" });
const ANONYMOUS_USER_ID = "anonymous";

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function debugLog(message: string, payload?: unknown) {
  if (!isDebugEnabled()) return;
  logger.info(`Statsig ${message}`, {
    event: "opencompany.statsig_debug",
    payload,
  });
}

function toStatsigUser(identity?: StatsigIdentity | null): StatsigUser {
  if (!identity) return { userID: ANONYMOUS_USER_ID };

  const name = [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim();

  return {
    userID: identity.userId,
    ...(identity.email ? { email: identity.email } : {}),
    custom: {
      workspace_id: identity.workspaceId,
      ...(name ? { name } : {}),
    },
  };
}

// Hooks live in the inner component so the outer provider can bail out (render children
// untouched) when the client key is missing, matching the analytics package's graceful
// disable. This keeps hook order stable — the inner component always runs its hooks.
function StatsigAnalyticsInner({
  clientKey,
  identity,
  children,
}: {
  clientKey: string;
  identity?: StatsigIdentity | null;
  children: ReactNode;
}) {
  const user = useMemo(() => toStatsigUser(identity), [identity]);
  const options = useMemo<StatsigOptions>(
    () => ({
      plugins: [new StatsigAutoCapturePlugin() as unknown as StatsigClientPlugin],
      logLevel: isDebugEnabled() ? LogLevel.Debug : LogLevel.Warn,
    }),
    [],
  );

  const { client } = useClientAsyncInit(clientKey, user, options);

  return <StatsigProvider client={client}>{children}</StatsigProvider>;
}

export function StatsigAnalyticsProvider({ children, identity }: StatsigAnalyticsProviderProps) {
  const clientKey = process.env.NEXT_PUBLIC_STATSIG_CLIENT_KEY;

  if (!clientKey) {
    debugLog("client disabled: missing NEXT_PUBLIC_STATSIG_CLIENT_KEY");
    return children;
  }

  return (
    <StatsigAnalyticsInner clientKey={clientKey} identity={identity ?? null}>
      {children}
    </StatsigAnalyticsInner>
  );
}
