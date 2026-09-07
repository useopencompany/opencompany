import todesktop from "@todesktop/runtime";
import {
  app,
  type BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { handleAuthDeepLink } from "./auth";
import { APP_URL } from "./urls";

// Cmd+R: reload the app. If we're sitting on the bundled offline page
// (a file:// URL), a plain reload would just re-show it, so navigate back to
// the app URL instead.
function reloadApp(window: BrowserWindow | null) {
  if (!window) return;
  const current = window.webContents.getURL();
  if (current.startsWith("file:")) {
    void window.loadURL(APP_URL);
  } else {
    window.webContents.reload();
  }
}

export function buildApplicationMenu(getWindow: () => BrowserWindow | null): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => {
            // autoUpdater is only wired up by todesktop.init() in a packaged
            // build; it's absent in local dev.
            void todesktop.autoUpdater?.checkForUpdates();
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    // Required for Cmd+C / Cmd+V / Cmd+X to work on macOS.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => reloadApp(getWindow()),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // Unpackaged protocol registration is unreliable, so in dev we feed a
        // pasted opencompany:// callback URL straight into the deep-link handler.
        ...(app.isPackaged
          ? []
          : ([
              { type: "separator" },
              {
                label: "Paste callback URL…",
                click: async () =>
                  handleAuthDeepLink((await clipboard.readText()).trim(), getWindow()),
              },
              { role: "toggleDevTools" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    { role: "windowMenu" },
  ];

  return Menu.buildFromTemplate(template);
}
