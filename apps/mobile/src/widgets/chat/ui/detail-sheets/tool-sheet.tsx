import { Stack, useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import { FlatList, type ListRenderItemInfo, Text, View } from "react-native";
import { useResolveClassNames } from "uniwind";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import type { ToolPart } from "../../model/chat";
import { TOOL_STATUS_TEXT, toolPresentation } from "../../model/tool-presentation";
import { useChatPart } from "../../model/use-chat-part";
import { CopyButton, ReloadButton, SheetLoading, SheetUnavailable } from "./sheet-states";

// Payloads render as a list of text chunks, so a megabyte of output scrolls without laying out
// as one text view. Nothing is dropped: every line lands in some chunk.
const CHUNK_MAX_LINES = 60;
const CHUNK_MAX_CHARACTERS = 4_000;
// How close to the end counts as reading the newest content.
const FOLLOW_THRESHOLD = 24;

type Row =
  | { key: string; kind: "status" }
  | { key: string; kind: "section"; title: "Input" | "Result"; copyText: string | null }
  | { key: string; kind: "chunk"; text: string; tone: "value" | "error" }
  | { key: string; kind: "note"; text: string; reload?: boolean };

/** Strings stay text; anything structured prints as indented JSON. */
const formatValue = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));

const isEmptyValue = (value: unknown) =>
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && value !== null && Object.keys(value).length === 0);

const chunkText = (text: string): string[] => {
  const chunks: string[] = [];
  let lines: string[] = [];
  let length = 0;
  const flush = () => {
    if (lines.length > 0) chunks.push(lines.join("\n"));
    lines = [];
    length = 0;
  };
  for (const line of text.split("\n")) {
    // A single minified line can be enormous; it still splits into readable pieces.
    for (let start = 0; start === 0 || start < line.length; start += CHUNK_MAX_CHARACTERS) {
      const piece = line.slice(start, start + CHUNK_MAX_CHARACTERS);
      if (lines.length >= CHUNK_MAX_LINES || length + piece.length > CHUNK_MAX_CHARACTERS) flush();
      lines.push(piece);
      length += piece.length + 1;
    }
  }
  flush();
  return chunks;
};

const valueRows = (prefix: string, value: unknown, tone: "value" | "error"): Row[] =>
  chunkText(formatValue(value)).map((text, index) => ({
    key: `${prefix}:${index}`,
    kind: "chunk",
    text,
    tone,
  }));

const inputRows = (tool: ToolPart): Row[] => {
  if (!("input" in tool)) {
    return [
      { key: "input", kind: "section", title: "Input", copyText: null },
      {
        key: "input:missing",
        kind: "note",
        text: "The input is not on this device yet.",
        reload: true,
      },
    ];
  }
  const text = formatValue(tool.input);
  return [
    { key: "input", kind: "section", title: "Input", copyText: text },
    ...(isEmptyValue(tool.input)
      ? [{ key: "input:empty", kind: "note", text: "No input." } satisfies Row]
      : valueRows("input", tool.input, "value")),
  ];
};

const resultRows = (tool: ToolPart): Row[] => {
  const hasOutput = "output" in tool;
  const failed = tool.status === "failed" || tool.status === "denied";
  const copyParts = [failed ? tool.error : null, hasOutput ? formatValue(tool.output) : null];
  const copyText = copyParts.filter((part): part is string => Boolean(part)).join("\n\n") || null;
  const rows: Row[] = [{ key: "result", kind: "section", title: "Result", copyText }];
  // A failure leads, so a long result cannot push it out of view.
  if (failed) {
    rows.push(
      ...valueRows(
        "error",
        tool.error ?? (tool.status === "denied" ? "The action was declined." : "The tool failed."),
        "error",
      ),
    );
  }
  if (hasOutput) {
    rows.push(
      ...(isEmptyValue(tool.output)
        ? [{ key: "result:empty", kind: "note", text: "The tool returned an empty result." } as Row]
        : valueRows("result", tool.output, "value")),
    );
    return rows;
  }
  if (failed) return rows;
  if (tool.status === "running") {
    rows.push({ key: "result:waiting", kind: "note", text: "Waiting for the result…" });
  } else if (tool.status === "waiting") {
    rows.push({ key: "result:waiting", kind: "note", text: "Waiting for your approval." });
  } else if (tool.status === "interrupted") {
    rows.push({ key: "result:none", kind: "note", text: "Stopped before returning a result." });
  } else if (tool.summary) {
    rows.push(...valueRows("summary", tool.summary, "value"));
    rows.push({
      key: "result:partial",
      kind: "note",
      text: "This is a summary. The full result is not on this device yet.",
      reload: true,
    });
  } else {
    rows.push({
      key: "result:missing",
      kind: "note",
      text: "The result is not on this device yet.",
      reload: true,
    });
  }
  return rows;
};

