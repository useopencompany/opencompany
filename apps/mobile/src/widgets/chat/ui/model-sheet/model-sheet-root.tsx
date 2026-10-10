import { Host } from "@expo/ui";
import { Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Fragment, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text } from "react-native";
import { until } from "until-async";
import { WEB_INFERENCE_SETTINGS_URL } from "@/shared/api/opencompany-api";
import { analytics } from "@/shared/lib/analytics";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { useChatComposer } from "../../model/chat-composer-context";
import {
  AUTO_MODEL_ID,
  CHAT_PICKER_MODEL_IDS,
  type CodingEngine,
  EFFORT_LABELS,
  ENGINE_LABELS,
  effectiveEffort,
  effortOptions,
  modelDescription,
  modelLabel,
  selectedModelId,
} from "../../model/composer-selection";
import { type AgentConnectivity, useAgentConnectivity } from "../../model/engine-connectivity";
import { useConversationWorking } from "../../model/use-conversation-working";
import { ModelLogo } from "../model-logo";
import { SheetRow, SheetRowSeparator, SheetSection } from "./sheet-rows";
import { useCloseModelSheet } from "./use-close-model-sheet";

type SheetTab = "chat" | "coding";

const AGENT_DESCRIPTIONS: Record<CodingEngine, string> = {
  codex: "OpenAI's coding agent, working in a cloud sandbox",
  claude_code: "Anthropic's coding agent, working in a cloud sandbox",
};

const AGENT_LOGO_MODELS: Record<CodingEngine, string> = {
  codex: "openai/gpt-6-sol",
  claude_code: "anthropic/claude-sonnet-5",
};

const connectivitySubtitle = (engine: CodingEngine, connectivity: AgentConnectivity) => {
  switch (connectivity.state) {
    case "connected":
      return AGENT_DESCRIPTIONS[engine];
    case "loading":
      return "Checking your connection…";
    case "error":
      return "Couldn't check your connection.";
    case "needs_reauth":
      return "Reconnect on the web app";
    case "disconnected":
      return "Connect on the web app";
  }
};

