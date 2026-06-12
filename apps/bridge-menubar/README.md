# OpenCompany Bridge — menubar app

A native macOS menubar app that controls the local bridge daemon: your **kill switch**,
permission-mode toggle, and a live view of what agents are doing on your machine.

It is a thin control surface — the `oc-bridge` daemon stays the sole permission authority.
The app only: starts/stops the daemon process, flips the `mode` field in
`~/.opencompany/bridge-settings.json` (preserving your allow/deny rules), and reads the
daemon's observation-only `~/.opencompany/bridge-status.json` for state + activity.

## What the menu gives you

- **Status** — device name + connection state (green connected / yellow starting / grey stopped).
- **Start / Stop bridge** — Stop is the kill switch: the daemon exits, the runner drops the
  socket, and your machine is unreachable from the cloud until you start it again.
- **Ask before each action / Allow everything** — the permission mode. Switching to
  *Allow everything* requires confirming in a local dialog (never a remote click).
- **Recent activity** — the last actions agents ran, with their decision.
- **Edit permission rules…** — opens `bridge-settings.json` to hand-edit allow/deny rules.

## Build & run

```sh
./build.sh                                   # → .build/OpenCompanyBridge.app
open .build/OpenCompanyBridge.app            # launches into the menubar (no dock icon)
```

The app is menubar-only (accessory activation policy + `LSUIElement`), so there is no dock
icon or window — look for the laptop icon in the menu bar.

## How it launches the daemon

The Start action runs the command in `~/.opencompany/menubar.json`:

```json
{ "daemonCommand": ["/path/to/bun", "/path/to/packages/bridge/src/cli.ts", "start"] }
```

If that file is absent it falls back to `oc-bridge start` on your `PATH`. Use the app **or**
the CLI daemon, not both at once (two daemons for one device fight over the connection).

## Not yet (v2)

Code signing / notarization (Gatekeeper will warn on first open — right-click → Open),
auto-launch at login, packaging the daemon as a bundled binary, and a richer rules editor
(today rules are edited as a file; the read-only mirror lives on the web Devices page).
