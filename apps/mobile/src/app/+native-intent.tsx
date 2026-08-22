export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const url = new URL(path);
    if (url.hostname === "signout-callback" || url.pathname === "/signout-callback") {
      return null;
    }
  } catch {
    return path;
  }

  return path;
}
