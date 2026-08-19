import todesktop from "@todesktop/runtime";

// Must run before anything else in the app lifecycle so the runtime can wire up
// auto-update and crash reporting.
todesktop.init();

import { app, type BrowserWindow, dialog, Menu } from "electron";
import { handleAuthDeepLink, registerDesktopAuth } from "./auth";
import { buildApplicationMenu } from "./menu";
import { APP_URL } from "./urls";
import { createMainWindow } from "./window";

// Local dev runs against a self-signed https://localhost cert. Never relax cert
// checks in a packaged build or against a non-localhost URL.
if (!app.isPackaged && new URL(APP_URL).hostname === "localhost") {
  app.commandLine.appendSwitch("ignore-certificate-errors");
}

let mainWindow: BrowserWindow | null = null;
// A deep link can arrive before the window exists (cold start). Hold it until
// the window is ready, then replay it.
let bufferedDeepLink: string | null = null;

const getWindow = () => mainWindow;

function dispatchDeepLink(url: string) {
  if (mainWindow) {
    handleAuthDeepLink(url, mainWindow);
  } else {
    bufferedDeepLink = url;
  }
}

// Register the protocol + open-url handler before `ready` so cold-start links
// are not dropped. On macOS the OS delivers opencompany:// links via open-url.
app.setAsDefaultProtocolClient("opencompany");
app.on("open-url", (event, url) => {
  event.preventDefault();
  dispatchDeepLink(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Marks the desktop session server-side and feeds preload's version arg.
    app.userAgentFallback = `${app.userAgentFallback} opencompanyDesktop/${app.getVersion()}`;

    Menu.setApplicationMenu(buildApplicationMenu(getWindow));
    registerDesktopAuth();

    mainWindow = createMainWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    if (bufferedDeepLink) {
      handleAuthDeepLink(bufferedDeepLink, mainWindow);
      bufferedDeepLink = null;
    }

    // autoUpdater is only populated by todesktop.init() in a packaged build.
    const autoUpdater = todesktop.autoUpdater;
    if (autoUpdater) {
      autoUpdater.on("update-downloaded", () => {
        void dialog
          .showMessageBox({
            type: "info",
            buttons: ["Restart", "Later"],
            defaultId: 0,
            cancelId: 1,
            title: "Update ready",
            message: "A new version of opencompany is ready.",
            detail: "Restart to install the latest version.",
          })
          .then(({ response }) => {
            if (response === 0) autoUpdater.restartAndInstall();
          });
      });
    }

    app.on("activate", () => {
      if (mainWindow) return;
      mainWindow = createMainWindow();
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
    });
  });

  // macOS convention: keep the app (and its menu bar) alive after the last
  // window closes; `activate` recreates a window.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
