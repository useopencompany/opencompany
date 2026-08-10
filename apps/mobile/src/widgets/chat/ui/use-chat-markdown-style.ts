import { StyleSheet } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { useCSSVariable } from "uniwind";

export function useChatMarkdownStyle(): MarkdownStyle {
  const [
    foreground,
    mutedForeground,
    secondary,
    secondaryForeground,
    muted,
    border,
    borderStrong,
    link,
  ] = useCSSVariable([
    "--color-foreground",
    "--color-muted-foreground",
    "--color-secondary",
    "--color-secondary-foreground",
    "--color-muted",
    "--color-border",
    "--color-border-strong",
    "--color-link",
  ]) as [string, string, string, string, string, string, string, string];
  const colors = {
    border,
    borderStrong,
    foreground,
    link,
    muted,
    mutedForeground,
    secondary,
    secondaryForeground,
  };

  return {
    paragraph: { color: colors.foreground, fontSize: 16, lineHeight: 24, marginBottom: 12 },
    h1: { color: colors.foreground, fontSize: 28, lineHeight: 34, marginBottom: 12 },
    h2: {
      color: colors.foreground,
      fontSize: 23,
      lineHeight: 29,
      marginBottom: 10,
      marginTop: 8,
    },
    h3: {
      color: colors.foreground,
      fontSize: 19,
      lineHeight: 25,
      marginBottom: 8,
      marginTop: 6,
    },
    strong: { color: colors.foreground, fontWeight: "bold" },
    em: { color: colors.mutedForeground, fontStyle: "italic" },
    link: { color: colors.link, underline: true },
    code: {
      backgroundColor: colors.secondary,
      borderColor: colors.border,
      color: colors.secondaryForeground,
      fontFamily: "Menlo",
      fontSize: 14,
    },
    codeBlock: {
      backgroundColor: colors.muted,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.foreground,
      fontFamily: "Menlo",
      fontSize: 14,
      lineHeight: 20,
      marginBottom: 12,
      padding: 12,
    },
    list: {
      bulletColor: colors.mutedForeground,
      color: colors.foreground,
      fontSize: 16,
      gapWidth: 8,
      lineHeight: 24,
      marginBottom: 12,
      markerColor: colors.mutedForeground,
    },
    blockquote: {
      backgroundColor: colors.muted,
      borderColor: colors.borderStrong,
      borderWidth: 3,
      color: colors.mutedForeground,
      fontSize: 16,
      gapWidth: 12,
      lineHeight: 24,
      marginBottom: 12,
    },
    image: { borderRadius: 12, height: 220, marginBottom: 14, marginTop: 4 },
    thematicBreak: {
      color: colors.border,
      height: StyleSheet.hairlineWidth,
      marginBottom: 18,
      marginTop: 10,
    },
  };
}
