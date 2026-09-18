import { describe, expect, it } from "vitest";
import { actionIdentity, actionRowLabel, actionSource, actionVerb } from "@/lib/action-identity";

describe("action identity", () => {
  it("names a plugin gateway action by its service and what it does", () => {
    expect(actionIdentity("plugin:linear:linear.create_issue")).toEqual({
      source: "linear",
      sourceLabel: "Linear",
      actionLabel: "Create issue",
    });
  });

  it("uses the catalog's spelling of a service rather than its slug", () => {
    expect(actionRowLabel("plugin:posthog:posthog.list_insights")).toBe("PostHog · List insights");
    expect(actionRowLabel("plugin:betterstack:betterstack.list_monitors")).toBe(
      "Better Stack · List monitors",
    );
    expect(actionRowLabel("google_calendar.list_events")).toBe("Google Calendar · List events");
  });

  it("names the service, not the connection, for a personal account", () => {
    expect(actionRowLabel("x_account.post_tweet")).toBe("X · Post tweet");
    expect(actionRowLabel("github_user.create_pull_request")).toBe("GitHub · Create pull request");
  });

  it("names a managed capability after the service behind it", () => {
    expect(actionRowLabel("lead.search_prospects")).toBe("Lead research · Search prospects");
    expect(actionRowLabel("linkedin.search_posts")).toBe("LinkedIn · Search posts");
  });

  it("drops a service prefix a gateway repeats in its tool name", () => {
    expect(actionVerb("plugin:slack:slack.slack_search_public_and_private")).toBe(
      "search public and private",
    );
    expect(actionVerb("plugin:google-drive:google-drive.google_drive_list_files")).toBe(
      "list files",
    );
    expect(actionVerb("plugin:linear:linear.save_comment")).toBe("save comment");
  });

  it("does not present a user-named MCP server as a known brand", () => {
    expect(actionIdentity("plugin:custom-0123456789abcdef01234567:deploy.release")).toEqual({
      source: "custom-0123456789abcdef01234567",
      sourceLabel: "Custom integration",
      actionLabel: "Release",
    });
  });

  it("falls back to the id's own words for a service it does not know", () => {
    expect(actionRowLabel("revolut.list_accounts")).toBe("Revolut · List accounts");
    expect(actionIdentity("session_history")).toEqual({
      source: "session_history",
      sourceLabel: "Session history",
      actionLabel: null,
    });
  });

  it("reads the source out of every id shape", () => {
    expect(actionSource("plugin:notion:notion.search")).toBe("notion");
    expect(actionSource("stripe.get_balance")).toBe("stripe");
    expect(actionSource("")).toBe("");
    expect(actionRowLabel("")).toBe("Action");
  });
});