export default function ToolSheet() {
  const params = useLocalSearchParams<{
    conversationId: string;
    messageId: string;
    partId: string;
  }>();
  const { part, isLoading, isOffline, reload, isReloading } = useChatPart("tool", params);
  const listStyle = useResolveClassNames("flex-1");
  const contentStyle = useResolveClassNames("px-5 pt-2 pb-10");
  const listRef = useRef<FlatList<Row>>(null);
  // Where the reader is, so new content is followed only from the end.
  const scrollMetrics = useRef({ offset: 0, viewport: 0, content: 0 });

  if (!part) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen options={{ title: "Tool call" }} />
        {isLoading ? (
          <SheetLoading />
        ) : (
          <SheetUnavailable
            isOffline={isOffline}
            isReloading={isReloading}
            message="This tool call's details are not on this device."
            onReload={reload}
            title="Details unavailable"
          />
        )}
      </View>
    );
  }

  const { label, target, symbol } = toolPresentation(part);
  const rows: Row[] = [{ key: "status", kind: "status" }, ...inputRows(part), ...resultRows(part)];
  const failed = part.status === "failed" || part.status === "denied";

  const renderRow = ({ item }: ListRenderItemInfo<Row>) => {
    switch (item.kind) {
      case "status":
        return (
          <View className="gap-1.5 pb-4">
            <View className="flex-row items-center gap-2">
              <StyledSymbolView
                name={failed ? "exclamationmark.triangle.fill" : symbol}
                size={15}
                tintColorClassName={failed ? "accent-destructive" : "accent-muted-foreground"}
              />
              <Text
                className={`text-[15px] font-medium ${failed ? "text-destructive" : "text-muted-foreground"}`}
              >
                {TOOL_STATUS_TEXT[part.status]}
              </Text>
            </View>
            {target ? (
              <Text selectable className="font-mono text-[13px] leading-[19px] text-foreground">
                {target}
              </Text>
            ) : null}
          </View>
        );
      case "section":
        return (
          <View className="mt-3 flex-row items-center justify-between border-t border-border pt-2">
            <Text accessibilityRole="header" className="text-[17px] font-semibold text-foreground">
              {item.title}
            </Text>
            {item.copyText ? <CopyButton label={item.title} text={item.copyText} /> : null}
          </View>
        );
      case "chunk":
        return (
          <Text
            selectable
            className={
              item.tone === "error"
                ? "pb-2 text-[15px] leading-[21px] text-destructive"
                : "font-mono text-[13px] leading-[19px] text-foreground"
            }
          >
            {item.text}
          </Text>
        );
      case "note":
        return (
          <View className="gap-2 py-1">
            <Text className="text-[15px] leading-[21px] text-muted-foreground">{item.text}</Text>
            {item.reload && !isOffline ? (
              <ReloadButton isReloading={isReloading} onReload={reload} />
            ) : null}
          </View>
        );
    }
  };

  // The list must be the screen's root view: a form sheet only tracks a scroll view it finds
  // there, and one wrapped in another view stops painting when the sheet changes detent.
  return (
    <>
      <Stack.Screen options={{ title: label }} />
      <FlatList
        contentContainerStyle={contentStyle}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        extraData={[part, isReloading, isOffline]}
        initialNumToRender={12}
        keyExtractor={(row) => row.key}
        onContentSizeChange={(_width, height) => {
          const metrics = scrollMetrics.current;
          const wasAtEnd =
            metrics.content > metrics.viewport &&
            metrics.offset + metrics.viewport >= metrics.content - FOLLOW_THRESHOLD;
          metrics.content = height;
          if (wasAtEnd) listRef.current?.scrollToEnd({ animated: false });
        }}
        onLayout={(event) => {
          scrollMetrics.current.viewport = event.nativeEvent.layout.height;
        }}
        onScroll={(event) => {
          scrollMetrics.current.offset = event.nativeEvent.contentOffset.y;
        }}
        ref={listRef}
        renderItem={renderRow}
        scrollEventThrottle={32}
        style={listStyle}
        windowSize={9}
      />
    </>
  );
}
