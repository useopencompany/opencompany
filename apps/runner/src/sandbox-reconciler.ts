import { stringifyPostgresJson } from "@opencompany/db/postgres-json";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { Sandbox, type SandboxInfo } from "e2b";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import {
  killSandbox,
  type ManagedSandboxOwnerKind,
  OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY,
  OPENCOMPANY_SANDBOX_NAMESPACE_METADATA_KEY,
  OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY,
  OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY,
} from "./sandbox";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "sandbox-reconciler" });
const SANDBOX_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const SANDBOX_RECONCILE_GRACE_MS = 10 * 60_000;
const SANDBOX_LIST_REQUEST_TIMEOUT_MS = 30_000;

export type ManagedSandboxCandidate = Pick<SandboxInfo, "sandboxId" | "metadata" | "startedAt">;
type OwnedSandboxCandidate = ManagedSandboxCandidate & {
  ownerKind: ManagedSandboxOwnerKind;
  ownerId: string;
};

export async function listManagedSandboxes(signal: AbortSignal, namespace: string) {
  const paginator = Sandbox.list({
    query: {
      metadata: {
        [OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY]: "true",
        [OPENCOMPANY_SANDBOX_NAMESPACE_METADATA_KEY]: namespace,
      },
    },
    limit: 100,
    requestTimeoutMs: SANDBOX_LIST_REQUEST_TIMEOUT_MS,
  });
  const sandboxes: ManagedSandboxCandidate[] = [];
  while (paginator.hasNext) {
    signal.throwIfAborted();
    sandboxes.push(
      ...(await paginator.nextItems({
        signal,
        requestTimeoutMs: SANDBOX_LIST_REQUEST_TIMEOUT_MS,
      })),
    );
  }
  return sandboxes;
}

export async function findLiveOwnedSandboxIds(
  candidates: OwnedSandboxCandidate[],
  now = new Date(),
) {
  if (candidates.length === 0) return new Set<string>();
  const payload = stringifyPostgresJson(
    candidates.map((candidate) => ({
      sandboxId: candidate.sandboxId,
      ownerKind: candidate.ownerKind,
      ownerId: candidate.ownerId,
    })),
  );
  const result = await getDb().execute(sql`
    WITH candidate AS (
      SELECT *
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS item("sandboxId" text, "ownerKind" text, "ownerId" text)
    )
    SELECT candidate."sandboxId"
    FROM candidate
    WHERE (
      candidate."ownerKind" = 'codex_chat_session'
      AND EXISTS (
        SELECT 1
        FROM goat.codex_chat_sessions AS session
        WHERE session.id = candidate."ownerId"
          AND session.sandbox_id = candidate."sandboxId"
          AND session.status <> 'closed'
      )
    ) OR (
      candidate."ownerKind" = 'codex_device_auth_flow'
      AND EXISTS (
        SELECT 1
        FROM goat.codex_device_auth_flows AS flow
        WHERE flow.id = candidate."ownerId"
          AND flow.sandbox_id = candidate."sandboxId"
          AND flow.status IN ('pending', 'code_ready')
          AND flow.expires_at > ${now}
      )
    ) OR (
      candidate."ownerKind" = 'infisical_auth_flow'
      AND EXISTS (
        SELECT 1
        FROM goat.infisical_auth_flows AS flow
        WHERE flow.id = candidate."ownerId"
          AND flow.sandbox_id = candidate."sandboxId"
          AND flow.status IN ('pending', 'link_ready')
          AND flow.expires_at > ${now}
      )
    )
  `);
  return new Set(rowsFromExecute<{ sandboxId: string }>(result).map((row) => row.sandboxId));
}

export async function reconcileManagedSandboxes(input: {
  signal: AbortSignal;
  namespace: string;
  now?: Date;
  graceMs?: number;
  list?: typeof listManagedSandboxes;
  findLive?: typeof findLiveOwnedSandboxIds;
  kill?: typeof killSandbox;
}) {
  const now = input.now ?? new Date();
  const graceCutoff = now.getTime() - (input.graceMs ?? SANDBOX_RECONCILE_GRACE_MS);
  const listed = await (input.list ?? listManagedSandboxes)(input.signal, input.namespace);
  const candidates = listed.flatMap((sandbox): OwnedSandboxCandidate[] => {
    if (sandbox.metadata[OPENCOMPANY_SANDBOX_NAMESPACE_METADATA_KEY] !== input.namespace) return [];
    const ownerKind = sandbox.metadata[OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY];
    const ownerId = sandbox.metadata[OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY];
    if (!isManagedSandboxOwnerKind(ownerKind) || !ownerId) return [];
    if (new Date(sandbox.startedAt).getTime() > graceCutoff) return [];
    return [{ ...sandbox, ownerKind, ownerId }];
  });
  const live = await (input.findLive ?? findLiveOwnedSandboxIds)(candidates, now);
  let killed = 0;
  for (const sandbox of candidates) {
    if (live.has(sandbox.sandboxId)) continue;
    input.signal.throwIfAborted();
    const removed = await (input.kill ?? killSandbox)(sandbox.sandboxId);
    if (!removed) continue;
    killed += 1;
    logger.warn("Killed an orphaned managed sandbox", {
      event: "opencompany.runner_orphaned_sandbox_killed",
      sandbox_id: sandbox.sandboxId,
      owner_kind: sandbox.ownerKind,
      owner_id: sandbox.ownerId,
    });
  }
  return { listed: listed.length, checked: candidates.length, killed };
}

export function startSandboxReconciler(options: { namespace: string; pollIntervalMs?: number }) {
  return createPollingWorker({
    pollIntervalMs: Math.max(1_000, options.pollIntervalMs ?? SANDBOX_RECONCILE_INTERVAL_MS),
    poll: async ({ signal }) => {
      const result = await reconcileManagedSandboxes({ signal, namespace: options.namespace });
      if (result.killed > 0) {
        logger.info("Reconciled managed sandboxes", {
          event: "opencompany.runner_sandbox_reconcile_finished",
          listed_count: result.listed,
          checked_count: result.checked,
          killed_count: result.killed,
        });
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.runner_sandbox_reconcile_failed" });
      logger.error("Managed sandbox reconciliation failed", {
        event: "opencompany.runner_sandbox_reconcile_failed",
        error,
      });
    },
  });
}

function isManagedSandboxOwnerKind(value: string | undefined): value is ManagedSandboxOwnerKind {
  return (
    value === "codex_chat_session" ||
    value === "codex_device_auth_flow" ||
    value === "infisical_auth_flow"
  );
}
