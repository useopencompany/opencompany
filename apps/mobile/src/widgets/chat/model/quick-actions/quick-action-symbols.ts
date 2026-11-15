import type { SFSymbol } from "expo-symbols";
import { type ColorValue, PlatformColor } from "react-native";
import type { ComposerTokenKind } from "./composer-segments";

/** iOS system colors by name. Native resolves the same names, so tags and menu rows match. */
export type QuickActionTint =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "mint"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "brown"
  | "gray";

export interface QuickActionPresentation {
  symbol: SFSymbol;
  /** Untinted symbols follow the surrounding text color. */
  tint?: QuickActionTint;
}

const REPOSITORY: QuickActionPresentation = { symbol: "arrow.triangle.branch" };
const KEY: QuickActionPresentation = { symbol: "key.fill", tint: "orange" };

const PLUGINS: Record<string, QuickActionPresentation> = {
  attio: { symbol: "person.2.fill", tint: "indigo" },
  betterstack: { symbol: "waveform.path.ecg", tint: "green" },
  convex: { symbol: "square.stack.3d.up.fill", tint: "orange" },
  dash0: { symbol: "gauge.with.dots.needle.67percent", tint: "blue" },
  doppler: KEY,
  fathom: { symbol: "video.fill", tint: "purple" },
  github: REPOSITORY,
  gmail: { symbol: "envelope.fill", tint: "red" },
  "google-admin": { symbol: "person.badge.key.fill", tint: "blue" },
  "google-calendar": { symbol: "calendar", tint: "blue" },
  "google-drive": { symbol: "folder.fill", tint: "yellow" },
  granola: { symbol: "note.text", tint: "green" },
  hubspot: { symbol: "person.crop.circle.badge.checkmark", tint: "orange" },
  infisical: KEY,
  jamie: { symbol: "mic.fill", tint: "pink" },
  latitude: { symbol: "scope", tint: "teal" },
  "lead-research": { symbol: "magnifyingglass", tint: "teal" },
  linear: { symbol: "checklist", tint: "indigo" },
  neon: { symbol: "cylinder.split.1x2", tint: "green" },
  notion: { symbol: "doc.text" },
  posthog: { symbol: "chart.bar.xaxis", tint: "orange" },
  render: { symbol: "server.rack", tint: "purple" },
  resend: { symbol: "paperplane.fill", tint: "gray" },
  signoz: { symbol: "chart.xyaxis.line", tint: "orange" },
  slack: { symbol: "number", tint: "purple" },
  stripe: { symbol: "creditcard.fill", tint: "indigo" },
  supabase: { symbol: "bolt.fill", tint: "green" },
  todoist: { symbol: "checkmark.circle.fill", tint: "red" },
  vercel: { symbol: "triangle.fill" },
  x: { symbol: "xmark" },
  "yc-advise": { symbol: "lightbulb.fill", tint: "orange" },
};

const UNKNOWN_PLUGIN: QuickActionPresentation = { symbol: "puzzlepiece.extension.fill" };

/**
 * How a tag looks, from its kind and id alone. Drafts restore their tags from stored text without
 * waiting for the network catalog.
 */
export const tokenPresentation = (kind: ComposerTokenKind, id: string): QuickActionPresentation => {
  switch (kind) {
    case "plugin":
      return PLUGINS[id] ?? UNKNOWN_PLUGIN;
    case "repository":
      return REPOSITORY;
    case "skill":
      return { symbol: "wand.and.stars", tint: "purple" };
    case "workflow":
      return { symbol: "point.3.connected.trianglepath.dotted", tint: "teal" };
    case "task":
      return { symbol: "play.circle.fill", tint: "green" };
  }
};

export const tintColor = (tint: QuickActionTint): ColorValue =>
  PlatformColor(`system${tint[0]!.toUpperCase()}${tint.slice(1)}`);
