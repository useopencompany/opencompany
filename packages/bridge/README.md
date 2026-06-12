# @opencompany/bridge

The local bridge daemon: pairs your own computer with an OpenCompany workspace so cloud
agents can act on it — write files, run commands, install things — gated by a
Claude-Code-style permission flow you approve in the browser.

**The daemon is the sole permission authority.** Grants live in a local settings file on
your machine; the cloud can ask, never grant. The daemon only dials out (no open ports),
and `deny` rules win over everything, including allow-everything mode.

## Usage

```sh
# 1. Pair (shows a short code; confirm it under Settings → Devices in the browser)
bun packages/bridge/src/cli.ts pair --url http://localhost:3000

# 2. Start the daemon (keeps an outbound WebSocket to the runner)
bun packages/bridge/src/cli.ts start

# Other commands
bun packages/bridge/src/cli.ts status   # config + rule summary
bun packages/bridge/src/cli.ts trust    # toggle allow-everything (local confirm required)
bun packages/bridge/src/cli.ts revoke   # forget this device locally
```

## Files (in `~/.opencompany/`, override dir with `OC_BRIDGE_HOME`)

- `bridge.json` — device identity (id + secret), 0600. Created by `pair`.
- `bridge-settings.json` — the permission rulebook. Hand-editable:

```json
{
  "mode": "ask",
  "allow": ["read(~/Projects/**)", "shell(git *)"],
  "deny": ["read(~/.ssh/**)", "write(~/.ssh/**)"]
}
```

Rule grammar: `read(<glob>)` (covers reading + listing), `write(<glob>)`,
`shell(<pattern>)` where `*` wildcards (full-match against the command). Precedence:
`deny` > `allow` > session grants > `mode`. Clicking **Always allow** in the browser
appends a rule here; **This session** lives in daemon memory until restart.

## How a call flows

1. Agent (cloud) calls `local_shell` / `local_read_file` / `local_write_file` / `local_list_files`.
2. Runner asks this daemon: allowed? → allow runs, deny blocks, otherwise the run pauses
   and the browser shows an approval card (Allow once / This session / Always / Deny).
3. The daemon re-checks its rulebook before executing — a compromised cloud cannot mint
   grants. Every decision is logged locally and mirrored to the Devices audit log.
