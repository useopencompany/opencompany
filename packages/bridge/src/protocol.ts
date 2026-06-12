// Wire protocol between the runner (cloud) and the oc-bridge daemon (the user's PC).
//
// The daemon dials OUT to the runner — `GET {runnerUrl}/bridge/ws` upgraded to a
// WebSocket with headers `authorization: Bearer <deviceSecret>` and
// `x-device-id: <deviceId>`. The user's machine never listens on a port.
//
// Security invariant: the daemon is the sole permission authority. The runner may ask
// ("check") and may relay a user decision ("execute" with a grant), but the daemon
// re-evaluates its local rulebook before running anything. A compromised runner can
// send requests all day; it cannot mint grants.

export type BridgeToolName =
  | "local_shell"
  | "local_read_file"
  | "local_write_file"
  | "local_list_files";

export const BRIDGE_TOOL_NAMES: readonly BridgeToolName[] = [
  "local_shell",
  "local_read_file",
  "local_write_file",
  "local_list_files",
];

export function isBridgeToolName(name: string): name is BridgeToolName {
  return (BRIDGE_TOOL_NAMES as readonly string[]).includes(name);
}

// How long a user-approved grant lives on the device. "once" covers only the call it
// approved, "session" lives in daemon memory until the daemon restarts, "always" is
// appended to the device's local settings file.
export type BridgeGrantScope = "once" | "session" | "always";

// The permission outcome the daemon attaches to a result, mirrored into the
// device_actions audit log by the runner.
export type BridgeDecision =
  | "allowed_by_rule"
  | "allowed_by_mode"
  | "approved_once"
  | "approved_session"
  | "approved_always"
  | "denied_by_rule"
  | "denied_by_user";

export type BridgeErrorCode =
  | "permission_denied"
  | "needs_approval"
  | "invalid_args"
  | "execution_failed";

export type BridgeShellArgs = { command: string; cwd?: string };
export type BridgeReadFileArgs = { path: string };
export type BridgeWriteFileArgs = { path: string; content: string };
export type BridgeListFilesArgs = { path: string; recursive?: boolean };

export type BridgeShellOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
};
export type BridgeReadFileOutput = { content: string; truncated?: boolean };
export type BridgeWriteFileOutput = { path: string; bytesWritten: number };
export type BridgeListFilesOutput = {
  entries: { name: string; type: "file" | "dir" | "symlink"; size?: number }[];
  truncated?: boolean;
};

// Output safety caps, enforced by the daemon before anything goes over the wire so a
// stray `npm install` log cannot flood the agent's context.
export const BRIDGE_SHELL_OUTPUT_CAP = 50_000;
export const BRIDGE_READ_FILE_CAP = 200_000;
export const BRIDGE_LIST_ENTRIES_CAP = 500;
export const BRIDGE_SHELL_TIMEOUT_MS = 120_000;

export type RunnerToDaemonMessage =
  | {
      kind: "check";
      id: string;
      sessionId: string;
      tool: BridgeToolName;
      args: unknown;
    }
  | {
      kind: "execute";
      id: string;
      sessionId: string;
      tool: BridgeToolName;
      args: unknown;
      // Present when the user just approved this call in the browser. The daemon
      // records the grant (per scope) and executes.
      grant?: { scope: BridgeGrantScope };
    }
  | { kind: "ping"; id: string };

export type BridgeVerdict = "allow" | "deny" | "ask";

export type DaemonToRunnerMessage =
  | {
      kind: "verdict";
      id: string;
      verdict: BridgeVerdict;
      // The matched settings rule, when one decided the verdict (for audit/debugging).
      rule?: string;
      // One-line human summary of what was requested, e.g. the command or path.
      summary: string;
    }
  | {
      kind: "result";
      id: string;
      ok: true;
      output: unknown;
      decision: BridgeDecision;
      summary: string;
    }
  | {
      kind: "result";
      id: string;
      ok: false;
      error: { code: BridgeErrorCode; message: string };
      decision?: BridgeDecision;
      summary: string;
    }
  | { kind: "pong"; id: string };

export const BRIDGE_WS_PATH = "/bridge/ws";
