import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/features/auth";
import { queryClient } from "@/shared/lib/query-client";
import type { CodingEngine } from "./composer-selection";

export type AgentConnectivity =
  | { state: "loading" }
  | { state: "error"; retry: () => void }
  | { state: "connected" }
  | { state: "disconnected" }
  | { state: "needs_reauth"; reason: string | null };

const engineAuthKey = (userId: string | undefined, engine?: CodingEngine) =>
  engine ? (["engine-auth", userId, engine] as const) : (["engine-auth", userId] as const);

/**
 * The acting user's own Codex or Claude Code connection, read fresh whenever a screen using it
 * mounts and again when the app returns to the foreground, typically after connecting on the web.
 */
export function useAgentConnectivity(engine: CodingEngine): AgentConnectivity {
  const { api, user } = useAuth();
  const query = useQuery({
    queryKey: engineAuthKey(user?.id, engine),
    queryFn: async ({ signal }) => {
      const status =
        engine === "codex" ? await api.getCodexAuth(signal) : await api.getClaudeCodeAuth(signal);
      return { status: status.status, reason: status.statusReason };
    },
    enabled: Boolean(user),
    refetchOnMount: "always",
    retry: 1,
  });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active")
        void queryClient.invalidateQueries({ queryKey: engineAuthKey(user?.id) });
    });
    return () => subscription.remove();
  }, [user?.id]);

  // A failed refresh after a good read still reports the last known connection.
  if (query.data) {
    if (query.data.status === "connected") return { state: "connected" };
    if (query.data.status === "needs_reauth")
      return { state: "needs_reauth", reason: query.data.reason };
    return { state: "disconnected" };
  }
  if (query.isError) return { state: "error", retry: () => void query.refetch() };
  return { state: "loading" };
}
