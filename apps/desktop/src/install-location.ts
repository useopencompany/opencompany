import { app, dialog } from "electron";

// Squirrel.Mac cannot replace an app that runs from the mounted DMG or from a
// translocated Downloads copy, so updates would silently never apply there.
// Offer the move on every launch until the app lives in /Applications.
// Resolves true when this process is quitting to relaunch from /Applications.
export async function offerMoveToApplications(): Promise<boolean> {
  if (!app.isPackaged || app.isInApplicationsFolder()) return false;

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move opencompany to your Applications folder?",
    detail: "opencompany can only keep itself up to date from the Applications folder.",
  });
  if (response !== 0) return false;

  try {
    // Quits and relaunches from /Applications on success. If a copy there is
    // already running, Electron focuses it and quits this one.
    return app.moveToApplicationsFolder();
  } catch {
    console.warn("[opencompany-desktop] Move to Applications failed");
    await dialog.showMessageBox({
      type: "warning",
      message: "Couldn't move opencompany",
      detail: "Drag opencompany into your Applications folder, then open it from there.",
    });
    return false;
  }
}
