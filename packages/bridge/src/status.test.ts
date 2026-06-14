import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStatusWriter, readStatus } from "./status";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-bridge-status-"));
  path = join(dir, "bridge-status.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(iso: string) {
  return () => new Date(iso);
}

describe("createStatusWriter", () => {
  it("writes connection state and stamps updatedAt", () => {
    const writer = createStatusWriter({
      deviceName: "Test Mac",
      mode: "ask",
      path,
      now: fixedClock("2026-06-12T10:00:00.000Z"),
    });
    writer.setConnected(true);

    const status = readStatus(path);
    expect(status).toMatchObject({
      deviceName: "Test Mac",
      connected: true,
      mode: "ask",
      updatedAt: "2026-06-12T10:00:00.000Z",
      recentActions: [],
    });
  });

  it("prepends activity newest-first and caps the ring buffer at 25", () => {
    const writer = createStatusWriter({ deviceName: "Mac", mode: "allow-everything", path });
    for (let i = 0; i < 30; i += 1) {
      writer.pushActivity({
        tool: "local_shell",
        decision: "allowed_by_mode",
        summary: `cmd ${i}`,
      });
    }
    const status = readStatus(path);
    expect(status?.recentActions).toHaveLength(25);
    // Newest first: the last pushed (cmd 29) is at index 0.
    expect(status?.recentActions[0]?.summary).toBe("cmd 29");
    expect(status?.recentActions.at(-1)?.summary).toBe("cmd 5");
  });

  it("tracks mode changes", () => {
    const writer = createStatusWriter({ deviceName: "Mac", mode: "ask", path });
    writer.setMode("allow-everything");
    expect(readStatus(path)?.mode).toBe("allow-everything");
  });

  it("readStatus returns null when the file is absent", () => {
    expect(readStatus(join(dir, "missing.json"))).toBeNull();
  });
});
