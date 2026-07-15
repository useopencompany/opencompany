import { SymbolView } from "expo-symbols";
import { memo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { type GoatMobileUiMessage, textFromMessage, toolLabel } from "@/lib/chat-types";
import { colors } from "@/lib/theme";

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function MessageItemInner({ message }: { message: GoatMobileUiMessage }) {
  if (message.role === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>
            {textFromMessage(message)}
          </Text>
        </View>
      </View>
    );
  }

  const durationMs = message.metadata?.timing?.durationMs;
  return (
    <View style={styles.assistantContainer}>
      {typeof durationMs === "number" ? (
        <Text style={styles.statusRow}>Finished · {formatDuration(durationMs)}</Text>
      ) : null}
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <Text key={`${message.id}-${index}`} style={styles.assistantText} selectable>
              {part.text}
            </Text>
          );
        }
        if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
          const toolPart = part as { type: string; toolName?: string; state?: string };
          const partType =
            part.type === "dynamic-tool" ? `tool-${toolPart.toolName ?? "tool"}` : part.type;
          const done = toolPart.state === "output-available" || toolPart.state === "output-error";
          return <ToolChip key={`${message.id}-${index}`} type={partType} done={done} />;
        }
        return null;
      })}
      {message.metadata?.error ? (
        <Text style={styles.errorText}>{message.metadata.error}</Text>
      ) : null}
      {message.metadata?.aborted ? <Text style={styles.statusRow}>Stopped</Text> : null}
    </View>
  );
}

function ToolChip({ type, done }: { type: string; done: boolean }) {
  return (
    <View style={styles.toolChip}>
      {done ? (
        <SymbolView name="checkmark" size={11} tintColor={colors.textSecondary} />
      ) : (
        <ActivityIndicator size="small" color={colors.textSecondary} style={styles.toolSpinner} />
      )}
      <Text style={styles.toolLabel}>{toolLabel(type, done)}</Text>
    </View>
  );
}

// Completed messages keep stable object references across stream updates, so a
// plain memo freezes everything except the actively streaming message.
export const MessageItem = memo(MessageItemInner);

const styles = StyleSheet.create({
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 16,
  },
  userBubble: {
    maxWidth: "86%",
    backgroundColor: colors.bubble,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  assistantContainer: {
    marginTop: 16,
    gap: 8,
  },
  statusRow: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  assistantText: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textPrimary,
  },
  errorText: {
    fontSize: 14,
    color: colors.destructive,
  },
  toolChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    backgroundColor: colors.chipBackground,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toolSpinner: {
    transform: [{ scale: 0.7 }],
  },
  toolLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
});
