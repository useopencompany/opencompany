import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "@/lib/theme";

type ComposerProps = {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  modelLabel: string;
  autoFocus?: boolean;
};

export function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  isGenerating,
  modelLabel,
  autoFocus,
}: ComposerProps) {
  const canSend = value.trim().length > 0 && !isGenerating;

  return (
    <View style={styles.card}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder="Follow up…"
        placeholderTextColor={colors.textTertiary}
        multiline
        autoFocus={autoFocus}
        submitBehavior="newline"
      />
      <View style={styles.row}>
        <View style={styles.plusButton}>
          <SymbolView name="plus" size={15} tintColor={colors.textSecondary} />
        </View>
        <Text style={styles.modelLabel}>{modelLabel}</Text>
        <View style={styles.spacer} />
        {isGenerating ? (
          <Pressable
            hitSlop={8}
            style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
            onPress={onStop}
          >
            <SymbolView name="square.fill" size={11} tintColor="#FFFFFF" />
          </Pressable>
        ) : (
          <Pressable
            hitSlop={8}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.sendButton,
              !canSend && styles.sendDisabled,
              pressed && styles.pressed,
            ]}
            onPress={onSend}
          >
            <SymbolView name="arrow.up" size={15} tintColor="#FFFFFF" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    shadowColor: "#000000",
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  input: {
    fontSize: 16,
    lineHeight: 21,
    color: colors.textPrimary,
    maxHeight: 120,
    paddingTop: 0,
    paddingBottom: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  plusButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.chipBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  modelLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  spacer: {
    flex: 1,
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: {
    opacity: 0.35,
  },
  stopButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.textPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.8,
  },
});
