"use client";

// The brand mark for a connectable service, in one place. The plugin catalog badges rows and
// detail headers with these, and tool rows badge a connected action with the service it touched,
// so a Linear call looks like Linear everywhere it appears.

import {
  AttioIcon,
  BetterStackIcon,
  ConvexIcon,
  Dash0Icon,
  FathomIcon,
  GitHubIcon,
  GmailIcon,
  GoogleAdminIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GranolaIcon,
  HubSpotIcon,
  InfisicalIcon,
  JamieIcon,
  LatitudeIcon,
  LinearIcon,
  LinkedInIcon,
  type LucideIcon,
  NeonIcon,
  NotionIcon,
  PostHogIcon,
  RenderIcon,
  ResendIcon,
  SigNozIcon,
  SlackIcon,
  StripeIcon,
  SupabaseIcon,
  TikTokIcon,
  VercelIcon,
  XIcon,
  YouTubeIcon,
} from "@opencompany/ui/icons";
import { Crosshair, KeyRound, Sparkles } from "lucide-react";

export type ServiceMark = {
  Icon: LucideIcon;
  /** Badge treatment for the mark: the vendor's background and foreground. */
  iconClassName: string;
};

export const SERVICE_MARKS = {
  attio: { Icon: AttioIcon, iconClassName: "bg-[#111111] text-white" },
  betterstack: { Icon: BetterStackIcon, iconClassName: "bg-[#1B1F23] text-white" },
  convex: { Icon: ConvexIcon, iconClassName: "bg-surface-muted" },
  dash0: { Icon: Dash0Icon, iconClassName: "bg-background" },
  doppler: { Icon: KeyRound, iconClassName: "bg-[#FF6100] text-white" },
  fathom: { Icon: FathomIcon, iconClassName: "bg-[#101820] text-white" },
  github: { Icon: GitHubIcon, iconClassName: "bg-[#181717] text-white" },
  gmail: { Icon: GmailIcon, iconClassName: "bg-white text-[#EA4335]" },
  "google-admin": { Icon: GoogleAdminIcon, iconClassName: "bg-white" },
  "google-calendar": { Icon: GoogleCalendarIcon, iconClassName: "bg-[#1A73E8] text-white" },
  "google-drive": { Icon: GoogleDriveIcon, iconClassName: "bg-white text-[#1FA463]" },
  granola: { Icon: GranolaIcon, iconClassName: "bg-[#F0EBE1] text-[#1A1714]" },
  hubspot: { Icon: HubSpotIcon, iconClassName: "bg-[#FF7A59] text-white" },
  infisical: { Icon: InfisicalIcon, iconClassName: "bg-[#6C47FF] text-white" },
  jamie: { Icon: JamieIcon, iconClassName: "bg-[#5B5BD6] text-white" },
  latitude: { Icon: LatitudeIcon, iconClassName: "bg-[#171717] text-white" },
  "lead-research": { Icon: Crosshair, iconClassName: "bg-[#1F6FEB] text-white" },
  linear: { Icon: LinearIcon, iconClassName: "bg-[#5E6AD2] text-white" },
  linkedin: { Icon: LinkedInIcon, iconClassName: "bg-[#0A66C2] text-white" },
  neon: { Icon: NeonIcon, iconClassName: "bg-[#00E599] text-[#0B0F14]" },
  notion: { Icon: NotionIcon, iconClassName: "bg-white text-black" },
  posthog: { Icon: PostHogIcon, iconClassName: "bg-[#F54E00] text-white" },
  render: { Icon: RenderIcon, iconClassName: "bg-[#0B0D0E] text-white" },
  resend: { Icon: ResendIcon, iconClassName: "bg-black text-white" },
  signoz: { Icon: SigNozIcon, iconClassName: "bg-[#0B0D0E] text-white" },
  slack: { Icon: SlackIcon, iconClassName: "bg-white text-[#4A154B]" },
  stripe: { Icon: StripeIcon, iconClassName: "bg-[#635BFF] text-white" },
  supabase: { Icon: SupabaseIcon, iconClassName: "bg-[#003D2B] text-[#3ECF8E]" },
  tiktok: { Icon: TikTokIcon, iconClassName: "bg-black text-white" },
  vercel: { Icon: VercelIcon, iconClassName: "bg-black text-white" },
  x: { Icon: XIcon, iconClassName: "bg-black text-white" },
  "yc-advise": { Icon: Sparkles, iconClassName: "bg-[#F26522] text-white" },
  youtube: { Icon: YouTubeIcon, iconClassName: "bg-white text-[#FF0000]" },
} as const satisfies Record<string, ServiceMark>;

export type ServiceMarkSlug = keyof typeof SERVICE_MARKS;

// An action id names its source by connection provider or managed capability source, which is not
// always the slug the service is catalogued under.
const ACTION_SOURCE_MARKS: Readonly<Record<string, ServiceMarkSlug>> = {
  "github-user": "github",
  lead: "lead-research",
};

/**
 * The mark for an action's source slug — a plugin name ("google-drive"), a connection provider
 * ("google_drive"), or a managed capability source ("lead"). Null when the service has no mark of
 * its own, which is normal for custom MCP servers and for capabilities with no vendor behind them.
 */
export function actionSourceMark(source: string): ServiceMark | null {
  const slug = source.trim().toLowerCase().replace(/_+/gu, "-");
  const marked = ACTION_SOURCE_MARKS[slug] ?? slug;
  return Object.hasOwn(SERVICE_MARKS, marked) ? SERVICE_MARKS[marked as ServiceMarkSlug] : null;
}
