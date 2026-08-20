import { contextBridge, ipcRenderer } from "electron";

// The app version is injected via webPreferences.additionalArguments (see
// window.ts) because app.getVersion() is main-process only, and a sandboxed
// preload still receives those on process.argv.
const versionArg = process.argv.find((arg) => arg.startsWith("--opencompany-desktop-version="));
const version = versionArg?.split("=")[1] ?? "0.0.0";

// Contract consumed by the web app (apps/web): its presence marks a desktop
// session and its signInWithGoogle() drives the system-browser OAuth handoff.
contextBridge.exposeInMainWorld("opencompanyDesktop", {
  version,
  platform: "darwin",
  signInWithGoogle: () => ipcRenderer.send("desktop-auth:start-google"),
  retryConnection: () => ipcRenderer.send("desktop-navigation:retry"),
});
