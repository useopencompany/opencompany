import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { applyNavigationPolicy } from "./navigation";
import { APP_URL } from "./urls";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 832;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const PERSIST_DEBOUNCE_MS = 500;

type PersistedBounds = { x?: number; y?: number; width: number; height: number };

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readPersistedBounds(): PersistedBounds {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFilePath(), "utf8"));
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as PersistedBounds).width === "number" &&
      typeof (raw as PersistedBounds).height === "number"
    ) {
      const bounds = raw as PersistedBounds;
      return {
        ...(typeof bounds.x === "number" ? { x: bounds.x } : {}),
        ...(typeof bounds.y === "number" ? { y: bounds.y } : {}),
        width: Math.max(MIN_WIDTH, bounds.width),
        height: Math.max(MIN_HEIGHT, bounds.height),
      };
    }
  } catch {
    // No saved state yet, or it was corrupt — fall through to defaults.
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(window: BrowserWindow) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (window.isDestroyed()) return;
    try {
      writeFileSync(stateFilePath(), JSON.stringify(window.getBounds()));
    } catch {
      // Best-effort; window bounds are not worth surfacing an error for.
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...readPersistedBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: "#0b0b0c",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--opencompany-desktop-version=${app.getVersion()}`],
    },
  });

  applyNavigationPolicy(window);
  window.on("resize", () => schedulePersist(window));
  window.on("move", () => schedulePersist(window));

  void window.loadURL(APP_URL);
  return window;
}
