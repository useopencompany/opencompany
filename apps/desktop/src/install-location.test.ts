import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    isInApplicationsFolder: vi.fn(),
    moveToApplicationsFolder: vi.fn(),
  },
  showMessageBox: vi.fn(),
}));
vi.mock("electron", () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox } }));

import { offerMoveToApplications } from "./install-location";

describe("move to Applications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.app.isPackaged = true;
    mocks.app.isInApplicationsFolder.mockReturnValue(false);
  });

  it("stays quiet when the app already runs from Applications", async () => {
    mocks.app.isInApplicationsFolder.mockReturnValue(true);
    expect(await offerMoveToApplications()).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("moves and relaunches when the user accepts", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    mocks.app.moveToApplicationsFolder.mockReturnValue(true);
    expect(await offerMoveToApplications()).toBe(true);
  });

  it("keeps running in place when the user declines", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await offerMoveToApplications()).toBe(false);
    expect(mocks.app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it("explains the manual fallback when the move fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    mocks.app.moveToApplicationsFolder.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(await offerMoveToApplications()).toBe(false);
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "Couldn't move opencompany" }),
    );
    warning.mockRestore();
  });

  it("never prompts in development Electron", async () => {
    mocks.app.isPackaged = false;
    expect(await offerMoveToApplications()).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});
