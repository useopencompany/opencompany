import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type MenuItem,
  autoUpdater as nativeUpdater,
  powerMonitor,
} from "electron";
import { autoUpdater } from "electron-updater";
import { isAppOrigin } from "./urls";

const LAUNCH_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Version electron-updater has downloaded and handed to Squirrel.Mac.
let downloadedVersion: string | null = null;
// Version Squirrel.Mac has staged. Only now does a restart install immediately:
// electron-updater reports its download before Squirrel has fetched the bundle
// from the local proxy, and restarting in that gap is what leaves updaters
// quitting without relaunching.
let readyVersion: string | null = null;

function logUpdateError(error: unknown) {
  // Updater errors can embed feed URLs and local paths; keep only the code.
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(
    `[opencompany-desktop] Update failed${typeof code === "string" ? ` (${code})` : ""}`,
  );
}

function isAppFrame(event: IpcMainEvent | IpcMainInvokeEvent) {
  return isAppOrigin(event.senderFrame?.url);
}

function checkInBackground() {
  // Once staged, the pending update installs on quit. Re-checking would make
  // electron-updater hand the cached zip to Squirrel again and re-stage it,
  // racing a restart. Newer releases are picked up after the next launch.
  if (readyVersion) return;
  // Failures are reported through the updater's `error` event.
  autoUpdater.checkForUpdates().catch(() => {});
}

export function restartToUpdate() {
  if (!readyVersion) return;
  autoUpdater.quitAndInstall();
}

// Background updates: check shortly after launch, hourly, and on wake;
// download silently; install on the next quit or when the user clicks Update.
export function startAutoUpdates() {
  ipcMain.handle("desktop-update:ready-version", (event) =>
    isAppFrame(event) ? readyVersion : null,
  );
  ipcMain.on("desktop-update:restart", (event) => {
    if (isAppFrame(event)) restartToUpdate();
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", logUpdateError);
  autoUpdater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
  });
  nativeUpdater.on("update-downloaded", () => {
    readyVersion = downloadedVersion ?? readyVersion;
    if (!readyVersion) return;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("desktop-update:ready", readyVersion);
    }
  });

  setTimeout(checkInBackground, LAUNCH_CHECK_DELAY_MS);
  setInterval(checkInBackground, CHECK_INTERVAL_MS);
  powerMonitor.on("resume", checkInBackground);
}

async function promptRestart(version: string) {
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `opencompany ${version} is ready`,
    detail: "Restart to finish updating. If you choose Later, it installs the next time you quit.",
  });
  if (response === 0) restartToUpdate();
}

export async function checkForUpdates(menuItem: MenuItem) {
  if (!menuItem.enabled) return;
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: "info",
      message: "Updates are available in the installed app",
      detail: "Development Electron runs directly from source and does not receive updates.",
    });
    return;
  }
  if (readyVersion) {
    await promptRestart(readyVersion);
    return;
  }

  menuItem.enabled = false;
  menuItem.label = "Checking for Updates…";
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      await dialog.showMessageBox({
        type: "info",
        message: `Downloading opencompany ${result.updateInfo.version}`,
        detail: "You can keep working. When it's ready, an Update button appears in the title bar.",
      });
    } else {
      await dialog.showMessageBox({
        type: "info",
        message: "You're up to date",
        detail: `opencompany ${app.getVersion()} is the latest released version.`,
      });
    }
  } catch {
    // Details were logged by the updater's `error` listener.
    await dialog.showMessageBox({
      type: "warning",
      message: "Couldn't check for updates",
      detail: "Check your internet connection and try again. Your current app is unchanged.",
    });
  } finally {
    menuItem.enabled = true;
    menuItem.label = "Check for Updates…";
  }
}
