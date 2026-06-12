import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createExecutor } from "./executor";
import {
  BRIDGE_LIST_ENTRIES_CAP,
  BRIDGE_READ_FILE_CAP,
  BRIDGE_SHELL_OUTPUT_CAP,
} from "./protocol";

const tmp = mkdtempSync(join(tmpdir(), "oc-bridge-executor-"));
const executor = createExecutor();

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("local_shell", () => {
  it("captures stdout and the exit code", async () => {
    const result = await executor.local_shell({ command: "echo hello" });
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("captures stderr and non-zero exit codes", async () => {
    const result = await executor.local_shell({ command: "echo oops 1>&2; exit 3" });
    expect(result.stderr).toBe("oops\n");
    expect(result.exitCode).toBe(3);
  });

  it("runs in the requested cwd", async () => {
    const result = await executor.local_shell({ command: "pwd", cwd: tmp });
    expect(result.stdout.trim()).toBe(realpathSync(tmp));
  });

  it("defaults the cwd to the home directory", async () => {
    const result = await executor.local_shell({ command: "pwd" });
    expect(result.stdout.trim()).toBe(realpathSync(homedir()));
  });

  it("caps stdout at the shell output cap and flags truncation", async () => {
    const overCap = BRIDGE_SHELL_OUTPUT_CAP + 10_000;
    const result = await executor.local_shell({
      command: `head -c ${overCap} /dev/zero | tr '\\0' a`,
    });
    expect(result.stdout.length).toBe(BRIDGE_SHELL_OUTPUT_CAP);
    expect(result.truncated).toBe(true);
  });

  it("kills the process after the timeout", async () => {
    const fast = createExecutor({ shellTimeoutMs: 250 });
    const startedAt = Date.now();
    const result = await fast.local_shell({ command: "sleep 30; echo done" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("done");
  });
});

describe("local_read_file", () => {
  it("reads utf-8 content", async () => {
    const path = join(tmp, "read-me.txt");
    writeFileSync(path, "grüße\n", "utf8");
    expect(await executor.local_read_file({ path })).toEqual({ content: "grüße\n" });
  });

  it("caps content at the read cap and flags truncation", async () => {
    const path = join(tmp, "big.txt");
    writeFileSync(path, "a".repeat(BRIDGE_READ_FILE_CAP + 100), "utf8");
    const result = await executor.local_read_file({ path });
    expect(result.content.length).toBe(BRIDGE_READ_FILE_CAP);
    expect(result.truncated).toBe(true);
  });

  it("rejects when the file does not exist", async () => {
    await expect(executor.local_read_file({ path: join(tmp, "missing.txt") })).rejects.toThrow();
  });
});

describe("local_write_file", () => {
  it("writes utf-8 and returns the absolute path and byte count", async () => {
    const path = join(tmp, "out.txt");
    const result = await executor.local_write_file({ path, content: "héllo" });
    // "héllo" is 5 chars but 6 utf-8 bytes
    expect(result).toEqual({ path, bytesWritten: 6 });
    expect(await executor.local_read_file({ path })).toEqual({ content: "héllo" });
  });

  it("creates missing parent directories", async () => {
    const path = join(tmp, "deeply", "nested", "dir", "out.txt");
    const result = await executor.local_write_file({ path, content: "x" });
    expect(result.path).toBe(path);
    expect(await executor.local_read_file({ path })).toEqual({ content: "x" });
  });
});

describe("local_list_files", () => {
  const listRoot = join(tmp, "list");

  function setupListRoot(): void {
    mkdirSync(join(listRoot, "sub"), { recursive: true });
    mkdirSync(join(listRoot, ".git"), { recursive: true });
    mkdirSync(join(listRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(listRoot, "a.txt"), "aaa", "utf8");
    writeFileSync(join(listRoot, "sub", "inner.txt"), "b", "utf8");
    writeFileSync(join(listRoot, ".git", "HEAD"), "ref", "utf8");
    writeFileSync(join(listRoot, "node_modules", "pkg", "index.js"), "x", "utf8");
    symlinkSync(join(listRoot, "a.txt"), join(listRoot, "link"));
  }

  it("lists a single level by default with entry types and file sizes", async () => {
    setupListRoot();
    const result = await executor.local_list_files({ path: listRoot });
    expect(result.truncated).toBeUndefined();
    expect(result.entries).toEqual([
      { name: ".git", type: "dir" },
      { name: "a.txt", type: "file", size: 3 },
      { name: "link", type: "symlink" },
      { name: "node_modules", type: "dir" },
      { name: "sub", type: "dir" },
    ]);
  });

  it("walks recursively but does not descend into .git or node_modules", async () => {
    const result = await executor.local_list_files({ path: listRoot, recursive: true });
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain("sub/inner.txt");
    expect(names).toContain(".git");
    expect(names).toContain("node_modules");
    expect(names).not.toContain(".git/HEAD");
    expect(names.some((name) => name.startsWith("node_modules/"))).toBe(false);
  });

  it("stops at the entries cap and flags truncation", async () => {
    const crowded = join(tmp, "crowded");
    mkdirSync(crowded, { recursive: true });
    for (let i = 0; i < BRIDGE_LIST_ENTRIES_CAP + 10; i++) {
      writeFileSync(join(crowded, `file-${String(i).padStart(4, "0")}.txt`), "", "utf8");
    }
    const result = await executor.local_list_files({ path: crowded });
    expect(result.entries.length).toBe(BRIDGE_LIST_ENTRIES_CAP);
    expect(result.truncated).toBe(true);
  });

  it("rejects when the directory does not exist", async () => {
    await expect(executor.local_list_files({ path: join(tmp, "nope") })).rejects.toThrow();
  });
});
