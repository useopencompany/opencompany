import type { MenuItem } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => "0.1.0" },
  check: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock("@todesktop/runtime", () => ({
  default: { autoUpdater: { checkForUpdates: mocks.check } },
}));
vi.mock("electron", () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox } }));

import { checkForUpdates } from "./updates";

describe("manual update checks", () => {
  let menuItem: MenuItem;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.app.isPackaged = true;
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    menuItem = { enabled: true, label: "Check for Updates…" } as MenuItem;
  });

  it("reports the installed version when no update is available", async () => {
    mocks.check.mockResolvedValue({ updateInfo: null });
    await checkForUpdates(menuItem);
    expect(mocks.check).toHaveBeenCalledWith({ source: "menu" });
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "You're up to date",
        detail: expect.stringContaining("0.1.0"),
      }),
    );
    expect(menuItem.enabled).toBe(true);
  });

  it("leaves the download prompt to ToDesktop", async () => {
    mocks.check.mockResolvedValue({ updateInfo: { version: "0.1.1" } });
    await checkForUpdates(menuItem);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("shows a safe error and lets the user retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.check.mockRejectedValue(new Error("https://example.test/?token=secret"));
    await checkForUpdates(menuItem);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Couldn't check for updates" }),
    );
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toContain("secret");
    expect(warning).toHaveBeenCalledWith("[opencompany-desktop] Update check failed");
    expect(menuItem).toMatchObject({ enabled: true, label: "Check for Updates…" });
    warning.mockRestore();
  });

  it("prevents overlapping manual checks", async () => {
    let finish!: (value: { updateInfo: null }) => void;
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = checkForUpdates(menuItem);
    expect(menuItem).toMatchObject({ enabled: false, label: "Checking for Updates…" });
    await checkForUpdates(menuItem);
    expect(mocks.check).toHaveBeenCalledOnce();
    finish({ updateInfo: null });
    await first;
    expect(menuItem.enabled).toBe(true);
  });

  it("does not claim development Electron is up to date", async () => {
    mocks.app.isPackaged = false;
    await checkForUpdates(menuItem);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Updates are available in the installed app" }),
    );
  });
});
