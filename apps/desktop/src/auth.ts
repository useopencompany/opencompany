import { createHash, randomBytes } from "node:crypto";
import { type BrowserWindow, ipcMain, shell } from "electron";
import { APP_ORIGIN, APP_URL } from "./urls";

// PKCE verifier for the in-flight desktop sign-in. Held only in main-process
// memory: it never travels through the browser leg, so an app that squats the
// opencompany:// scheme and intercepts the handoff deep link cannot redeem the
// token. Lost on process exit — a cold-start deep link therefore fails safe to
// /signin (see handleAuthDeepLink).
let pendingVerifier: string | null = null;
const MAX_INVITATION_TOKEN_LENGTH = 2_048;

function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function deriveChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function normalizeInvitationToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token && token.length <= MAX_INVITATION_TOKEN_LENGTH ? token : null;
}

// Wire up the renderer → main IPC that opens Google sign-in in the system
// browser. Google blocks OAuth inside embedded webviews, so this must leave the
// app. Only requests originating from our own app origin are honored.
export function registerDesktopAuth() {
  ipcMain.on("desktop-auth:start-google", (event, invitationToken: unknown) => {
    const frameUrl = event.senderFrame?.url;
    if (!frameUrl) return;
    try {
      if (new URL(frameUrl).origin !== APP_ORIGIN) return;
    } catch {
      return;
    }

    pendingVerifier = newVerifier();
    const url = new URL("/auth/desktop/start", APP_URL);
    url.searchParams.set("challenge", deriveChallenge(pendingVerifier));
    const normalizedInvitationToken = normalizeInvitationToken(invitationToken);
    if (normalizedInvitationToken) {
      url.searchParams.set("invitation_token", normalizedInvitationToken);
    }
    void shell.openExternal(url.toString());
  });
}

// Handle an opencompany:// deep link. Returns true if it was an auth callback we
// consumed. Redemption presents the stored verifier to the web app, which
// exchanges the sealed refresh token for a real session in this window.
export function handleAuthDeepLink(rawUrl: string, window: BrowserWindow | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "opencompany:" || parsed.host !== "auth") return false;

  if (!window) return true;

  const token = parsed.searchParams.get("token");
  if (!token || !pendingVerifier) {
    // No token, or verifier lost with the process (app relaunched mid-flow).
    // Fail safe: sign-in is always initiated from a running app, so this is a
    // recoverable state, not an error.
    console.warn("[opencompany-desktop] Auth deep link without a usable verifier; loading /signin");
    void window.loadURL(new URL("/signin", APP_URL).toString());
    return true;
  }

  const url = new URL("/auth/desktop/complete", APP_URL);
  url.searchParams.set("token", token);
  url.searchParams.set("verifier", pendingVerifier);
  pendingVerifier = null;
  void window.loadURL(url.toString());
  return true;
}
