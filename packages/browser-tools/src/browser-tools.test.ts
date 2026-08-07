import { describe, expect, it } from "vitest";
import {
  AGENT_BROWSER_ACTION_POLICY,
  buildBrowserReadArgv,
  buildBrowserToolArgv,
  createBrowserObservationBudget,
  modelFacingBrowserOutput,
} from "./index";

const base = {
  sessionId: "task-1",
  actionPolicyPath: "/tmp/policy.json",
};

describe("browser command translation", () => {
  it("builds safe open and compact snapshot commands", () => {
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_open",
        args: { url: "https://example.com/search?q=mouse" },
      }),
    ).toEqual([
      "--session",
      "task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "open",
      "https://example.com/search?q=mouse",
    ]);

    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_snapshot",
        args: {},
      }).slice(-5),
    ).toEqual(["snapshot", "-i", "-c", "-d", "5"]);
  });

  it("threads CDP sessions and blocks profile navigation outside allowed hosts", () => {
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_open",
        args: { url: "https://app.notion.so/workspace" },
        cdpUrl: "wss://browserbase.example/session",
        allowedHosts: ["notion.so", "accounts.google.com"],
      }),
    ).toEqual([
      "--session",
      "task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "--cdp",
      "wss://browserbase.example/session",
      "open",
      "https://app.notion.so/workspace",
    ]);

    expect(() =>
      buildBrowserToolArgv({
        ...base,
        name: "browser_open",
        args: { url: "https://notion.so.evil.example/" },
        allowedHosts: ["notion.so"],
      }),
    ).toThrow("outside the active browser profile's allowed domains");
    expect(() =>
      buildBrowserReadArgv({
        ...base,
        args: { url: "https://example.com" },
        allowedHosts: ["notion.so"],
      }),
    ).toThrow("outside the active browser profile's allowed domains");
  });

  it("builds get, find, scroll, native read, and explicit screenshot paths", () => {
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_get",
        args: { target: "attr", ref: "e2", attribute: "href" },
      }).slice(-4),
    ).toEqual(["get", "attr", "@e2", "href"]);
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_find",
        args: {
          by: "label",
          value: "Search",
          action: "type",
          text: "SSD",
          exact: true,
        },
      }).slice(-6),
    ).toEqual(["find", "label", "Search", "type", "SSD", "--exact"]);
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_scroll",
        args: { direction: "down", pixels: 900 },
      }).slice(-3),
    ).toEqual(["scroll", "down", "900"]);
    expect(
      buildBrowserReadArgv({
        ...base,
        args: {
          url: "https://example.com/docs",
          filter: "auth",
          outline: true,
        },
      }).slice(-5),
    ).toEqual(["read", "https://example.com/docs", "--filter", "auth", "--outline"]);
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_screenshot",
        args: { fullPage: true },
        screenshotPath: "/vercel/sandbox/screenshots/page.png",
      }).slice(-3),
    ).toEqual(["screenshot", "--full", "/vercel/sandbox/screenshots/page.png"]);
  });

  it("normalizes refs and rejects unsafe or malformed input", () => {
    expect(
      buildBrowserToolArgv({
        ...base,
        name: "browser_click",
        args: { ref: "e12" },
      }),
    ).toContain("@e12");
    expect(() =>
      buildBrowserToolArgv({
        ...base,
        name: "browser_open",
        args: { url: "file:///etc/passwd" },
      }),
    ).toThrow("browser_open url must use http or https.");
    expect(() =>
      buildBrowserToolArgv({
        ...base,
        name: "browser_open",
        args: { url: "https://user:secret@example.com/" },
      }),
    ).toThrow("browser_open url must not include credentials.");
    expect(() =>
      buildBrowserToolArgv({
        ...base,
        name: "browser_find",
        args: { by: "nth", value: "ignored", action: "click" },
      }),
    ).toThrow("browser_find index is required");
  });

  it("keeps the action policy default-deny", () => {
    expect(AGENT_BROWSER_ACTION_POLICY.default).toBe("deny");
    expect(AGENT_BROWSER_ACTION_POLICY.allow).toContain("close");
    expect(AGENT_BROWSER_ACTION_POLICY.deny).toEqual(
      expect.arrayContaining(["eval", "download", "upload", "network", "state"]),
    );
  });
});

describe("browser observation budgets", () => {
  it("compacts oversized observations but not action confirmations", () => {
    const budget = createBrowserObservationBudget();
    const bigSnapshot = [
      "--- AGENT_BROWSER_PAGE_CONTENT origin=https://example.com ---",
      ...Array.from({ length: 500 }, (_, index) => `- link "Product ${index}" [ref=e${index}]`),
    ].join("\n");
    const output = modelFacingBrowserOutput({
      name: "browser_snapshot",
      output: { ok: true, command: "browser_snapshot", output: bigSnapshot },
      budget,
    }) as Record<string, unknown>;
    expect(output.compacted).toBe(true);
    expect(String(output.output)).toContain("Browser output compacted");

    const confirmation = {
      ok: true,
      command: "browser_click",
      output: "✓ Done".repeat(5000),
    };
    expect(
      modelFacingBrowserOutput({
        name: "browser_click",
        output: confirmation,
        budget,
      }),
    ).toBe(confirmation);
  });

  it("compacts after the cumulative and snapshot budgets are exceeded", () => {
    const budget = createBrowserObservationBudget();
    for (let index = 0; index < 6; index += 1) {
      modelFacingBrowserOutput({
        name: "browser_snapshot",
        output: { output: `snapshot ${index}` },
        budget,
      });
    }
    const output = modelFacingBrowserOutput({
      name: "browser_snapshot",
      output: { output: "seventh snapshot" },
      budget,
    }) as Record<string, unknown>;
    expect(output.compacted).toBe(true);
    expect(budget.snapshotCount).toBe(7);
  });
});