export function ModelSheetRoot() {
  const { showErrorToast } = useToast();
  const { autoModelEnabled, conversationId, locks, selection, updateSelection } = useChatComposer();
  const working = useConversationWorking(conversationId);
  const close = useCloseModelSheet();
  const [tab, setTab] = useState<SheetTab>(selection.engine === "opencompany" ? "chat" : "coding");
  const connectivity: Record<CodingEngine, AgentConnectivity> = {
    codex: useAgentConnectivity("codex"),
    claude_code: useAgentConnectivity("claude_code"),
  };
  const locked = locks.engineAndModel;
  const currentModelId = selectedModelId(selection);

  // A retired model stays visible for the conversation that still runs on it.
  const chatModelIds = [...(autoModelEnabled ? [AUTO_MODEL_ID] : []), ...CHAT_PICKER_MODEL_IDS];
  if (selection.engine === "opencompany" && !chatModelIds.includes(currentModelId))
    chatModelIds.unshift(currentModelId);

  const openWebSettings = async () => {
    if (!WEB_INFERENCE_SETTINGS_URL) return;
    analytics.capture("coding_agent_connect_opened");
    const [error] = await until(() => WebBrowser.openBrowserAsync(WEB_INFERENCE_SETTINGS_URL!));
    if (error) showErrorToast("The web app could not be opened.", error, "chat.model.web-settings");
  };

  const lockFooter = locked
    ? "This conversation keeps its engine and model. Start a new chat to use another."
    : undefined;
  const needsConnection = (["codex", "claude_code"] as const).some(
    (engine) =>
      connectivity[engine].state === "disconnected" ||
      connectivity[engine].state === "needs_reauth",
  );
  const codingEngine = selection.engine === "opencompany" ? null : selection.engine;
  const effort = effectiveEffort(selection);
  const effortSummary = [
    effort ? EFFORT_LABELS[effort] : null,
    codingEngine === "codex" && selection.codex.planModeEnabled ? "Plan" : null,
    codingEngine === "codex" && selection.codex.goalModeEnabled ? "Goal" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const showEffortRow = codingEngine === "codex" || effortOptions(selection).length > 0;

  return (
    <ScrollView
      contentContainerClassName="gap-5 px-4 pt-2 pb-10"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <Picker
          modifiers={[pickerStyle("segmented")]}
          onSelectionChange={(value) => setTab(value as SheetTab)}
          selection={tab}
        >
          <SwiftText modifiers={[tag("chat")]}>Chat</SwiftText>
          <SwiftText modifiers={[tag("coding")]}>Coding agents</SwiftText>
        </Picker>
      </Host>

      {tab === "chat" ? (
        <SheetSection footer={lockFooter}>
          {chatModelIds.map((modelId, index) => {
            const selected = selection.engine === "opencompany" && modelId === currentModelId;
            return (
              <Fragment key={modelId}>
                {index > 0 ? <SheetRowSeparator /> : null}
                <SheetRow
                  accessibilityLabel={modelLabel(modelId)}
                  accessory="check"
                  disabled={locked && !selected}
                  leading={<ModelLogo modelId={modelId} size={22} />}
                  onPress={() => {
                    if (!selected)
                      updateSelection((current) => ({
                        ...current,
                        engine: "opencompany",
                        chatModelId: modelId,
                      }));
                    close();
                  }}
                  selected={selected}
                  subtitle={modelDescription(modelId)}
                  title={modelLabel(modelId)}
                />
              </Fragment>
            );
          })}
        </SheetSection>
      ) : (
        <>
          <SheetSection footer={lockFooter}>
            {(["codex", "claude_code"] as const).map((engine, index) => {
              const state = connectivity[engine];
              const selected = selection.engine === engine;
              const connected = state.state === "connected";
              return (
                <Fragment key={engine}>
                  {index > 0 ? <SheetRowSeparator /> : null}
                  <SheetRow
                    accessibilityHint={connected ? undefined : connectivitySubtitle(engine, state)}
                    accessory="check"
                    disabled={(locked && !selected) || !connected}
                    leading={<ModelLogo modelId={AGENT_LOGO_MODELS[engine]} size={22} />}
                    onPress={() => {
                      if (!selected) updateSelection((current) => ({ ...current, engine }));
                    }}
                    selected={selected}
                    subtitle={
                      <Text
                        className={
                          state.state === "needs_reauth" || state.state === "error"
                            ? "text-[14px] text-warning leading-[19px]"
                            : "text-[14px] text-muted-foreground leading-[19px]"
                        }
                        numberOfLines={2}
                      >
                        {connectivitySubtitle(engine, state)}
                      </Text>
                    }
                    title={ENGINE_LABELS[engine]}
                    trailing={
                      state.state === "loading" ? (
                        <ActivityIndicator size="small" />
                      ) : state.state === "error" ? (
                        <Pressable
                          accessibilityLabel={`Check ${ENGINE_LABELS[engine]} connection again`}
                          accessibilityRole="button"
                          className="rounded-full bg-foreground/10 px-3 py-1 active:opacity-60"
                          hitSlop={6}
                          onPress={state.retry}
                        >
                          <Text className="font-medium text-[14px] text-foreground">Retry</Text>
                        </Pressable>
                      ) : null
                    }
                  />
                </Fragment>
              );
            })}
          </SheetSection>

          {codingEngine ? (
            <SheetSection
              footer={
                working
                  ? "Effort and modes can change once the current response finishes."
                  : undefined
              }
              title={ENGINE_LABELS[codingEngine]}
            >
              <SheetRow
                accessory="chevron"
                detail={modelLabel(currentModelId)}
                disabled={locked}
                onPress={() => router.push("/model-sheet/models")}
                title="Model"
              />
              {showEffortRow ? (
                <>
                  <SheetRowSeparator />
                  <SheetRow
                    accessory="chevron"
                    detail={effortSummary}
                    disabled={working}
                    onPress={() => router.push("/model-sheet/effort")}
                    title="Effort"
                  />
                </>
              ) : null}
            </SheetSection>
          ) : null}

          {needsConnection && WEB_INFERENCE_SETTINGS_URL ? (
            <SheetSection footer="Connect Codex or Claude Code once on the web, then pick it here.">
              <SheetRow
                leading={
                  <StyledSymbolView
                    name="arrow.up.forward.app"
                    size={18}
                    tintColorClassName="accent-accent"
                    weight="medium"
                  />
                }
                onPress={() => void openWebSettings()}
                title="Open Inference Settings"
              />
            </SheetSection>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
