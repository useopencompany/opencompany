import assert from "node:assert/strict";
import test from "node:test";
import { selectOrphanedNgrokProcesses } from "./ngrok-dev.mjs";

test("selectOrphanedNgrokProcesses only selects orphaned ngrok agents in scope", () => {
  const processes = [
    { pid: 101, ppid: 1, command: "ngrok" },
    { pid: 102, ppid: 55, command: "ngrok" },
    { pid: 103, ppid: 1, command: "node" },
    { pid: 104, ppid: 1, command: "/opt/homebrew/bin/ngrok" },
  ];
  const cwdByPid = new Map([
    [101, "/workspaces/opencompany/archived"],
    [102, "/workspaces/opencompany/active"],
    [103, "/workspaces/opencompany/archived"],
    [104, "/workspaces/another-repo/archived"],
  ]);

  assert.deepEqual(selectOrphanedNgrokProcesses(processes, cwdByPid, "/workspaces/opencompany"), [
    processes[0],
  ]);
});

test("selectOrphanedNgrokProcesses does not match a sibling path prefix", () => {
  const processInfo = { pid: 101, ppid: 1, command: "ngrok" };
  const cwdByPid = new Map([[101, "/workspaces/opencompany-copy/archived"]]);

  assert.deepEqual(
    selectOrphanedNgrokProcesses([processInfo], cwdByPid, "/workspaces/opencompany"),
    [],
  );
});
