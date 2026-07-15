// Environment-driven configuration. All values come from EXPO_PUBLIC_* vars in
// apps/mobile/.env (see .env.example). The API base defaults to the local Goat
// dev server, which always runs on port 3002.
const rawApiUrl = process.env.EXPO_PUBLIC_GOAT_API_URL?.trim() || "http://localhost:3002";

export const GOAT_API_URL = rawApiUrl.replace(/\/+$/, "");

// Local-dev shortcut: pairs with GOAT_MOBILE_DEV_TOKEN on the server so the
// app can authenticate before the WorkOS native OAuth client is set up.
export const GOAT_DEV_TOKEN = process.env.EXPO_PUBLIC_GOAT_DEV_TOKEN?.trim() || null;

export const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID?.trim() || null;

const rawAuthKitDomain = process.env.EXPO_PUBLIC_AUTHKIT_DOMAIN?.trim() || null;
export const AUTHKIT_DOMAIN = rawAuthKitDomain ? rawAuthKitDomain.replace(/\/+$/, "") : null;

export const AUTH_DISCOVERY = AUTHKIT_DOMAIN
  ? {
      authorizationEndpoint: `${AUTHKIT_DOMAIN}/oauth2/authorize`,
      tokenEndpoint: `${AUTHKIT_DOMAIN}/oauth2/token`,
    }
  : null;

export const OAUTH_CONFIGURED = Boolean(WORKOS_CLIENT_ID && AUTH_DISCOVERY);
