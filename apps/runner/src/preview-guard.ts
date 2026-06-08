import { resolveRunnerDatabaseUrl } from "./db";

// Boot-time preview-identity safety gate (issue #351 §6, research correction #2).
//
// The runner is a lease-based Postgres poller: pointed at the production database it
// would claim and execute real users' sessions. A preview runner must therefore NEVER
// poll the prod DB. We enforce this with an explicit, injected preview identity rather
// than by inspecting the connection string — Neon hostnames encode the *compute endpoint
// id* (`ep-...`), not the branch name, so substring matching the host is impossible.
//
// Contract:
//   - A preview runner is started with PREVIEW_ENV=true + NEON_BRANCH_ID + PREVIEW_PR_NUMBER.
//     It must verify that the DB it will actually poll belongs to NEON_BRANCH_ID.
//   - A prod runner carries none of these. It asserts they are absent so a stray preview
//     env can't "promote" itself onto prod (symmetric guard).
// Either way, a misconfiguration fails closed (refuses to boot) instead of polling the
// wrong database.

export class PreviewIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewIdentityError";
  }
}

export type PreviewIdentity = {
  previewEnv: boolean;
  neonBranchId: string | undefined;
  prNumber: string | undefined;
};

export function readPreviewIdentity(env: NodeJS.ProcessEnv = process.env): PreviewIdentity {
  return {
    previewEnv: isTrue(env.PREVIEW_ENV),
    neonBranchId: trimmed(env.NEON_BRANCH_ID),
    prNumber: trimmed(env.PREVIEW_PR_NUMBER),
  };
}

// Extracts the Neon compute endpoint id (e.g. "ep-cool-name-123456") from a connection
// string. Neon hosts are "<endpoint-id>[-pooler].<region>.<...>.neon.tech".
export function neonEndpointIdFromUrl(databaseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return undefined;
  }
  const firstLabel = host.split(".")[0];
  if (!firstLabel || !firstLabel.startsWith("ep-")) return undefined;
  return firstLabel.replace(/-pooler$/, "");
}

export type AssertPreviewIdentityOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Overrides the resolved runner DB URL (tests). Defaults to the real connection URL. */
  databaseUrl?: string;
};

export async function assertPreviewIdentity(
  options: AssertPreviewIdentityOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const identity = readPreviewIdentity(env);

  // Prod runner: must not carry partial preview identity. Fail closed on ambiguity so a
  // stray PREVIEW_ENV/NEON_BRANCH_ID can't quietly reinterpret a prod runner as preview.
  if (!identity.previewEnv) {
    if (identity.neonBranchId || identity.prNumber) {
      throw new PreviewIdentityError(
        "PREVIEW_ENV is not set but NEON_BRANCH_ID/PREVIEW_PR_NUMBER are present. Refusing to boot: ambiguous preview identity on a non-preview runner.",
      );
    }
    return;
  }

  // Preview runner: require the full identity trio.
  if (!identity.neonBranchId) {
    throw new PreviewIdentityError("PREVIEW_ENV=true requires NEON_BRANCH_ID. Refusing to boot.");
  }
  if (!identity.prNumber) {
    throw new PreviewIdentityError(
      "PREVIEW_ENV=true requires PREVIEW_PR_NUMBER. Refusing to boot.",
    );
  }

  // Explicit, loud escape hatch — only for cases where the DB is provably non-prod and
  // the Neon API is unreachable. Documented as a last resort, never the default.
  if (isTrue(env.PREVIEW_ALLOW_UNVERIFIED_ENDPOINT)) {
    return;
  }

  // Verify the DB we will actually poll belongs to the declared preview branch. This is
  // the load-bearing check that makes "preview runner on the prod DB" structurally
  // impossible.
  const databaseUrl = options.databaseUrl ?? resolveRunnerDatabaseUrl();
  const endpointId = neonEndpointIdFromUrl(databaseUrl);
  if (!endpointId) {
    throw new PreviewIdentityError(
      `Could not extract a Neon endpoint id from the runner database URL, so it cannot be verified against NEON_BRANCH_ID=${identity.neonBranchId}. Refusing to boot. (Set PREVIEW_ALLOW_UNVERIFIED_ENDPOINT=true only if the DB is provably non-prod.)`,
    );
  }

  const apiKey = trimmed(env.NEON_API_KEY);
  const projectId = trimmed(env.NEON_PROJECT_ID);
  if (!apiKey || !projectId) {
    throw new PreviewIdentityError(
      "PREVIEW_ENV=true requires NEON_API_KEY and NEON_PROJECT_ID to verify the DB endpoint against NEON_BRANCH_ID. Refusing to boot. (Set PREVIEW_ALLOW_UNVERIFIED_ENDPOINT=true only if the DB is provably non-prod.)",
    );
  }

  const branchId = await fetchEndpointBranchId({
    fetchImpl: options.fetchImpl ?? fetch,
    apiKey,
    projectId,
    endpointId,
    apiBase: neonApiBase(env),
  });

  if (branchId !== identity.neonBranchId) {
    throw new PreviewIdentityError(
      `Preview runner DB endpoint ${endpointId} belongs to branch ${branchId ?? "<unknown>"}, not the declared NEON_BRANCH_ID=${identity.neonBranchId}. Refusing to boot to avoid polling the wrong database.`,
    );
  }
}

async function fetchEndpointBranchId(args: {
  fetchImpl: typeof fetch;
  apiKey: string;
  projectId: string;
  endpointId: string;
  apiBase: string;
}): Promise<string | undefined> {
  const url = `${args.apiBase}/projects/${encodeURIComponent(args.projectId)}/endpoints/${encodeURIComponent(args.endpointId)}`;
  let response: Response;
  try {
    response = await args.fetchImpl(url, {
      headers: { Authorization: `Bearer ${args.apiKey}`, Accept: "application/json" },
    });
  } catch (cause) {
    throw new PreviewIdentityError(
      `Failed to reach the Neon API to verify endpoint ${args.endpointId}: ${String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new PreviewIdentityError(
      `Neon API returned ${response.status} while verifying endpoint ${args.endpointId}.`,
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    | { endpoint?: { branch_id?: string } }
    | undefined;
  return body?.endpoint?.branch_id;
}

function isTrue(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function neonApiBase(env: NodeJS.ProcessEnv): string {
  return env.NEON_API_URL?.trim() || "https://console.neon.tech/api/v2";
}
