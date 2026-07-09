import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerArgs,
  CODEX_APP_SERVER_ACCESS_MODE,
  CODEX_APP_SERVER_ENV_INHERIT,
} from "./codex-app-server";

describe("buildCodexAppServerArgs", () => {
  it("starts app-server without sandboxing and with inherited local environment", () => {
    expect(CODEX_APP_SERVER_ACCESS_MODE).toBe("dangerously-bypass-approvals-and-sandbox");
    expect(CODEX_APP_SERVER_ENV_INHERIT).toBe("all");
    expect(buildCodexAppServerArgs()).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "shell_environment_policy.inherit=all",
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });
});
