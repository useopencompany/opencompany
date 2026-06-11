# Local Bridge — agent access to the user's PC

**Status:** Approved design (2026-06-11)
**Branch:** `browser-agent-pc-control`

## Problem

OpenCompany agents run headless in E2B cloud sandboxes; everything they touch lives in the cloud. Users want agents to also act on their **real computer** — write files, run commands, install software — without giving up control. No screen streaming; a command channel plus an approval UX is enough.

## Decisions

- **Product feature**: any workspace user can pair their PC, not a one-off hack.
- **Agent stays in the cloud** (Approach A). The local device is a *tool target*: new `local_*` tools are routed by the runner to a paired daemon instead of the E2B sandbox. No second runtime.
- **CLI daemon first** (`oc-bridge …`); a menubar app can wrap it later.
- **Progressive trust like Claude Code**: initial folder grants at pairing → per-action prompts in the browser with [Once] [This session] [Always] [Deny] → optional allow-everything mode → human-editable local settings file.

## Security invariants

1. **The daemon is the sole permission authority.** Grants live on the device. The cloud can *ask*, never *grant*. A compromised server can send requests but cannot expand permissions.
2. **Outbound-only connectivity.** The daemon dials the runner over WebSocket; no open ports on the user's machine. Daemon stopped = device gone.
3. **Allow-everything requires local confirmation** (interactive prompt on the PC), never just a browser click.
4. **`deny` rules always win**, even in allow-everything mode.
5. Every executed or denied action is written to an audit log.

## Components

### `packages/bridge` — CLI daemon (Bun/TS)

- `oc-bridge pair` — shows a short code; user confirms in the browser while logged in. Device token stored in `~/.opencompany/bridge.json` (0600).
- `oc-bridge start` — outbound WS to the runner; executes tool requests as the local OS user.
- `oc-bridge status` / `revoke` / `trust --allow-everything` (local-only, interactive confirm).
- **Permission engine** evaluates requests against `~/.opencompany/bridge-settings.json`:

```json
{
  "mode": "ask",
  "allow": ["read(~/Projects/**)", "shell(git *)"],
  "deny":  ["read(~/.ssh/**)"]
}
```

Precedence: `deny` > `allow` > session grants > `mode`. Browser [Always] decisions append to `allow`; the file is hand-editable. Session grants live in daemon memory only, keyed by sessionId.

### Runner (`apps/runner`)

- WS endpoint authenticated by device token; registry deviceId → live socket.
- Four new tools in `RUNTIME_TOOL_DEFINITIONS`: `local_shell`, `local_read_file`, `local_write_file`, `local_list_files`; routed in `tool-dispatcher.ts` to the device manager (mirrors the `hosted-tools.ts` dispatch pattern).
- JSON request/response over the socket with request ids, timeouts, output size caps.
- Daemon answers `needs_approval` → runner emits an approval event to the session's Durable Stream, waits for the user decision (timeout = deny), forwards it to the daemon.
- Device offline / nothing paired → tools return a clean error string so the agent can tell the user.
- Paired + online devices are surfaced in the agent's session context.

### DB (`packages/db`)

- `workspace_devices`: id, workspaceId, userId, name, platform, tokenHash, status, lastSeenAt.
- `device_actions`: audit log (deviceId, sessionId, tool, summary, decision, timestamps).
- Grants are *not* authoritative in the DB; at most mirrored read-only for UI.

### Web (`apps/web`)

- Pairing API + page (confirm code, name device, pick initial folder grants).
- Settings → Devices: list, last seen, revoke (server invalidates token → runner drops socket).
- Approval card in the session view: [Once] [This session] [Always] [Deny] → decision API → runner.
- Minimal audit view over `device_actions`.

## Not in v1

Screen viewing / computer use, Windows/Linux daemons (macOS first), multi-device UI (schema supports it; UI shows one), daemon auto-update, launchd autostart, menubar app.

## Verification

- Exhaustive unit tests for the permission matcher (it is the security boundary).
- Integration test: daemon ↔ runner over WS on the full local stack; scripted approval round-trip.
- Manual E2E: pair a real Mac; silent write into an allowed folder; approval card for a non-granted folder; exercise Once/Session/Always/Deny; revoke and confirm the socket drops.
