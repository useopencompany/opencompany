import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanupOutdatedElectricContainers,
  electricContainerNamesFromDockerList,
} from "./electric-container-cleanup.mjs";

test("selects labeled and legacy opencompany Electric containers", () => {
  const output = [
    "opencompany-electric-55010\t",
    "custom-electric\telectric",
    "opencompany-electric\t",
    "opencompany-electric-55010\t",
    "postgres\t",
  ].join("\n");

  assert.deepEqual(electricContainerNamesFromDockerList(output), [
    "custom-electric",
    "opencompany-electric",
    "opencompany-electric-55010",
  ]);
});

test("does not select unrelated or similarly named containers", () => {
  const output = [
    "opencompany-api\tapi",
    "opencompany-electric-backup\t",
    "other-electric\t",
    "postgres\t",
  ].join("\n");

  assert.deepEqual(electricContainerNamesFromDockerList(output), []);
});

test("force-removes every selected Electric container", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "ps") {
      return {
        status: 0,
        stdout: "opencompany-electric-55010\t\ncustom-electric\telectric\npostgres\t\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.deepEqual(cleanupOutdatedElectricContainers({ spawn }), {
    status: "removed",
    containers: ["custom-electric", "opencompany-electric-55010"],
  });
  assert.deepEqual(calls[1], [
    "docker",
    ["rm", "-f", "custom-electric", "opencompany-electric-55010"],
  ]);
});

test("does not attempt removal when the container runtime is unavailable", () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
  };

  assert.deepEqual(cleanupOutdatedElectricContainers({ spawn }), {
    status: "unavailable",
    containers: [],
  });
  assert.equal(calls, 1);
});
