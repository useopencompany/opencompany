import type { ExecutionBackendCompatibility } from "@opencompany/db/product-schema";

export const OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY = "opencompany_managed";
export const OPENCOMPANY_SANDBOX_NAMESPACE_METADATA_KEY = "opencompany_sandbox_namespace";
export const OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY = "opencompany_owner_kind";
export const OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY = "opencompany_owner_id";
export const OPENCOMPANY_EXECUTION_BACKEND_METADATA_KEY = "opencompany_execution_backend";
export const OPENCOMPANY_EXECUTION_BACKEND_VERSION_METADATA_KEY =
  "opencompany_execution_backend_version";
// The E2B project is shared with other apps. This tag lets people filter our sandboxes in the E2B
// console and API. Runner code never queries by it: the reconciler scopes by the managed flag and
// namespace above.
export const OPENCOMPANY_APP_SANDBOX_METADATA = { app: "opencompany" } as const;

export type ManagedSandboxOwnerKind =
  | "codex_chat_session"
  | "codex_device_auth_flow"
  | "infisical_auth_flow"
  | "doppler_auth_flow";

type ManagedSandboxMetadataInput = {
  namespace: string;
  ownerId: string;
  metadata?: Record<string, string>;
} & (
  | {
      ownerKind: "codex_chat_session";
      execution: ExecutionBackendCompatibility;
    }
  | {
      ownerKind: Exclude<ManagedSandboxOwnerKind, "codex_chat_session">;
      execution?: never;
    }
);

export function managedSandboxMetadata(input: ManagedSandboxMetadataInput) {
  const execution = input.ownerKind === "codex_chat_session" ? input.execution : null;
  return {
    ...input.metadata,
    ...OPENCOMPANY_APP_SANDBOX_METADATA,
    [OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY]: "true",
    [OPENCOMPANY_SANDBOX_NAMESPACE_METADATA_KEY]: input.namespace,
    [OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY]: input.ownerKind,
    [OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY]: input.ownerId,
    ...(execution
      ? {
          [OPENCOMPANY_EXECUTION_BACKEND_METADATA_KEY]: execution.backend,
          [OPENCOMPANY_EXECUTION_BACKEND_VERSION_METADATA_KEY]: String(execution.version),
        }
      : {}),
  };
}
