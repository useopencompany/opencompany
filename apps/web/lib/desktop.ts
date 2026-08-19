import { headers } from "next/headers";

// The Electron shell appends " opencompanyDesktop/<version>" to the user-agent
// (see apps/desktop/src/main.ts). Detecting it server-side lets the sign-in page
// render the desktop-specific Google button without a hydration mismatch.
const DESKTOP_UA_MARKER = "opencompanyDesktop/";

export function isDesktopUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && userAgent.includes(DESKTOP_UA_MARKER);
}

export async function isDesktopRequest(): Promise<boolean> {
  const headerList = await headers();
  return isDesktopUserAgent(headerList.get("user-agent"));
}
