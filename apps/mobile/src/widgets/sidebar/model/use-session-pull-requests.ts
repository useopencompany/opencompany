import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/features/auth";
import { captureError } from "@/shared/lib/analytics";
import { useChatCoordinator } from "@/widgets/chat/model/chat-coordinator";
import { indexPullRequestsByConversation, type SessionPullRequest } from "./sidebar-items";

// Matches the API's own GitHub refresh window, so a poll inside it is answered from its cache.
const POLL_INTERVAL_MS = 60_000;
const EMPTY = new Map<string, SessionPullRequest>();

/**
 * The PR each conversation opened, keyed by conversation.
 *
 * Only polled while the sidebar is on screen and the device is online. A failed read keeps the
 * last known badges and is recorded without interrupting anything: the badge is ambient, and the
 * reader cannot act on its failure. The key carries the account and workspace, so a sign-out or
 * workspace switch never shows another account's PRs.
 */
export function useSessionPullRequests(visible: boolean): ReadonlyMap<string, SessionPullRequest> {
  const { api } = useAuth();
  const { partition, connectivity } = useChatCoordinator();
  const enabled = Boolean(partition) && visible && connectivity !== "offline";
  const query = useQuery({
    queryKey: ["chat", partition?.userId, partition?.workspaceId, "session-pull-requests"],
    queryFn: async ({ signal }) =>
      indexPullRequestsByConversation((await api.listSessionPullRequests(signal)).data),
    enabled,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
  });
  const { error, refetch } = query;

  useEffect(() => {
    if (error) captureError("session_pull_requests_failed", error);
  }, [error]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch();
    });
    return () => subscription.remove();
  }, [enabled, refetch]);

  return query.data ?? EMPTY;
}
