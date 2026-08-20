import path from "node:path";
import { type BrowserWindow, ipcMain, shell } from "electron";
import { APP_ORIGIN, APP_URL } from "./urls";

// ERR_ABORTED — emitted for canceled/superseded loads (e.g. redirects). Not a
// real failure, so it must not trigger the offline page.
const ERR_ABORTED = -3;

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function isAppOrigin(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function preventExternalNavigation(event: { preventDefault(): void }, url: string) {
  if (isAppOrigin(url)) return;
  event.preventDefault();
  if (/^https?:$/.test(protocolOf(url))) void shell.openExternal(url);
}

export function registerDesktopNavigation(getWindow: () => BrowserWindow | null) {
  ipcMain.on("desktop-navigation:retry", (event) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents) return;
    void window.loadURL(APP_URL);
  });
}

// Confine the window to the app origin, route everything else to the system
// browser, and fall back to a bundled offline page when the app can't load.
export function applyNavigationPolicy(window: BrowserWindow) {
  const { webContents } = window;

  // OAuth and any external link must never load in-window: only the app origin
  // is allowed to navigate here.
  webContents.on("will-navigate", preventExternalNavigation);
  // `will-navigate` is not emitted for programmatic loadURL calls. Apply the
  // same policy to server redirects so a loadURL response cannot escape the
  // configured app origin inside the privileged desktop window.
  webContents.on("will-redirect", preventExternalNavigation);

  // window.open / target=_blank → open http(s) externally, deny everything else.
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(protocolOf(url))) void shell.openExternal(url);
    return { action: "deny" };
  });

  webContents.on("did-fail-load", (_event, errorCode, _desc, _url, isMainFrame) => {
    if (errorCode === ERR_ABORTED || !isMainFrame) return;
    void window.loadFile(path.join(__dirname, "../assets/offline.html"));
  });
}
