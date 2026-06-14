import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveGrantRule,
  evaluatePermission,
  expandTilde,
  type PermissionRequest,
  resolveBridgePath,
} from "./permissions";
import type { BridgeSettings } from "./settings";

const HOME = homedir();

function settings(overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return { mode: "ask", allow: [], deny: [], ...overrides };
}

function shellReq(command: unknown, sessionId = "ses_1"): PermissionRequest {
  return { tool: "local_shell", args: { command }, sessionId };
}

function readReq(path: unknown, sessionId = "ses_1"): PermissionRequest {
  return { tool: "local_read_file", args: { path }, sessionId };
}

function writeReq(path: unknown, content: unknown = "x", sessionId = "ses_1"): PermissionRequest {
  return { tool: "local_write_file", args: { path, content }, sessionId };
}

function listReq(path: unknown, sessionId = "ses_1"): PermissionRequest {
  return { tool: "local_list_files", args: { path }, sessionId };
}

describe("resolveBridgePath", () => {
  it("expands ~ to the home directory", () => {
    expect(resolveBridgePath("~")).toBe(HOME);
    expect(resolveBridgePath("~/Projects/app")).toBe(join(HOME, "Projects", "app"));
  });

  it("resolves .. traversal lexically", () => {
    expect(resolveBridgePath("~/Projects/../.ssh/id_rsa")).toBe(join(HOME, ".ssh", "id_rsa"));
    expect(resolveBridgePath("/a/b/../../etc/passwd")).toBe("/etc/passwd");
  });

  it("anchors relative paths at the home directory, not the process cwd", () => {
    expect(resolveBridgePath("Projects/notes.txt")).toBe(join(HOME, "Projects", "notes.txt"));
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTilde("/data/~/x")).toBe("/data/~/x");
  });
});

