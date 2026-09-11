import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrations: vi.fn(),
  metadata: vi.fn(),
  connection: vi.fn(),
  validated: vi.fn(),
  needsReauth: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  listActivePluginGatewayRegistrations: mocks.registrations,
}));
vi.mock("@opencompany/db/infisical-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadInfisicalConnectionMetadata: mocks.metadata,
  loadInfisicalConnection: mocks.connection,
  markInfisicalConnectionValidated: mocks.validated,
  markInfisicalConnectionNeedsReauth: mocks.needsReauth,
}));

import { reconcileInfisicalSandboxAuth } from "./infisical-sandbox-auth";
import { INFISICAL_CLI_VERSION } from "./infisical-version";

it("restores the same personal login after disabling and re-enabling the plugin", async () => {
  const generationPath = "/home/user/.opencompany/infisical-generation";
  const configPath = "/home/user/.infisical/infisical-config.json";
  const keyPath = "/home/user/infisical-keyring/infisical-backup-secret-encryption-key";
  const files = new Map([
    [generationPath, "generation_1"],
    [configPath, "{}"],
    [keyPath, "test-key"],
  ]);
  const sandbox = {
    commands: {
      run: vi.fn(async (command: string) => {
        if (command.startsWith("rm -rf ")) {
          for (const entry of [...files.keys()]) {
            if (
              command.split(" ").some((argument) => entry.startsWith(argument.replaceAll("'", "")))
            )
              files.delete(entry);
          }
        }
        if (command.startsWith("infisical --version"))
          return { exitCode: 0, stdout: `infisical version ${INFISICAL_CLI_VERSION}`, stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            sessions: [
              {
                principalType: "user",
                status: "authenticated",
                domain: "https://eu.infisical.com",
              },
            ],
          }),
          stderr: "",
        };
      }),
    },
    files: {
      read: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error("missing test file");
        return value;
      }),
      write: vi.fn(
        async (pathOrFiles: string | Array<{ path: string; data: string }>, data?: string) => {
          if (Array.isArray(pathOrFiles))
            for (const file of pathOrFiles) files.set(file.path, file.data);
          else files.set(pathOrFiles, data!);
        },
      ),
    },
  };
  const input = { sandbox: sandbox as never, workspaceId: "workspace_1", userWorkosId: "alice" };
  mocks.registrations.mockResolvedValueOnce([]).mockResolvedValue([{ id: "personal_infisical" }]);
  const metadata = {
    status: "connected",
    credentialGeneration: "generation_1",
    host: "https://eu.infisical.com",
    expiresAt: null,
    lastValidatedAt: new Date(),
  };
  mocks.metadata.mockResolvedValue(metadata);
  mocks.connection.mockResolvedValue({
    ...metadata,
    authBundle: {
      redactionValues: [],
      files: [configPath, keyPath].map((path) => ({
        path: path.replace("/home/user/", ""),
        mode: 0o600,
        contentsBase64: Buffer.from(path === configPath ? "{}" : "test-key").toString("base64"),
      })),
    },
  });

  expect((await reconcileInfisicalSandboxAuth(input)).available).toBe(false);
  expect(files.has(configPath)).toBe(false);
  expect((await reconcileInfisicalSandboxAuth(input)).available).toBe(true);
  expect(files.get(configPath)).toBe("{}");
  expect(files.get(generationPath)).toBe("generation_1");
  expect(mocks.connection).toHaveBeenCalledWith({
    db: {},
    workspaceId: "workspace_1",
    userId: "alice",
  });
});
