import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BridgeToolName, BridgeVerdict } from "./protocol";
import type { BridgeSettings } from "./settings";

// The permission engine — the daemon's security boundary. Every request from the
// cloud passes through evaluatePermission before anything touches the machine.
//
// Rule grammar:
//   read(<glob>)    — local_read_file + local_list_files, matched by path
//   write(<glob>)   — local_write_file, matched by path
//   shell(<pattern>) — local_shell, literal command with `*` wildcards, full match
//
// Glob semantics: `**` (as a whole segment) crosses directory separators and a
// trailing `/**` also matches the directory itself; `*` stays within one segment;
// `?` matches a single non-separator character.

export type PermissionRequest = {
  tool: BridgeToolName;
  args: unknown;
  sessionId: string;
};

export type PermissionResult = {
  verdict: BridgeVerdict;
  rule?: string;
  summary: string;
};

export function expandTilde(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// Permission checks and execution must agree on the exact target, so both go through
// this resolver: ~-expansion, then lexical resolution of `.`/`..` segments. Relative
// paths anchor at the home directory, never the daemon's process cwd.
export function resolveBridgePath(path: string): string {
  const expanded = expandTilde(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

export function evaluatePermission(
  req: PermissionRequest,
  settings: BridgeSettings,
  sessionGrants: string[],
): PermissionResult {
  const target = resolveTarget(req.tool, req.args);
  if (!target.ok) {
    // Invalid args are denied (not asked about): there is nothing coherent for a
    // user to approve, and deny is the safe failure mode.
    return { verdict: "deny", summary: target.problem };
  }

  const matches = (rule: string) => ruleMatches(rule, req.tool, target);

  const denyRule = settings.deny.find(matches);
  if (denyRule !== undefined) {
    return { verdict: "deny", rule: denyRule, summary: target.summary };
  }

  const allowRule = settings.allow.find(matches) ?? sessionGrants.find(matches);
  if (allowRule !== undefined) {
    return { verdict: "allow", rule: allowRule, summary: target.summary };
  }

  if (settings.mode === "allow-everything") {
    return { verdict: "allow", summary: target.summary };
  }

  return { verdict: "ask", summary: target.summary };
}

// The rule a user approval mints. Shell approvals stay exact (one command); file
// approvals widen to the containing directory so an agent can finish its task
// without a prompt per file.
export function deriveGrantRule(req: { tool: BridgeToolName; args: unknown }): string {
  const target = resolveTarget(req.tool, req.args);
  if (!target.ok) {
    throw new Error(`Cannot derive grant rule: ${target.problem}`);
  }
  switch (req.tool) {
    case "local_shell":
      return `shell(${target.summary})`;
    case "local_read_file":
      return `read(${join(dirname(target.summary), "**")})`;
    case "local_write_file":
      return `write(${join(dirname(target.summary), "**")})`;
    case "local_list_files":
      return `read(${join(target.summary, "**")})`;
  }
}

type ResolvedTarget =
  | { ok: true; kind: "command"; command: string; summary: string }
  | { ok: true; kind: "path"; path: string; summary: string }
  | { ok: false; problem: string };

function resolveTarget(tool: BridgeToolName, args: unknown): ResolvedTarget {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, problem: `${tool}: args must be an object` };
  }
  const record = args as Record<string, unknown>;

  if (tool === "local_shell") {
    const command = record.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, problem: "local_shell: command must be a non-empty string" };
    }
    if (record.cwd !== undefined && typeof record.cwd !== "string") {
      return { ok: false, problem: "local_shell: cwd must be a string" };
    }
    const trimmed = command.trim();
    return { ok: true, kind: "command", command: trimmed, summary: trimmed };
  }

  const path = record.path;
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, problem: `${tool}: path must be a non-empty string` };
  }
  if (tool === "local_write_file" && typeof record.content !== "string") {
    return { ok: false, problem: "local_write_file: content must be a string" };
  }
  const resolved = resolveBridgePath(path);
  return { ok: true, kind: "path", path: resolved, summary: resolved };
}

type ParsedRule =
  | { kind: "read" | "write"; glob: string }
  | { kind: "shell"; pattern: string };

// Malformed rules never match — a typo in a hand-edited allow rule fails closed.
function parseRule(rule: string): ParsedRule | null {
  const match = /^(read|write|shell)\((.*)\)$/s.exec(rule.trim());
  if (!match) {
    return null;
  }
  const kind = match[1] as "read" | "write" | "shell";
  const body = match[2] ?? "";
  if (body.length === 0) {
    return null;
  }
  return kind === "shell" ? { kind, pattern: body } : { kind, glob: body };
}

function ruleMatches(rule: string, tool: BridgeToolName, target: ResolvedTarget): boolean {
  if (!target.ok) {
    return false;
  }
  const parsed = parseRule(rule);
  if (!parsed) {
    return false;
  }

  if (parsed.kind === "shell") {
    return (
      tool === "local_shell" &&
      target.kind === "command" &&
      shellPatternToRegExp(parsed.pattern).test(target.command)
    );
  }

  if (target.kind !== "path") {
    return false;
  }
  const toolMatches =
    parsed.kind === "read"
      ? tool === "local_read_file" || tool === "local_list_files"
      : tool === "local_write_file";
  return toolMatches && globToRegExp(parsed.glob).test(target.path);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellPatternToRegExp(pattern: string): RegExp {
  const source = pattern.trim().split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`);
}

function globToRegExp(glob: string): RegExp {
  // Globs go through the same resolver as request paths so `~` and `..` in rules
  // cannot diverge from how the request was resolved.
  const absolute = resolveBridgePath(glob);
  let source = "";
  const segments = absolute.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      // Zero or more whole segments, each consuming its own leading separator —
      // a trailing `/**` therefore also matches the bare directory.
      source += "(?:/[^/]+)*";
    } else {
      source += (index === 0 ? "" : "/") + compileGlobSegment(segment);
    }
  }
  return new RegExp(`^${source}$`);
}

function compileGlobSegment(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(char);
    }
  }
  return out;
}