describe("evaluatePermission — shell patterns", () => {
  it("allows an exact literal command", () => {
    const result = evaluatePermission(
      shellReq("git status"),
      settings({ allow: ["shell(git status)"] }),
      [],
    );
    expect(result).toEqual({ verdict: "allow", rule: "shell(git status)", summary: "git status" });
  });

  it("treats * as a wildcard within the command", () => {
    const rules = settings({ allow: ["shell(git *)", "shell(brew install *)"] });
    expect(evaluatePermission(shellReq("git push origin main"), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(shellReq("brew install ffmpeg"), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(shellReq("brew uninstall ffmpeg"), rules, []).verdict).toBe("ask");
  });

  it("requires a full match of the trimmed command", () => {
    const rules = settings({ allow: ["shell(git status)"] });
    expect(evaluatePermission(shellReq("git status --short"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(shellReq("XDG=1 git status"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(shellReq("  git status \n"), rules, []).verdict).toBe("allow");
  });

  it("does not let a prefix wildcard rule match a different binary", () => {
    const rules = settings({ allow: ["shell(git *)"] });
    expect(evaluatePermission(shellReq("gitk --all"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(shellReq("git"), rules, []).verdict).toBe("ask");
  });

  it("escapes regex metacharacters in the pattern", () => {
    const rules = settings({ allow: ["shell(echo $(whoami))"] });
    expect(evaluatePermission(shellReq("echo $(whoami)"), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(shellReq("echo X(whoami)"), rules, []).verdict).toBe("ask");
    // `.` must stay literal, not match-any
    const dot = settings({ allow: ["shell(ls a.txt)"] });
    expect(evaluatePermission(shellReq("ls aZtxt"), dot, []).verdict).toBe("ask");
  });

  it("never matches file tools with a shell rule", () => {
    const rules = settings({ allow: ["shell(*)"] });
    expect(evaluatePermission(readReq("~/anything"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(writeReq("~/anything"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(listReq("~/anything"), rules, []).verdict).toBe("ask");
  });

  it("uses the trimmed command as the summary", () => {
    const result = evaluatePermission(shellReq("  ls -la  "), settings(), []);
    expect(result.summary).toBe("ls -la");
  });
});

describe("evaluatePermission — path globs", () => {
  it("matches ** across directory separators", () => {
    const rules = settings({ allow: ["read(~/Projects/**)"] });
    expect(
      evaluatePermission(readReq(`${HOME}/Projects/app/src/index.ts`), rules, []).verdict,
    ).toBe("allow");
    expect(evaluatePermission(readReq(`${HOME}/Projects/x.txt`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(readReq(`${HOME}/Other/x.txt`), rules, []).verdict).toBe("ask");
  });

  it("matches the directory itself with a trailing /**", () => {
    const rules = settings({ allow: ["read(~/Projects/**)"] });
    expect(evaluatePermission(listReq(`${HOME}/Projects`), rules, []).verdict).toBe("allow");
  });

  it("keeps * within a single path segment", () => {
    const rules = settings({ allow: ["read(~/Projects/*.txt)"] });
    expect(evaluatePermission(readReq(`${HOME}/Projects/a.txt`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(readReq(`${HOME}/Projects/sub/a.txt`), rules, []).verdict).toBe(
      "ask",
    );
  });

  it("matches exactly one non-separator character with ?", () => {
    const rules = settings({ allow: ["read(~/file?.txt)"] });
    expect(evaluatePermission(readReq(`${HOME}/file1.txt`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(readReq(`${HOME}/file12.txt`), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(readReq(`${HOME}/file.txt`), rules, []).verdict).toBe("ask");
  });

  it("matches zero or more directories with a mid-pattern /**/", () => {
    const rules = settings({ allow: ["read(~/Projects/**/secret.txt)"] });
    expect(evaluatePermission(readReq(`${HOME}/Projects/a/b/secret.txt`), rules, []).verdict).toBe(
      "allow",
    );
    expect(evaluatePermission(readReq(`${HOME}/Projects/secret.txt`), rules, []).verdict).toBe(
      "allow",
    );
    expect(evaluatePermission(readReq(`${HOME}/Projects/a/other.txt`), rules, []).verdict).toBe(
      "ask",
    );
  });

  it("expands ~ in the request path and summarizes with the absolute path", () => {
    const rules = settings({ allow: ["read(~/Projects/**)"] });
    const result = evaluatePermission(readReq("~/Projects/x.txt"), rules, []);
    expect(result.verdict).toBe("allow");
    expect(result.summary).toBe(join(HOME, "Projects", "x.txt"));
  });

  it("resolves .. traversal in the request path before matching", () => {
    const rules = settings({
      allow: ["read(~/Projects/**)"],
      deny: ["read(~/.ssh/**)"],
    });
    const result = evaluatePermission(readReq("~/Projects/../.ssh/id_rsa"), rules, []);
    expect(result.verdict).toBe("deny");
    expect(result.rule).toBe("read(~/.ssh/**)");
    expect(result.summary).toBe(join(HOME, ".ssh", "id_rsa"));
  });

  it("resolves relative request paths against the home directory", () => {
    const rules = settings({ allow: ["read(~/Projects/**)"] });
    expect(evaluatePermission(readReq("Projects/notes.txt"), rules, []).verdict).toBe("allow");
  });

  it("scopes read rules to read/list and write rules to write", () => {
    const rules = settings({ allow: ["read(~/r/**)", "write(~/w/**)"] });
    expect(evaluatePermission(readReq(`${HOME}/r/a`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(listReq(`${HOME}/r/a`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(writeReq(`${HOME}/r/a`), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(writeReq(`${HOME}/w/a`), rules, []).verdict).toBe("allow");
    expect(evaluatePermission(readReq(`${HOME}/w/a`), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(listReq(`${HOME}/w/a`), rules, []).verdict).toBe("ask");
  });
});

describe("evaluatePermission — precedence", () => {
  const sshKey = `${HOME}/.ssh/id_rsa`;

  it("deny beats a matching allow rule", () => {
    const rules = settings({ allow: ["read(~/**)"], deny: ["read(~/.ssh/**)"] });
    const result = evaluatePermission(readReq(sshKey), rules, []);
    expect(result.verdict).toBe("deny");
    expect(result.rule).toBe("read(~/.ssh/**)");
  });

  it("deny beats allow-everything mode", () => {
    const rules = settings({ mode: "allow-everything", deny: ["read(~/.ssh/**)"] });
    expect(evaluatePermission(readReq(sshKey), rules, []).verdict).toBe("deny");
  });

  it("deny beats a session grant", () => {
    const rules = settings({ deny: ["read(~/.ssh/**)"] });
    const result = evaluatePermission(readReq(sshKey), rules, [`read(${HOME}/.ssh/**)`]);
    expect(result.verdict).toBe("deny");
    expect(result.rule).toBe("read(~/.ssh/**)");
  });

  it("deny beats everything for shell too", () => {
    const rules = settings({
      mode: "allow-everything",
      allow: ["shell(rm *)"],
      deny: ["shell(rm -rf *)"],
    });
    expect(evaluatePermission(shellReq("rm -rf /tmp/x"), rules, []).verdict).toBe("deny");
    expect(evaluatePermission(shellReq("rm /tmp/x"), rules, []).verdict).toBe("allow");
  });

  it("allows via a session grant when no settings rule matches", () => {
    const grant = `read(${HOME}/Projects/**)`;
    const result = evaluatePermission(readReq(`${HOME}/Projects/a.txt`), settings(), [grant]);
    expect(result).toEqual({
      verdict: "allow",
      rule: grant,
      summary: join(HOME, "Projects", "a.txt"),
    });
  });

  it("allows everything in allow-everything mode without reporting a rule", () => {
    const result = evaluatePermission(
      shellReq("anything goes"),
      settings({ mode: "allow-everything" }),
      [],
    );
    expect(result.verdict).toBe("allow");
    expect(result.rule).toBeUndefined();
  });

  it("asks when nothing matches in ask mode", () => {
    const result = evaluatePermission(shellReq("ls"), settings(), []);
    expect(result).toEqual({ verdict: "ask", summary: "ls" });
  });

  it("ignores malformed rules instead of throwing", () => {
    const rules = settings({
      allow: ["banana", "read(", "shell", "exec(ls)", ""],
      deny: ["garbage)"],
    });
    expect(evaluatePermission(shellReq("ls"), rules, []).verdict).toBe("ask");
    expect(evaluatePermission(readReq(`${HOME}/x`), rules, []).verdict).toBe("ask");
  });
});

describe("evaluatePermission — invalid args", () => {
  it("denies without a rule when args is not an object", () => {
    for (const args of [null, undefined, "ls", 42, []]) {
      const result = evaluatePermission(
        { tool: "local_shell", args, sessionId: "ses_1" },
        settings({ mode: "allow-everything" }),
        [],
      );
      expect(result.verdict).toBe("deny");
      expect(result.rule).toBeUndefined();
      expect(result.summary.length).toBeGreaterThan(0);
    }
  });

  it("denies a shell request with a missing, empty, or non-string command", () => {
    for (const command of [undefined, "", "   ", 42, ["ls"]]) {
      const result = evaluatePermission(
        shellReq(command),
        settings({ mode: "allow-everything" }),
        [],
      );
      expect(result.verdict).toBe("deny");
      expect(result.rule).toBeUndefined();
      expect(result.summary).toContain("command");
    }
  });

  it("denies a shell request with a non-string cwd", () => {
    const result = evaluatePermission(
      { tool: "local_shell", args: { command: "ls", cwd: 42 }, sessionId: "ses_1" },
      settings({ mode: "allow-everything" }),
      [],
    );
    expect(result.verdict).toBe("deny");
    expect(result.summary).toContain("cwd");
  });

  it("denies file requests with a missing or non-string path", () => {
    for (const path of [undefined, "", 42, {}]) {
      for (const req of [readReq(path), writeReq(path), listReq(path)]) {
        const result = evaluatePermission(req, settings({ mode: "allow-everything" }), []);
        expect(result.verdict).toBe("deny");
        expect(result.rule).toBeUndefined();
        expect(result.summary).toContain("path");
      }
    }
  });

  it("denies a write request with non-string content", () => {
    const result = evaluatePermission(
      writeReq(`${HOME}/x.txt`, 42),
      settings({ mode: "allow-everything" }),
      [],
    );
    expect(result.verdict).toBe("deny");
    expect(result.summary).toContain("content");
  });
});

describe("deriveGrantRule", () => {
  it("mints the exact trimmed command for shell", () => {
    expect(deriveGrantRule(shellReq("  git status "))).toBe("shell(git status)");
  });

  it("mints the parent directory for read and write", () => {
    expect(deriveGrantRule(readReq("~/Projects/app/index.ts"))).toBe(
      `read(${join(HOME, "Projects", "app")}/**)`,
    );
    expect(deriveGrantRule(writeReq("~/Projects/out/x.json"))).toBe(
      `write(${join(HOME, "Projects", "out")}/**)`,
    );
  });

  it("mints the directory itself for list", () => {
    expect(deriveGrantRule(listReq("~/Projects"))).toBe(`read(${join(HOME, "Projects")}/**)`);
  });

  it("mints rules that allow the same request when replayed as a session grant", () => {
    for (const req of [
      shellReq("git status"),
      readReq("~/Projects/app/index.ts"),
      writeReq("~/Projects/out/x.json"),
      listReq("~/Projects"),
    ]) {
      const rule = deriveGrantRule(req);
      expect(evaluatePermission(req, settings(), [rule]).verdict).toBe("allow");
    }
  });
});
