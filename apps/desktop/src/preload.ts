import { contextBridge, ipcRenderer } from "electron";

// The app version is injected via webPreferences.additionalArguments (see
// window.ts) because app.getVersion() is main-process only, and a sandboxed
// preload still receives those on process.argv.
const versionArg = process.argv.find((arg) => arg.startsWith("--opencompany-desktop-version="));
const version = versionArg?.split("=")[1] ?? "0.0.0";

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.opencompanyDesktop = "true";
});

// Contract consumed by the web app (apps/web): its presence marks a desktop
// session and its signInWithGoogle() drives the system-browser OAuth handoff.
contextBridge.exposeInMainWorld("opencompanyDesktop", {
  version,
  platform: "darwin",
  signInWithGoogle: (invitationToken?: string) =>
    ipcRenderer.send("desktop-auth:start-google", invitationToken),
  retryConnection: () => ipcRenderer.send("desktop-navigation:retry"),
  // Calls the listener once an update is staged, including one staged before
  // the page (re)loaded. Returns an unsubscribe function.
  onUpdateReady: (listener: (version: string) => void) => {
    const handleReady = (_event: unknown, version: string) => listener(version);
    ipcRenderer.on("desktop-update:ready", handleReady);
    void ipcRenderer.invoke("desktop-update:ready-version").then((version: string | null) => {
      if (version) listener(version);
    });
    return () => {
      ipcRenderer.removeListener("desktop-update:ready", handleReady);
    };
  },
  restartToUpdate: () => ipcRenderer.send("desktop-update:restart"),
});
