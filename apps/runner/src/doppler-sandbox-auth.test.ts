import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plugin: vi.fn(),
  metadata: vi.fn(),
  load: vi.fn(),
  validate: vi.fn(),
  rejected: vi.fn(),
  validated: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./doppler-auth", () => ({
  hasDopplerPlugin: mocks.plugin,
  ensureDopplerInstalled: vi.fn(),
}));
vi.mock("./doppler-api", async (original) => ({
  ...(await original<object>()),
  validateDopplerToken: mocks.validate,
}));
vi.mock("@opencompany/db/doppler-auth", () => ({
  loadDopplerConnection: mocks.load,
  loadDopplerConnectionMetadata: mocks.metadata,
  markDopplerConnectionNeedsReauth: mocks.rejected,
  markDopplerConnectionValidated: mocks.validated,
}));

import { DopplerAuthRejected } from "./doppler-api";
import { reconcileDopplerSandboxAuth } from "./doppler-sandbox-auth";

const token = "dp.ct.test_token";
const metadata = { status: "connected", credentialGeneration: "generation_1" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.plugin.mockResolvedValue(true);
  mocks.metadata.mockResolvedValue(metadata);
  mocks.load.mockResolvedValue({ ...metadata, authBundle: { formatVersion: 1, token } });
  mocks.validate.mockResolvedValue("Developer");
});
function fixture(generation = "") {
  const commands = vi.fn(async (cmd: string) => ({
    stdout: cmd.startsWith("if test -f /home/user/.opencompany/doppler-generation; then cat")
      ? generation
      : "",
    exitCode: 0,
  }));
  const write = vi.fn(async () => undefined);
  return {
    commands,
    write,
    input: {
      sandbox: { commands: { run: commands }, files: { write } } as never,
      workspaceId: "workspace_1",
      userWorkosId: "user_1",
    },
  };
}
it("restores credentials without embedding them in commands or prompts", async () => {
  const f = fixture();
  const result = await reconcileDopplerSandboxAuth(f.input);
  expect(result.available).toBe(true);
  expect(result.redactionValues).toEqual([token]);
  expect(JSON.stringify(f.commands.mock.calls)).not.toContain(token);
  expect(result.promptFragment).not.toContain(token);
  expect(f.write).toHaveBeenCalledWith(expect.stringContaining("doppler-token"), token, {
    user: "user",
  });
  expect(f.commands).toHaveBeenCalledWith(
    expect.stringContaining("configure set token --scope /"),
    expect.anything(),
  );
  expect(f.commands).not.toHaveBeenCalledWith(
    expect.stringContaining("configure set project"),
    expect.anything(),
  );
});
it("keeps worktree mappings on subsequent turns without restoring again", async () => {
  const f = fixture("generation_1");
  expect((await reconcileDopplerSandboxAuth(f.input)).available).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
});
it("removes managed auth and caches when the plugin is disabled", async () => {
  mocks.plugin.mockResolvedValue(false);
  const f = fixture();
  expect((await reconcileDopplerSandboxAuth(f.input)).available).toBe(false);
  expect(f.commands).toHaveBeenCalledWith(
    expect.stringContaining("rm -rf /home/user/.doppler"),
    expect.anything(),
  );
  expect(mocks.load).not.toHaveBeenCalled();
});
it("surfaces reauthentication after provider rejection", async () => {
  mocks.validate.mockRejectedValue(new DopplerAuthRejected());
  const f = fixture();
  expect((await reconcileDopplerSandboxAuth(f.input)).available).toBe(false);
  expect(mocks.rejected).toHaveBeenCalledWith(
    expect.objectContaining({ expectedCredentialGeneration: "generation_1" }),
  );
});
it("fails closed if disconnect races restoration", async () => {
  mocks.metadata
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, status: "disconnected" });
  const f = fixture();
  await expect(reconcileDopplerSandboxAuth(f.input)).rejects.toThrow(
    "changed during sandbox preparation",
  );
  expect(f.commands.mock.calls.some(([cmd]) => cmd.includes("rm -rf /home/user/.doppler"))).toBe(
    true,
  );
});
