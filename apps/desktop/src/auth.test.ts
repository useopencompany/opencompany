import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => void>(),
  openExternal: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      mocks.ipcHandlers.set(channel, handler);
    }),
  },
  shell: { openExternal: mocks.openExternal },
}));

import { registerDesktopAuth } from "./auth";
import { APP_ORIGIN } from "./urls";

describe("desktop Google auth", () => {
  beforeEach(() => {
    mocks.ipcHandlers.clear();
    mocks.openExternal.mockReset();
    registerDesktopAuth();
  });

  it("opens the system browser with a PKCE challenge and invitation token", () => {
    const startGoogle = mocks.ipcHandlers.get("desktop-auth:start-google");

    startGoogle?.({ senderFrame: { url: `${APP_ORIGIN}/signup` } }, " invite-token-123 ");

    expect(mocks.openExternal).toHaveBeenCalledOnce();
    const url = new URL(mocks.openExternal.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/auth/desktop/start");
    expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("invitation_token")).toBe("invite-token-123");
  });

  it("omits invalid invitation-token input", () => {
    const startGoogle = mocks.ipcHandlers.get("desktop-auth:start-google");

    startGoogle?.({ senderFrame: { url: `${APP_ORIGIN}/signin` } }, { token: "not-a-string" });

    const url = new URL(mocks.openExternal.mock.calls[0]?.[0] as string);
    expect(url.searchParams.has("invitation_token")).toBe(false);
  });

  it("ignores requests from outside the configured app origin", () => {
    const startGoogle = mocks.ipcHandlers.get("desktop-auth:start-google");

    startGoogle?.({ senderFrame: { url: "https://attacker.example/signin" } }, "invite-token-123");

    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
