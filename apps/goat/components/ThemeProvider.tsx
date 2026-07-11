"use client";

import { useServerInsertedHTML } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemeMode) => void;
};

const THEME_COOKIE = "opencompany-goat-theme";
const THEME_STORAGE_KEY = "opencompany-goat-theme";
const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const THEME_VALUES = new Set<ThemeMode>(["system", "light", "dark"]);

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeListeners = new Set<() => void>();

const themeInitScript = `(()=>{try{var e="opencompany-goat-theme",t={system:1,light:1,dark:1},m=localStorage.getItem(e);if(!t[m]){var r=document.cookie.match(/(?:^|; )opencompany-goat-theme=([^;]*)/);m=r?decodeURIComponent(r[1]):"system"}if(!t[m])m="system";var o=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;document.documentElement.dataset.theme=m;document.documentElement.dataset.resolvedTheme=o}catch(e){}})();`;

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && THEME_VALUES.has(value as ThemeMode);
}

function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(): ThemeMode | null {
  if (typeof window === "undefined") return null;

  const localTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemeMode(localTheme)) return localTheme;

  const cookieTheme = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${THEME_COOKIE}=`))
    ?.split("=")
    .at(1);
  const decodedCookieTheme = cookieTheme ? decodeURIComponent(cookieTheme) : undefined;
  return isThemeMode(decodedCookieTheme) ? decodedCookieTheme : null;
}

function themeSnapshot() {
  return readStoredTheme() ?? "system";
}

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", listener);

  function handleStorage(event: StorageEvent) {
    if (event.key === THEME_STORAGE_KEY) listener();
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    themeListeners.delete(listener);
    mediaQuery.removeEventListener("change", listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function notifyThemeListeners() {
  for (const listener of themeListeners) listener();
}

function applyTheme(theme: ThemeMode, resolvedTheme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.resolvedTheme = resolvedTheme;
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: React.ReactNode;
  initialTheme: ThemeMode;
}) {
  useServerInsertedHTML(() => (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted inline anti-flash script
    <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
  ));

  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, () => initialTheme);
  const resolvedTheme = useSyncExternalStore(
    subscribeTheme,
    () => resolveTheme(themeSnapshot()),
    () => resolveTheme(initialTheme),
  );

  useEffect(() => {
    const storedTheme = readStoredTheme();
    if (storedTheme && storedTheme !== theme) {
      notifyThemeListeners();
      return;
    }

    applyTheme(theme, resolvedTheme);
  }, [resolvedTheme, theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (nextTheme) => {
        if (!isThemeMode(nextTheme)) return;
        applyTheme(nextTheme, resolveTheme(nextTheme));
        notifyThemeListeners();
      },
    }),
    [resolvedTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider.");
  return value;
}
