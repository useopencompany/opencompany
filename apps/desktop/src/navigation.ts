import path from "node:path";
import { type BrowserWindow, shell } from "electron";
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

// Confine the window to the app origin, route everything else to the system
// browser, and fall back to a bundled offline page when the app can't load.
export function applyNavigationPolicy(window: BrowserWindow) {
  const { webContents } = window;

  // OAuth and any external link must never load in-window: only the app origin
  // is allowed to navigate here.
  webContents.on("will-navigate", (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === APP_ORIGIN;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      event.preventDefault();
      if (/^https?:$/.test(protocolOf(url))) void shell.openExternal(url);
    }
  });

  // window.open / target=_blank → open http(s) externally, deny everything else.
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(protocolOf(url))) void shell.openExternal(url);
    return { action: "deny" };
  });

  webContents.on("did-fail-load", (_event, errorCode, _desc, _url, isMainFrame) => {
    if (errorCode === ERR_ABORTED || !isMainFrame) return;
    void window.loadFile(path.join(__dirname, "../assets/offline.html"), {
      query: { appUrl: APP_URL },
    });
  });
}
