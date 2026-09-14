import todesktop from "@todesktop/runtime";
import { app, dialog, type MenuItem } from "electron";

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

  menuItem.enabled = false;
  menuItem.label = "Checking for Updates…";
  try {
    const updater = todesktop.autoUpdater;
    if (!updater) throw new Error("Updater unavailable");
    // ToDesktop handles the download and restart prompt when an update exists.
    const result = await updater.checkForUpdates({ source: "menu" });
    if (!result.updateInfo) {
      await dialog.showMessageBox({
        type: "info",
        message: "You're up to date",
        detail: `opencompany ${app.getVersion()} is the latest released version.`,
      });
    }
  } catch {
    console.warn("[opencompany-desktop] Update check failed");
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
