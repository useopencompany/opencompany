import { describe, expect, it } from "vitest";
import { managedSandboxMetadata } from "./sandbox-metadata";

describe("managedSandboxMetadata", () => {
  it("includes the reconciler namespace", () => {
    expect(
      managedSandboxMetadata({
        namespace: "production",
        ownerKind: "codex_chat_session",
        ownerId: "session_1",
        execution: { backend: "runner_attached", version: 1 },
      }),
    ).toEqual({
      app: "opencompany",
      opencompany_managed: "true",
      opencompany_sandbox_namespace: "production",
      opencompany_owner_kind: "codex_chat_session",
      opencompany_owner_id: "session_1",
      opencompany_execution_backend: "runner_attached",
      opencompany_execution_backend_version: "1",
    });
  });

  // The E2B project is shared with other apps, so callers must not be able to relabel ours.
  it("keeps the app tag when caller metadata tries to override it", () => {
    expect(
      managedSandboxMetadata({
        namespace: "production",
        ownerKind: "codex_device_auth_flow",
        ownerId: "flow_1",
        metadata: { app: "another-app", user_id: "user_1" },
      }),
    ).toMatchObject({ app: "opencompany", user_id: "user_1" });
  });
});
