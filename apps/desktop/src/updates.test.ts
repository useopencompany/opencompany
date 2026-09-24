import { EventEmitter } from "node:events";
import type { MenuItem } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ORIGIN } from "./urls";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => "0.2.0" },
  showMessageBox: vi.fn(),
  send: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  updater: null as unknown as EventEmitter & {
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
  },
  nativeUpdater: null as unknown as EventEmitter,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  mocks.nativeUpdater = new EventEmitter();
  const register = (channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.ipcHandlers.set(channel, handler);
  };
  return {
    app: mocks.app,
    autoUpdater: mocks.nativeUpdater,
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] },
    dialog: { showMessageBox: mocks.showMessageBox },
    ipcMain: { handle: register, on: register },
    powerMonitor: { on: vi.fn() },
  };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  mocks.updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  return { autoUpdater: mocks.updater };
});

const appFrame = { senderFrame: { url: `${APP_ORIGIN}/chat/1` } };
const foreignFrame = { senderFrame: { url: "https://example.test/" } };

async function loadUpdates() {
  vi.resetModules();
  mocks.ipcHandlers.clear();
  return import("./updates");
}

function stageUpdate(version: string) {
  mocks.updater.emit("update-downloaded", { version });
  mocks.nativeUpdater.emit("update-downloaded");
}

describe("background updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.app.isPackaged = true;
  });

  it("offers a restart only after Squirrel has staged the download", async () => {
    const { startAutoUpdates } = await loadUpdates();
    startAutoUpdates();
    const readyVersion = mocks.ipcHandlers.get("desktop-update:ready-version");
    const restart = mocks.ipcHandlers.get("desktop-update:restart");

    mocks.updater.emit("update-downloaded", { version: "0.2.1" });
    restart?.(appFrame);
    expect(readyVersion?.(appFrame)).toBeNull();
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();

    mocks.nativeUpdater.emit("update-downloaded");
    expect(mocks.send).toHaveBeenCalledWith("desktop-update:ready", "0.2.1");
    expect(readyVersion?.(appFrame)).toBe("0.2.1");

    restart?.(appFrame);
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("ignores update requests from other origins", async () => {
    const { startAutoUpdates } = await loadUpdates();
    startAutoUpdates();
    stageUpdate("0.2.1");

    expect(mocks.ipcHandlers.get("desktop-update:ready-version")?.(foreignFrame)).toBeNull();
    mocks.ipcHandlers.get("desktop-update:restart")?.(foreignFrame);
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("checks after launch and then hourly", async () => {
    mocks.updater.checkForUpdates.mockResolvedValue(null);
    const { startAutoUpdates } = await loadUpdates();
    startAutoUpdates();

    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("logs only the updater error code", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startAutoUpdates } = await loadUpdates();
    startAutoUpdates();

    mocks.updater.emit(
      "error",
      Object.assign(new Error("https://example.test/?token=secret"), {
        code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      }),
    );
    expect(warning).toHaveBeenCalledWith(
      "[opencompany-desktop] Update failed (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND)",
    );
    warning.mockRestore();
  });

  it("does not run the updater in development Electron", async () => {
    mocks.app.isPackaged = false;
    const { startAutoUpdates } = await loadUpdates();
    startAutoUpdates();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("manual update checks", () => {
  let menuItem: MenuItem;
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.app.isPackaged = true;
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    menuItem = { enabled: true, label: "Check for Updates…" } as MenuItem;
  });

  it("reports the installed version when no update is available", async () => {
    const { checkForUpdates } = await loadUpdates();
    mocks.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false });
    await checkForUpdates(menuItem);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "You're up to date",
        detail: expect.stringContaining("0.2.0"),
      }),
    );
    expect(menuItem.enabled).toBe(true);
  });

  it("explains that a found update downloads in the background", async () => {
    const { checkForUpdates } = await loadUpdates();
    mocks.updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "0.2.1" },
    });
    await checkForUpdates(menuItem);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Downloading opencompany 0.2.1" }),
    );
  });

  it("offers a restart instead of checking again when an update is staged", async () => {
    const { checkForUpdates, startAutoUpdates } = await loadUpdates();
    startAutoUpdates();
    stageUpdate("0.2.1");
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    await checkForUpdates(menuItem);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "opencompany 0.2.1 is ready" }),
    );
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("shows a safe error and lets the user retry", async () => {
    const { checkForUpdates } = await loadUpdates();
    mocks.updater.checkForUpdates.mockRejectedValue(
      new Error("https://example.test/?token=secret"),
    );
    await checkForUpdates(menuItem);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Couldn't check for updates" }),
    );
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toContain("secret");
    expect(menuItem).toMatchObject({ enabled: true, label: "Check for Updates…" });
  });

  it("prevents overlapping manual checks", async () => {
    const { checkForUpdates } = await loadUpdates();
    let finish!: (value: { isUpdateAvailable: boolean }) => void;
    mocks.updater.checkForUpdates.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = checkForUpdates(menuItem);
    expect(menuItem).toMatchObject({ enabled: false, label: "Checking for Updates…" });
    await checkForUpdates(menuItem);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
    finish({ isUpdateAvailable: false });
    await first;
    expect(menuItem.enabled).toBe(true);
  });

  it("does not claim development Electron is up to date", async () => {
    mocks.app.isPackaged = false;
    const { checkForUpdates } = await loadUpdates();
    await checkForUpdates(menuItem);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Updates are available in the installed app" }),
    );
  });
});
