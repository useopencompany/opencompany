import {
  BetterStackIcon,
  BraintrustIcon,
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  InstagramIcon,
  LinearIcon,
  NeonIcon,
  NotionIcon,
  PostHogIcon,
  SlackIcon,
  TikTokIcon,
  XIcon,
  YouTubeIcon,
} from "@opencompany/ui/icons";
import { describe, expect, it } from "vitest";
import { toolServiceIcon } from "./tool-service-icon";

describe("toolServiceIcon", () => {
  it("maps unwrapped MCP tool names by their provider prefix", () => {
    expect(toolServiceIcon("linear__create_issue")).toBe(LinearIcon);
    expect(toolServiceIcon("slack__chat_postMessage")).toBe(SlackIcon);
    expect(toolServiceIcon("posthog__query_run")).toBe(PostHogIcon);
    expect(toolServiceIcon("notion__search")).toBe(NotionIcon);
    expect(toolServiceIcon("betterstack__list_monitors")).toBe(BetterStackIcon);
    expect(toolServiceIcon("braintrust__list_experiments")).toBe(BraintrustIcon);
  });

  it("maps hosted tool names by their service prefix", () => {
    expect(toolServiceIcon("gmail_list_messages")).toBe(GmailIcon);
    expect(toolServiceIcon("calendar_create_event")).toBe(GoogleCalendarIcon);
    expect(toolServiceIcon("drive_search_files")).toBe(GoogleDriveIcon);
    expect(toolServiceIcon("x_search_posts")).toBe(XIcon);
    expect(toolServiceIcon("youtube_search")).toBe(YouTubeIcon);
    expect(toolServiceIcon("tiktok_get_profile")).toBe(TikTokIcon);
    expect(toolServiceIcon("instagram_get_profile")).toBe(InstagramIcon);
    expect(toolServiceIcon("neon_run_sql")).toBe(NeonIcon);
  });

  it("maps the gh CLI tool to GitHub", () => {
    expect(toolServiceIcon("gh")).toBe(GitHubIcon);
  });

  it("returns null for internal/generic tools and unknown services", () => {
    expect(toolServiceIcon("shell")).toBeNull();
    expect(toolServiceIcon("read_file")).toBeNull();
    expect(toolServiceIcon("web_fetch")).toBeNull();
    expect(toolServiceIcon("use_tool")).toBeNull();
    // Exa has no clean brand glyph, so it falls back to the wrench.
    expect(toolServiceIcon("exa_search")).toBeNull();
    // MCP-style name for a provider we have no glyph for.
    expect(toolServiceIcon("unknownprovider__do_thing")).toBeNull();
    expect(toolServiceIcon("")).toBeNull();
  });
});
