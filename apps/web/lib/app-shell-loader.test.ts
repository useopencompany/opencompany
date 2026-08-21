import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOptionalAppShellData } from "./app-shell-loader";

vi.mock("@opencompany/observability", () => ({ captureException: vi.fn() }));

describe("loadOptionalAppShellData", () => {
  beforeEach(() => {
    vi.mocked(captureException).mockReset();
  });

  it("returns successfully loaded data", async () => {
    const value = await loadOptionalAppShellData("recent_chats", async () => ["chat_1"], []);

    expect(value).toEqual(["chat_1"]);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports a failed optional load and returns its safe fallback", async () => {
    const failure = new Error("integration lookup failed");
    const value = await loadOptionalAppShellData(
      "google_integrations",
      async () => {
        throw failure;
      },
      { connected: false },
    );

    expect(value).toEqual({ connected: false });
    expect(captureException).toHaveBeenCalledWith(failure, {
      event: "opencompany.web_app_shell_optional_load_failed",
      source: "google_integrations",
    });
  });
});
