# Goat Mobile

Minimal Expo (iOS-first) client for the Goat chat. It talks HTTP to the Goat
Next.js app (`apps/goat`) — the same `/api/chat` streaming endpoint the web
client uses — plus two mobile-only REST endpoints for session history
(`/api/mobile/sessions`, `/api/mobile/sessions/{id}`).

## Stack

- Expo SDK 57 / expo-router, React Native 0.86
- AI SDK v6 `useChat` + `DefaultChatTransport` over `expo/fetch` (streaming),
  pinned to the same `ai` / `@ai-sdk/react` versions as `apps/goat`
- `@legendapp/list` for the message list (`alignItemsAtEnd` +
  `maintainScrollAtEnd` for streaming auto-follow)
- `react-native-keyboard-controller` for keyboard handling (requires a dev
  build — this app does not run in Expo Go)

## Run it

1. `cp .env.example .env` and fill it in (see below).
2. Make sure the Goat dev server is running (`bun run dev:goat` at the repo
   root → http://localhost:3002).
3. From `apps/mobile`: `bun run ios` (builds the dev client and opens the
   simulator). Subsequent JS-only changes just need `bun run start`.

## Auth

Two modes, chosen by env:

- **Dev token (fastest)**: set `GOAT_MOBILE_DEV_TOKEN` (any random string) and
  `GOAT_MOBILE_DEV_USER_EMAIL` (your goat user email) in the repo-root `.env`,
  and the same token as `EXPO_PUBLIC_GOAT_DEV_TOKEN` here. Sign-in is skipped.
  The server ignores the dev token in production builds.
- **WorkOS AuthKit (real)**: set `EXPO_PUBLIC_WORKOS_CLIENT_ID` +
  `EXPO_PUBLIC_AUTHKIT_DOMAIN`, and add `goat://auth/callback` to the WorkOS
  app's redirect URIs. The app then runs OAuth + PKCE against the hosted
  AuthKit page and stores tokens in the keychain. The server verifies the
  access token against the AuthKit JWKS (`GOAT_AUTHKIT_DOMAIN`).
