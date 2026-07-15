import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchSessions } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { GoatSessionSummary } from "@/lib/chat-types";
import { colors } from "@/lib/theme";

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default function SessionsScreen() {
  const router = useRouter();
  const { status, getAccessToken } = useAuth();
  const [sessions, setSessions] = useState<GoatSessionSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setSessions(await fetchSessions(getAccessToken));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load chats.");
    }
  }, [getAccessToken]);

  useFocusEffect(
    useCallback(() => {
      if (status === "signedIn") void load();
    }, [status, load]),
  );

  const { pinned, recent } = useMemo(() => {
    const list = sessions ?? [];
    return {
      pinned: list.filter((session) => session.pinnedAt !== null),
      recent: list.filter((session) => session.pinnedAt === null),
    };
  }, [sessions]);

  if (status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (status === "signedOut") {
    return <Redirect href="/sign-in" />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chats</Text>
        <Pressable
          hitSlop={8}
          style={({ pressed }) => [styles.newChatButton, pressed && { opacity: 0.7 }]}
          onPress={() => router.push("/chat/new")}
        >
          <SymbolView name="plus" size={17} tintColor={colors.textPrimary} />
        </Pressable>
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {sessions === null && !error ? (
          <ActivityIndicator style={{ marginTop: 48 }} />
        ) : (
          <>
            {pinned.length > 0 ? <SessionSection title="Pinned" sessions={pinned} /> : null}
            {recent.length > 0 ? (
              <SessionSection title="Recent" sessions={recent} />
            ) : sessions !== null && pinned.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No chats yet</Text>
                <Text style={styles.emptySubtitle}>Start a conversation with Goat.</Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SessionSection({ title, sessions }: { title: string; sessions: GoatSessionSummary[] }) {
  const router = useRouter();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {sessions.map((session) => (
        <Pressable
          key={session.id}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push(`/chat/${session.id}`)}
        >
          <View style={styles.rowDot} />
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {session.title}
            </Text>
            <Text style={styles.rowSubtitle} numberOfLines={1}>
              {relativeTime(session.updatedAt)}
              {session.engine !== "opencompany" ? `  ·  ${session.engine}` : ""}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: colors.textPrimary,
  },
  newChatButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.chipBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 32,
  },
  error: {
    color: colors.destructive,
    fontSize: 14,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  section: {
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  rowPressed: {
    backgroundColor: colors.chipBackground,
  },
  rowDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginTop: 7,
    backgroundColor: colors.textTertiary,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: "500",
    color: colors.textPrimary,
  },
  rowSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  empty: {
    alignItems: "center",
    marginTop: 96,
    gap: 4,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  emptySubtitle: {
    fontSize: 15,
    color: colors.textSecondary,
  },
});
