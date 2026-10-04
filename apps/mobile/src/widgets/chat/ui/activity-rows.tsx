import type { ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { PressableScale } from "@/shared/ui/pressable-scale";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import type { ReasoningPart, ToolPart, ToolStatus } from "../model/chat";
import { TOOL_STATUS_TEXT, toolPresentation } from "../model/tool-presentation";

const LARGE_TEXT_SCALE = 1.6;

const STATUS_CLASS: Record<ToolStatus, string> = {
  running: "text-muted-foreground",
  waiting: "text-warning",
  completed: "text-muted-foreground",
  failed: "text-destructive",
  denied: "text-destructive",
  interrupted: "text-muted-foreground",
};

/** Opening words of a reasoning block, without the Markdown markers that would show raw. */
export const reasoningExcerpt = (text: string) =>
  text
    .replace(/[*_`#>]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

export function ReasoningRow({ part, onPress }: { part: ReasoningPart; onPress: () => void }) {
  const excerpt = reasoningExcerpt(part.text);
  return (
    <PressableScale
      accessibilityHint="Opens the full reasoning"
      accessibilityLabel={`${part.streaming ? "Reasoning, in progress" : "Reasoning"}. ${excerpt}`}
      className="min-h-11 flex-row items-center gap-2 py-1"
      onPress={onPress}
    >
      <Text className="flex-1 text-[14px] leading-5 text-muted-foreground" numberOfLines={2}>
        {excerpt}
      </Text>
      <StyledSymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-muted-foreground"
      />
    </PressableScale>
  );
}

export function ToolCard({ part, onPress }: { part: ToolPart; onPress: () => void }) {
  const { label, target, symbol } = toolPresentation(part);
  const status = TOOL_STATUS_TEXT[part.status];
  const failed = part.status === "failed" || part.status === "denied";
  // At accessibility text sizes the status moves under the name, so the name stays readable.
  const stacked = useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
  // A failure is what the reader needs to see; the target is one tap away in the sheet.
  const secondLine = failed ? (part.error ?? target) : target;
  return (
    <PressableScale
      accessibilityHint="Shows the input and result"
      accessibilityLabel={[label, status, secondLine].filter(Boolean).join(", ")}
      className="min-h-11 flex-row items-center gap-3 rounded-2xl border-continuous bg-secondary/60 px-3.5 py-2.5"
      onPress={onPress}
    >
      <StyledSymbolView
        name={failed ? "exclamationmark.triangle" : symbol}
        size={16}
        tintColorClassName={failed ? "accent-destructive" : "accent-muted-foreground"}
      />
      <View className="flex-1 gap-0.5">
        <View className={stacked ? "gap-0.5" : "flex-row items-baseline gap-2"}>
          <Text
            className="shrink text-[15px] font-medium text-foreground"
            numberOfLines={stacked ? 3 : 1}
          >
            {label}
          </Text>
          <Text className={`text-[13px] ${STATUS_CLASS[part.status]}`}>{status}</Text>
        </View>
        {secondLine ? (
          <Text
            className={
              failed
                ? "text-[13px] leading-[18px] text-destructive"
                : "font-mono text-[12px] leading-[18px] text-muted-foreground"
            }
            numberOfLines={failed ? 2 : 1}
          >
            {secondLine}
          </Text>
        ) : null}
      </View>
      <StyledSymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-muted-foreground"
      />
    </PressableScale>
  );
}

/** A subagent's own trace, nested under its card in the order it happened. */
export function NestedTrace({ children }: { children: ReactNode }) {
  return <View className="ml-3 gap-2.5 border-l border-border pl-3">{children}</View>;
}

export function TraceDisclosure({
  expanded,
  summary,
  onToggle,
}: {
  expanded: boolean;
  summary: string;
  onToggle: () => void;
}) {
  return (
    <PressableScale
      accessibilityHint={expanded ? "Hides the earlier activity" : "Shows the earlier activity"}
      accessibilityLabel={summary}
      accessibilityState={{ expanded }}
      className="min-h-11 flex-row items-center gap-1.5 self-start pr-3"
      onPress={onToggle}
    >
      <StyledSymbolView
        name={expanded ? "chevron.down" : "chevron.right"}
        size={11}
        tintColorClassName="accent-muted-foreground"
      />
      <Text className="text-[13px] font-medium text-muted-foreground">{summary}</Text>
    </PressableScale>
  );
}
