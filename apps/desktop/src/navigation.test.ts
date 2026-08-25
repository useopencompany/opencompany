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

import { applyNavigationPolicy, registerDesktopNavigation } from "./navigation";
import { APP_URL } from "./urls";

type NavigationHandler = (event: { preventDefault(): void }, url: string) => void;
type FailedLoadHandler = (
  event: unknown,
  errorCode: number,
  description: string,
  url: string,
  isMainFrame: boolean,
) => void;

function fakeWindow() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const webContents = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    setWindowOpenHandler: vi.fn(),
  };
  return {
    handlers,
    webContents,
    window: {
      webContents,
      loadFile: vi.fn(async () => undefined),
      loadURL: vi.fn(async () => undefined),
    },
  };
}

describe("desktop navigation policy", () => {
  beforeEach(() => {
    mocks.ipcHandlers.clear();
    mocks.openExternal.mockReset();
  });

  it.each(["will-navigate", "will-redirect"])(
    "keeps %s navigation inside the configured app origin",
    (eventName) => {
      const fake = fakeWindow();
      applyNavigationPolicy(fake.window as never);
      const navigate = fake.handlers.get(eventName) as NavigationHandler;
      const sameOriginEvent = { preventDefault: vi.fn() };
      navigate(sameOriginEvent, `${APP_URL}/chat`);
      expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();

      const externalEvent = { preventDefault: vi.fn() };
      navigate(externalEvent, "https://accounts.example.test/oauth");
      expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
      expect(mocks.openExternal).toHaveBeenCalledWith("https://accounts.example.test/oauth");
    },
  );

  it("loads the fixed offline page without carrying a query-controlled retry URL", () => {
    const fake = fakeWindow();
    applyNavigationPolicy(fake.window as never);
    const failedLoad = fake.handlers.get("did-fail-load") as FailedLoadHandler;

    failedLoad(undefined, -105, "network unavailable", APP_URL, true);

    expect(fake.window.loadFile).toHaveBeenCalledOnce();
    expect(fake.window.loadFile.mock.calls[0]).toHaveLength(1);
  });

  it("retries only for the current desktop window", () => {
    const fake = fakeWindow();
    registerDesktopNavigation(() => fake.window as never);
    const retry = mocks.ipcHandlers.get("desktop-navigation:retry");
    expect(retry).toBeDefined();

    retry?.({ sender: {} });
    expect(fake.window.loadURL).not.toHaveBeenCalled();

    retry?.({ sender: fake.webContents });
    expect(fake.window.loadURL).toHaveBeenCalledWith(APP_URL);
  });
});
