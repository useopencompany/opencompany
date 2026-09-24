# @opencompany/desktop

Thin Electron shell that wraps the production opencompany web app
(`https://my.opencompany.chat`) as a downloadable macOS app. Product code keeps
deploying via Vercel — the desktop app picks it up instantly. The shell itself
updates rarely: GitHub Actions builds, signs, and notarizes it, and installed
apps update themselves from GitHub Releases. Builds cover Apple silicon and Intel.

The shell bundles no Next.js and has **no `@opencompany/*` workspace deps** on
purpose. esbuild bundles all runtime code, including `electron-updater`, into
`dist/`, so the packaged app ships no `node_modules`.

## Layout

- `src/main.ts` — app lifecycle, protocol registration, deep-link + update wiring.
- `src/window.ts` — the inset-title-bar `BrowserWindow` (sandboxed, context-isolated) + persisted bounds.
- `src/navigation.ts` — origin allowlist, external-link routing, offline fallback.
- `src/auth.ts` — PKCE verifier + the Google system-browser sign-in handoff.
- `src/menu.ts` — application menu (incl. Check for Updates and a dev-only paste-callback item).
- `src/updates.ts` — background updates and the manual check.
- `src/install-location.ts` — offers to move the app to /Applications, where updates can install.
- `src/preload.ts` — the `window.opencompanyDesktop` contextBridge global + desktop document marker.
- `src/urls.ts` — the wrapped app URL (`OPENCOMPANY_DESKTOP_APP_URL` override).
- `assets/offline.html` — shown when the app URL can't load.
- `assets/icon.png` — 1024×1024 macOS app icon, generated from `icon-source.svg`.

## Scripts

- `bun run dev` — build and run against production.
- `bun run dev:local` — build and run against `https://localhost:3443` (self-signed cert allowed).
- `bun run build:src` — esbuild the main + preload bundles into `dist/`.
- `bun run typecheck` / `bun run lint`.
- `bun run package:unsigned` — build unsigned Apple silicon and Intel apps, zips, and DMGs into `release/`.
- `bun run package` — the same, signed and notarized. Needs the credentials that CI loads.
- `bun run verify:package` — check the bundle, sign-in URL scheme, and update feed in `release/`.

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

## Updates

Installed apps check for updates 10 seconds after launch, every hour, and
after the Mac wakes. They use `electron-updater` with GitHub Releases on this
repository and download new versions in the background. Squirrel.Mac then
stages the update. Only after that does the web app's title bar show an
**Update** button, which restarts into the new version. If the user never
clicks it, the update installs the next time they quit. **Check for Updates…**
in the app menu does the same check on demand.

The updater follows the release that GitHub marks as **Latest**, and reads
`latest-mac.yml` and the matching zip from that exact tag. Draft releases are
invisible to it. Do not mark any other kind of release in this repository as
Latest, because installed apps would stop finding updates.

Squirrel.Mac cannot replace an app that runs from the mounted DMG or from a
translocated Downloads copy. The app asks to move itself to /Applications on
each launch until it lives there.

## Releases

Releases are built by `.github/workflows/release-desktop.yml` on a macOS runner.
The shell loads production web content, so web changes deploy separately.
Rebuilding Electron does not deploy `apps/web`.

1. Bump `version` in `apps/desktop/package.json` and merge to `main`. The PR
   gate runs the desktop unit tests, typecheck, and lint. To keep macOS runner
   costs down it does not package the app; run `bun run package:unsigned` and
   `bun run verify:package` on a Mac when you change packaging.
2. Run **Release desktop app** from `main` with **publish** off. The workflow
   signs with the Developer ID certificate and notarizes with the App Store
   Connect API key. It then checks the signature, Gatekeeper, the stapled
   ticket, and the update feed, and uploads a draft `desktop-v<version>` release.
3. Download the DMG from the draft, install it, and check Google sign-in,
   quit/relaunch session persistence, voice dictation, and external links.
4. Publish the draft and keep **Set as the latest release** checked. Every
   installed app picks it up within an hour. Running the workflow with
   **publish** on combines steps 2 and 4.

Before the first public release, check the update path with two versions:
install version N, publish N+1, and confirm the Update button appears, the
restart lands on N+1, and the session survives. Also check that quitting
without clicking Update installs it.

Copies installed from ToDesktop builds (0.1.x) check ToDesktop's feed, not
GitHub Releases, so testers must reinstall 0.2.0 from the DMG once.

To roll back, publish a higher version built from the last good commit.
Updates only move forward.

Signing credentials live in Infisical `prod` `/desktop`. See
[deployment](../../docs/deployment.md#desktop-releases).
