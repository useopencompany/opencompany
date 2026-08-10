# Goat Quick for macOS

Goat Quick is a native macOS 14+ menu-bar utility. Press `Option-Command-Space` from any app to open a compact Goat composer. Submitting creates a normal Goat chat session, hides the panel immediately, and drains the response stream in the background.

The app is written in SwiftUI and AppKit, has no third-party dependencies, and does not require Accessibility permission. It authenticates in the system browser through a public WorkOS OAuth application using Authorization Code + PKCE and a loopback callback.

## WorkOS setup

Create one first-party public OAuth application in each WorkOS environment. Configure it as a native/public client with:

- Authorization Code with PKCE; do not create or embed a client secret.
- Scopes `openid profile email offline_access`.
- Redirect URI `http://127.0.0.1:*/oauth/callback`.

WorkOS documents the native loopback flow in [Connect with OAuth](https://workos.com/docs/authkit/connect/oauth). The wildcard port is intentional: Goat Quick binds only to `127.0.0.1` on a new ephemeral port for each sign-in.

Configure the Goat server with the same environment and application:

```dotenv
GOAT_AUTHKIT_DOMAIN="https://your-environment.authkit.app"
GOAT_MACOS_OAUTH_AUDIENCE="client_..."
GOAT_MACOS_OAUTH_CLIENT_ID="client_..."
```

`GOAT_MACOS_OAUTH_CLIENT_ID` is a public identifier used by the native PKCE flow. WorkOS access
tokens use a separate resource identifier for `aud`, so the server verifies that value through
`GOAT_MACOS_OAUTH_AUDIENCE` together with the JWT issuer, signature, and expiry. It then resolves
`sub` and `org_id` to an onboarded Goat user and workspace membership.

## Local configuration

Copy the example build settings, then fill in the AuthKit issuer and public client ID:

```sh
cp apps/goat-macos/Config/Local.xcconfig.example apps/goat-macos/Config/Local.xcconfig
```

`Local.xcconfig` is gitignored. Debug builds use `http://127.0.0.1:3002` for Goat by default. Override `GOAT_API_BASE_URL` for another deployment. Release values should be passed by CI or a local uncommitted xcconfig; no credentials belong in the project.

Start the OpenCompany web development stack with `bun run dev:web`, open `apps/goat-macos/GoatQuick.xcodeproj`, select the `GoatQuick` scheme, and run it. It appears only in the menu bar.

Command-line verification:

```sh
xcodebuild \
  -project apps/goat-macos/GoatQuick.xcodeproj \
  -scheme GoatQuick \
  -configuration Debug \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  build

xcodebuild \
  -project apps/goat-macos/GoatQuick.xcodeproj \
  -scheme GoatQuick \
  -configuration Debug \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  test
```

For a normal local run with Keychain access and the app sandbox, select a development team in Xcode and use regular code signing.

## Behavior and recovery

- `Enter` submits, `Shift-Enter` inserts a newline, and `Escape` dismisses the panel.
- Drafts survive dismissal. Prompts are limited to 10,000 characters.
- Every submission gets new `goat_chat_<uuid>` and `goat_chat_msg_<uuid>` identifiers.
- A 401 refreshes the access token and retries once with the same identifiers.
- Transport errors are never automatically retried. The original prompt is restored.
- If a stream disconnects after a successful HTTP response, Goat Quick preserves the session ID and offers a manual **Open in Goat** link.
- Successful submissions are silent and never open a browser.

V1 is intentionally text-only. It does not include attachments, a model picker, mentions, Codex controls, launch at login, notifications, notarization, packaging, or an updater.
