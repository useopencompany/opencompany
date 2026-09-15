# @opencompany/desktop

Thin Electron shell that wraps the production opencompany web app
(`https://my.opencompany.chat`) as a downloadable macOS app. Product code keeps
deploying via Vercel — the desktop app picks it up instantly. The shell itself
updates rarely, via ToDesktop auto-update. Initial testing targets macOS arm64;
enabled platform and architecture artifacts are controlled in ToDesktop.

The shell bundles no Next.js and has **no `@opencompany/*` workspace deps** on
purpose: ToDesktop builds it remotely from an uploaded, dependency-minimal
package.

## Layout

- `src/main.ts` — app lifecycle, protocol registration, deep-link + update wiring.
- `src/window.ts` — the inset-title-bar `BrowserWindow` (sandboxed, context-isolated) + persisted bounds.
- `src/navigation.ts` — origin allowlist, external-link routing, offline fallback.
- `src/auth.ts` — PKCE verifier + the Google system-browser sign-in handoff.
- `src/menu.ts` — application menu (incl. Check for Updates and a dev-only paste-callback item).
- `src/preload.ts` — the `window.opencompanyDesktop` contextBridge global + desktop document marker.
- `src/urls.ts` — the wrapped app URL (`OPENCOMPANY_DESKTOP_APP_URL` override).
- `assets/offline.html` — shown when the app URL can't load.
- `assets/icon.png` — 1024×1024 macOS app icon, generated from `icon-source.svg`.

## Scripts

- `bun run dev` — build and run against production.
- `bun run dev:local` — build and run against `https://localhost:3443` (self-signed cert allowed).
- `bun run build:src` — esbuild the main + preload bundles into `dist/`.
- `bun run typecheck` / `bun run lint`.
- `bun run build:desktop` — build the source, then create a signed ToDesktop build. This does not publish an update.
- `bun run release` — compatibility alias for `build:desktop`; publishing remains a separate dashboard action.

## Auth handoff

Google OAuth cannot run in an embedded webview, so the sign-in button opens the
system browser. The web app (`apps/web`) seals the WorkOS refresh token into a
short-lived, PKCE-bound token and returns it over an `opencompany://auth/callback`
deep link; the shell redeems it in-window at `/auth/desktop/complete`. Magic-code
sign-in works in-window unchanged. See the `/auth/desktop/*` routes in `apps/web`.

## Deep links in development

Protocol registration is unreliable for an unpackaged Electron app. In dev, use
**View → Paste callback URL…** (paste an `opencompany://auth/callback?token=…`
link from the clipboard) or `open "opencompany://auth/callback?token=…"` once the
app is packaged.

## Icon

`assets/icon.png` is generated from `icon-source.svg`. The visible artwork uses
the standard macOS 824×824 rounded-square footprint on a transparent 1024×1024
canvas, so it matches the optical size of other icons in the Dock.

## Signed internal releases

Use the existing ToDesktop app (`260820qy6fin4`) and bundle ID
(`chat.opencompany.desktop`). Internal testers share the same update stream;
publishing a release makes it available to every installed copy of this app.
The shell loads production web content, not localhost. Web changes must deploy
separately; rebuilding Electron does not deploy `apps/web`.

1. Configure the team's Developer ID Application certificate and notarization
   credentials in ToDesktop. Never put the certificate or passwords in this repo.
2. Use the repository's pinned Bun version and run `bun install --frozen-lockfile`.
   Run desktop tests, typecheck, lint, and `build:src` before uploading.
3. From `apps/desktop`, inspect `todesktop build --dry-run --files`. The upload
   allowlist includes only package/config, built bundles, and assets, not env files.
4. Run `bun run build:desktop`. Require successful signing and notarization,
   then download the Mac artifact and install it in Applications. Do not remove
   quarantine attributes to make an internal build pass.
5. Verify Google handoff, quit/relaunch session persistence, chat/tasks, uploads,
   external links, offline recovery, and normal launch on another Mac.
6. Release the verified build from the ToDesktop dashboard. Keep release-token
   approval enabled; building and releasing are intentionally separate actions.
7. For the first release, build a second, higher package version with the same
   identifiers and signing team. Release it, then update the installed first
   version through **Check for Updates…**. Verify the version changes and the
   user's session survives. Also cover deferring the restart until the next launch.
   `todesktop smoke-test <build-id>` is an additional automated check, not a
   replacement for this real two-version update test.

ToDesktop checks on launch and every ten minutes. Its built-in restart prompt is
used in the foreground and its notification in the background. Manual checks
disable the menu item while running and report up-to-date and failure states.

References: [signing](https://www.todesktop.com/electron/docs/introduction/signing-application),
[build/release CLI](https://www.todesktop.com/electron/docs/libraries/cli),
[updater runtime](https://www.todesktop.com/electron/docs/libraries/runtime).
