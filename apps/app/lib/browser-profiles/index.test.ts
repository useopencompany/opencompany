import { describe, expect, it } from "vitest";
import {
  defaultAllowedBrowserProfileHosts,
  isBrowserProfileHostBlocked,
  loginAllowedBrowserProfileHosts,
  normalizeBrowserProfileSiteHost,
} from "./index";

describe("browser profile host policy", () => {
  it("normalizes user-entered site URLs to profile hosts", () => {
    expect(normalizeBrowserProfileSiteHost("https://app.notion.so/team")).toBe("notion.so");
    expect(normalizeBrowserProfileSiteHost("linear.app")).toBe("linear.app");
    expect(normalizeBrowserProfileSiteHost("https://accounts.service.co.uk/path")).toBe(
      "service.co.uk",
    );
  });

  it("keeps stored profile hosts narrow and adds auth hosts only for login handoff", () => {
    expect(defaultAllowedBrowserProfileHosts("notion.so")).toEqual(["notion.so"]);
    expect(loginAllowedBrowserProfileHosts(["notion.so"])).toEqual(
      expect.arrayContaining(["notion.so", "accounts.google.com", "login.microsoftonline.com"]),
    );
  });

  it("blocks excluded commerce and banking domains", () => {
    expect(isBrowserProfileHostBlocked("amazon.com")).toBe(true);
    expect(isBrowserProfileHostBlocked("www.chase.com")).toBe(true);
    expect(isBrowserProfileHostBlocked("notion.so")).toBe(false);
  });
});
