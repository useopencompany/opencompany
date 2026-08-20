import { createHash } from "node:crypto";
import {
  buildAad,
  decryptJson,
  type EncryptedPayload,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";

// Sealed handoff token for the desktop Google sign-in flow. The desktop shell
// opens sign-in in the system browser; the web callback seals only the WorkOS
// refreshToken into a short-lived token and returns it to the app over an
// `opencompany://` deep link. The app redeems it in its own window, where the
// refresh token is exchanged for a real session.
//
// Single-use is not enforced here: it falls out of WorkOS refresh-token
// rotation. Redemption calls authenticateWithRefreshToken, which rotates the
// token, so replaying the same handoff token fails at WorkOS.
//
// A PKCE-style binding closes the deep-link-hijack hole: the main process holds
// a random `verifier`, only its `challenge = base64url(sha256(verifier))`
// travels through the browser leg, and the caller must present `verifier` at
// redemption. An app that squats the URL scheme and intercepts the deep link
// holds a token it cannot redeem.

const DESKTOP_AUTH_KEY_ENV = "OPENCOMPANY_DESKTOP_AUTH_SECRET";
// Reuse the shared credential key-version seam, but bind version 1 to the
// desktop-specific env rather than the integration-credential key.
const DESKTOP_AUTH_KEY_ENV_BY_VERSION: Record<number, string> = {
  1: DESKTOP_AUTH_KEY_ENV,
};
const DESKTOP_AUTH_TTL_MS = 60_000;
// 32 random bytes → 43-char unpadded base64url. Both the verifier and the
// derived challenge share this shape.
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

const AUTH_METHOD = "GoogleOAuth" as const;

type DesktopHandoffPayload = {
  refreshToken: string;
  challenge: string;
  authMethod: typeof AUTH_METHOD;
  exp: number;
};

export type RedeemedDesktopHandoff = {
  refreshToken: string;
  authMethod: typeof AUTH_METHOD;
};

// Field order is significant: buildAad serializes in insertion order and the
// AAD must be byte-identical at seal and unseal time.
function desktopHandoffAad() {
  return buildAad({ purpose: "desktop-auth-handoff", v: 1 });
}

// base64url(sha256(verifier)) — the value that travels through the browser leg.
export function deriveDesktopChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function isValidDesktopChallenge(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_32_BYTES.test(value);
}

export function mintDesktopHandoffToken(input: {
  refreshToken: string;
  challenge: string;
  now?: number;
}): string {
  const payload: DesktopHandoffPayload = {
    refreshToken: input.refreshToken,
    challenge: input.challenge,
    authMethod: AUTH_METHOD,
    exp: (input.now ?? Date.now()) + DESKTOP_AUTH_TTL_MS,
  };
  const encrypted = encryptJson(payload, {
    key: loadEncryptionKey(1, DESKTOP_AUTH_KEY_ENV_BY_VERSION),
    aad: desktopHandoffAad(),
  });
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

export class DesktopHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopHandoffError";
  }
}

// Unseal and validate the handoff token: TTL first, then the PKCE binding.
// Returns the refresh token for the caller to exchange at WorkOS. Throws
// DesktopHandoffError on any tamper, expiry, or verifier mismatch — callers
// map that to a generic `desktop_handoff` sign-in error.
export function redeemDesktopHandoffToken(
  token: string,
  verifier: string,
  options: { now?: number } = {},
): RedeemedDesktopHandoff {
  let encrypted: EncryptedPayload;
  try {
    encrypted = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as EncryptedPayload;
  } catch {
    throw new DesktopHandoffError("Malformed desktop handoff token.");
  }

  let payload: DesktopHandoffPayload;
  try {
    payload = decryptJson(encrypted, {
      key: loadEncryptionKey(1, DESKTOP_AUTH_KEY_ENV_BY_VERSION),
      aad: desktopHandoffAad(),
    }) as DesktopHandoffPayload;
  } catch {
    // Wrong key, tampered ciphertext/AAD, or corrupt data.
    throw new DesktopHandoffError("Desktop handoff token could not be verified.");
  }

  if (
    typeof payload.refreshToken !== "string" ||
    typeof payload.challenge !== "string" ||
    typeof payload.exp !== "number" ||
    payload.authMethod !== AUTH_METHOD
  ) {
    throw new DesktopHandoffError("Desktop handoff token payload is invalid.");
  }

  const now = options.now ?? Date.now();
  if (now > payload.exp) {
    throw new DesktopHandoffError("Desktop handoff token expired.");
  }

  if (!isValidDesktopChallenge(verifier)) {
    throw new DesktopHandoffError("Desktop handoff verifier is malformed.");
  }
  if (deriveDesktopChallenge(verifier) !== payload.challenge) {
    throw new DesktopHandoffError("Desktop handoff verifier does not match challenge.");
  }

  return { refreshToken: payload.refreshToken, authMethod: payload.authMethod };
}
