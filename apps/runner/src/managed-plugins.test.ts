import { describe, expect, it, vi } from "vitest";
import {
  combineManagedArtifactFingerprints,
  materializePluginPackagesForSession,
} from "./managed-plugins";

const encoder = new TextEncoder();

describe("materializePluginPackagesForSession", () => {
  it("materializes the complete package byte-for-byte and locks its modes", async () => {
    const sandbox = fakeSandbox();
    const binary = Uint8Array.of(0, 255, 1, 2);
    const executable = encoder.encode("#!/bin/sh\r\nprintf plugin");

    const result = await materializePluginPackagesForSession({
      sandbox: sandbox as never,
      workRoot: "/home/user/workspace/codex",
      plugins: [
        {
          id: "plugin_quality_v1",
          name: "quality-tools",
          files: [
            {
              path: "plugin.json",
              content: encoder.encode('{"name":"quality-tools"}'),
              executable: false,
              sizeBytes: 24,
            },
            {
              path: "assets/exact.bin",
              content: binary,
              executable: false,
              sizeBytes: binary.length,
            },
            {
              path: "scripts/run.sh",
              content: executable,
              executable: true,
              sizeBytes: executable.length,
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      count: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const writes = sandbox.files.write.mock.calls[0]?.[0] as Array<{
      path: string;
      data: string | ArrayBuffer;
    }>;
    expect(
      writes.map(({ path, data }) => ({
        path,
        data: typeof data === "string" ? data : new Uint8Array(data),
      })),
    ).toEqual([
      {
        path: "/home/user/workspace/codex/.opencompany/plugins/quality-tools/plugin.json",
        data: encoder.encode('{"name":"quality-tools"}'),
      },
      {
        path: "/home/user/workspace/codex/.opencompany/plugins/quality-tools/assets/exact.bin",
        data: binary,
      },
      {
        path: "/home/user/workspace/codex/.opencompany/plugins/quality-tools/scripts/run.sh",
        data: executable,
      },
      {
        path: "/home/user/workspace/codex/.opencompany/plugins/.opencompany-managed-plugins.json",
        data: JSON.stringify({ version: 1, pluginNames: ["quality-tools"] }, null, 2),
      },
    ]);
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain(
      "test \"$(realpath -m -- '/home/user/workspace/codex/.opencompany')\" = '/home/user/workspace/codex/.opencompany'",
    );
    expect(commands[0]).toContain("test ! -L '/home/user/workspace/codex/.opencompany'");
    expect(commands[0]!.indexOf("realpath -m")).toBeLessThan(commands[0]!.indexOf("mkdir -p"));
    expect(commands.some((command) => command.includes("-type d -exec chmod 555"))).toBe(true);
    expect(commands.some((command) => command.includes("-type f -exec chmod 444"))).toBe(true);
    expect(
      commands.some(
        (command) => command.includes("chmod 555") && command.includes("scripts/run.sh"),
      ),
    ).toBe(true);
  });

  it("removes a stale managed package on the next reconciliation", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.read.mockResolvedValue(
      JSON.stringify({ version: 1, pluginNames: ["disabled-plugin"] }),
    );

    await materializePluginPackagesForSession({
      sandbox: sandbox as never,
      workRoot: "/home/user/workspace/codex",
      plugins: [],
    });

    expect(String(sandbox.commands.run.mock.calls[0]?.[0])).toContain(
      "/home/user/workspace/codex/.opencompany/plugins/disabled-plugin",
    );
  });

  it("includes package contents and modes in the combined runtime fingerprint", async () => {
    const materialize = (content: Uint8Array, executable: boolean) =>
      materializePluginPackagesForSession({
        sandbox: fakeSandbox() as never,
        workRoot: "/home/user/workspace/codex",
        plugins: [
          {
            id: "plugin_v1",
            name: "plugin",
            files: [{ path: "plugin.json", content, executable, sizeBytes: content.length }],
          },
        ],
      });
    const first = await materialize(encoder.encode("first"), false);
    const changedBytes = await materialize(encoder.encode("second"), false);
    const changedMode = await materialize(encoder.encode("first"), true);

    expect(combineManagedArtifactFingerprints("skills", first.fingerprint)).not.toBe(
      combineManagedArtifactFingerprints("skills", changedBytes.fingerprint),
    );
    expect(combineManagedArtifactFingerprints("skills", first.fingerprint)).not.toBe(
      combineManagedArtifactFingerprints("skills", changedMode.fingerprint),
    );
  });
});

function fakeSandbox() {
  return {
    commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
    files: {
      read: vi.fn().mockRejectedValue(new Error("missing")),
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
}
