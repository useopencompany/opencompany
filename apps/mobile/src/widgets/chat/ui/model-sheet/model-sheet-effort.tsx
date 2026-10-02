import type { CloudCodingReasoningEffort } from "@opencompany/agent-runtime/types";
import { Fragment, useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useChatComposer } from "../../model/chat-composer-context";
import {
  type ComposerSelection,
  EFFORT_LABELS,
  effectiveEffort,
  effortOptions,
  GOAL_OBJECTIVE_MAX_LENGTH,
  validateGoal,
} from "../../model/composer-selection";
import { useConversationWorking } from "../../model/use-conversation-working";
import { SheetRow, SheetRowSeparator, SheetSection } from "./sheet-rows";

// Matches the web app's inputs: a page-colored field with an input border that turns to the ring
// color while focused. On the sheet's grouped rows that reads as a distinct, recessed field.
const FIELD_CLASS_NAME =
  "rounded-[14px] border border-continuous bg-card px-3 py-2.5 text-[16px] text-foreground dark:bg-background";

const EFFORT_DESCRIPTIONS: Partial<Record<CloudCodingReasoningEffort, string>> = {
  ultracode: "Extra High reasoning with dynamic workflows",
};

/**
 * Effort for the selected coding agent, plus Codex's Plan and Goal modes. Every change lands in
 * the draft at once; Back returns to the sheet's first screen.
 */
export function ModelSheetEffort() {
  const { conversationId, selection, updateSelection } = useChatComposer();
  const working = useConversationWorking(conversationId);
  const options = effortOptions(selection);
  const current = effectiveEffort(selection);
  const isCodex = selection.engine === "codex";
  const updateCodex = (changes: Partial<ComposerSelection["codex"]>) =>
    updateSelection((value) => ({ ...value, codex: { ...value.codex, ...changes } }));

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      contentContainerClassName="gap-5 px-4 pt-2 pb-10"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {options.length > 0 ? (
        <SheetSection
          footer={working ? "Effort can change once the current response finishes." : undefined}
          title="Effort"
        >
          {options.map((effort, index) => (
            <Fragment key={effort}>
              {index > 0 ? <SheetRowSeparator /> : null}
              <SheetRow
                accessory="check"
                disabled={working}
                onPress={() =>
                  updateSelection((value) =>
                    value.engine === "codex"
                      ? {
                          ...value,
                          codex: {
                            ...value.codex,
                            reasoningEffort:
                              effort as ComposerSelection["codex"]["reasoningEffort"],
                          },
                        }
                      : { ...value, claude: { reasoningEffort: effort } },
                  )
                }
                selected={effort === current}
                subtitle={EFFORT_DESCRIPTIONS[effort]}
                title={EFFORT_LABELS[effort]}
              />
            </Fragment>
          ))}
        </SheetSection>
      ) : null}

      {isCodex ? (
        <SheetSection
          footer="Plan and Goal apply to your next message. Turning Goal off keeps what you wrote."
          title="Modes"
        >
          <SheetRow
            disabled={working}
            subtitle="Plans before making changes"
            title="Plan"
            trailing={
              <Switch
                accessibilityLabel="Plan mode"
                disabled={working}
                onValueChange={(planModeEnabled) => updateCodex({ planModeEnabled })}
                value={selection.codex.planModeEnabled}
              />
            }
          />
          <SheetRowSeparator />
          <SheetRow
            disabled={working}
            subtitle="Keeps working until an objective is met"
            title="Goal"
            trailing={
              <Switch
                accessibilityLabel="Goal mode"
                disabled={working}
                onValueChange={(goalModeEnabled) => updateCodex({ goalModeEnabled })}
                value={selection.codex.goalModeEnabled}
              />
            }
          />
          {selection.codex.goalModeEnabled ? <GoalFields disabled={working} /> : null}
        </SheetSection>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

/**
 * The Goal objective and token budget. They are uncontrolled: only this screen edits them, and
 * echoing each keystroke back through the draft drops characters under fast typing. They mount
 * with the draft's text and keep it as their starting value, since React Native re-measures an
 * input whose `defaultValue` changes and would size it from older text.
 */
function GoalFields({ disabled }: { disabled: boolean }) {
  const { selection, updateSelection } = useChatComposer();
  const [initial] = useState(selection.codex);
  const [focusedField, setFocusedField] = useState<"objective" | "budget" | null>(null);
  const goal = validateGoal(selection.codex);
  const fieldBorder = (field: "objective" | "budget", invalid: boolean) =>
    invalid ? "border-destructive" : focusedField === field ? "border-ring" : "border-input";
  const updateCodex = (changes: Partial<ComposerSelection["codex"]>) =>
    updateSelection((value) => ({ ...value, codex: { ...value.codex, ...changes } }));

  return (
    <View className="gap-3 px-4 pt-1 pb-4">
      <View className="gap-1">
        <TextInput
          accessibilityHint="Required for Goal mode"
          accessibilityLabel="Goal objective"
          className={`min-h-[88px] leading-[21px] ${FIELD_CLASS_NAME} ${fieldBorder("objective", Boolean(goal.objective))}`}
          defaultValue={initial.goalObjective}
          editable={!disabled}
          maxLength={GOAL_OBJECTIVE_MAX_LENGTH + 200}
          multiline
          onBlur={() => setFocusedField(null)}
          onChangeText={(goalObjective) => updateCodex({ goalObjective })}
          onFocus={() => setFocusedField("objective")}
          placeholder="Objective"
          placeholderTextColorClassName="accent-muted-foreground"
          textAlignVertical="top"
        />
        {goal.objective ? (
          <Text accessibilityLiveRegion="polite" className="px-1 text-[13px] text-destructive">
            {goal.objective}
          </Text>
        ) : null}
      </View>
      <View className="gap-1">
        <TextInput
          accessibilityLabel="Token budget, optional"
          className={`${FIELD_CLASS_NAME} ${fieldBorder("budget", Boolean(goal.tokenBudget))}`}
          defaultValue={initial.goalTokenBudget}
          editable={!disabled}
          keyboardType="number-pad"
          onBlur={() => setFocusedField(null)}
          onChangeText={(goalTokenBudget) => updateCodex({ goalTokenBudget })}
          onFocus={() => setFocusedField("budget")}
          placeholder="Token budget (optional)"
          placeholderTextColorClassName="accent-muted-foreground"
        />
        {goal.tokenBudget ? (
          <Text accessibilityLiveRegion="polite" className="px-1 text-[13px] text-destructive">
            {goal.tokenBudget}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
