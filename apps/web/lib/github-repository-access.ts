import {
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type GitHubInstallationAccessDto,
  type GitHubRepositoryAccessDto,
  GitHubRepositoryAccessSchema,
  type GitHubRepositoryAccessTargetDto,
} from "@opencompany/protocol";
import { CODEX_COMMAND_TOOL_NAME, USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";

export type GitHubRepositoryAccess = GitHubRepositoryAccessDto;
export type GitHubInstallationAccess = GitHubInstallationAccessDto;
export type GitHubRepositoryAccessTarget = GitHubRepositoryAccessTargetDto;

export class GitHubRepositoryAccessRequestError extends Error {
  constructor(
    readonly code: ErrorEnvelope["error"]["code"],
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GitHubRepositoryAccessRequestError";
  }
}

const ACCESS_CACHE_TTL_MS = 5_000;

type SharedAccessRequest = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<GitHubRepositoryAccess>;
};

type AccessCacheEntry = {
  fetcher: typeof globalThis.fetch;
  data: GitHubRepositoryAccess | null;
  expiresAt: number;
  request: SharedAccessRequest | null;
};

const accessCache = new Map<string, AccessCacheEntry>();

type GitHubToolView = {
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  errorText?: string | null;
};

export async function fetchGitHubRepositoryAccess(input: {
  owner?: string;
  repo?: string;
  bypassCache?: boolean;
  signal?: AbortSignal;
}) {
  const owner = input.owner?.trim() || null;
  const repo = input.repo?.trim().replace(/\.git$/iu, "") || null;
  if (repo && !owner) throw new Error("A GitHub repository check requires an owner.");

  const fetcher = globalThis.fetch;
  const cacheKey = owner?.toLowerCase() ?? "*";
  let entry = accessCache.get(cacheKey);
  if (entry && entry.fetcher !== fetcher) {
    entry.request?.controller.abort();
    accessCache.delete(cacheKey);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      fetcher,
      data: null,
      expiresAt: 0,
      request: null,
    };
    accessCache.set(cacheKey, entry);
  }

  if (!input.bypassCache && entry.data && entry.expiresAt > Date.now()) {
    input.signal?.throwIfAborted();
    return withRepositoryTarget(entry.data, owner, repo);
  }

  let request = entry.request;
  if (!request) {
    const controller = new AbortController();
    const promise = requestGitHubRepositoryAccess({
      owner,
      fetcher,
      signal: controller.signal,
    });
    request = {
      controller,
      consumers: 0,
      settled: false,
      promise,
    };
    entry.request = request;
    const currentRequest = request;
    void promise.then(
      (data) => {
        currentRequest.settled = true;
        entry.data = data;
        entry.expiresAt = Date.now() + ACCESS_CACHE_TTL_MS;
        if (entry.request === currentRequest) entry.request = null;
      },
      () => {
        currentRequest.settled = true;
        if (entry.request === currentRequest) entry.request = null;
      },
    );
  }

  const data = await consumeSharedRequest(request, input.signal);
  return withRepositoryTarget(data, owner, repo);
}

async function requestGitHubRepositoryAccess(input: {
  owner: string | null;
  fetcher: typeof globalThis.fetch;
  signal: AbortSignal;
}) {
  const search = new URLSearchParams();
  if (input.owner) search.set("owner", input.owner);
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const response = await input.fetcher(`/api/integrations/github-user/installations${query}`, {
    method: "GET",
    signal: input.signal,
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(value);
    if (envelope.success) {
      throw new GitHubRepositoryAccessRequestError(
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.retryable,
      );
    }
    throw new GitHubRepositoryAccessRequestError(
      "unavailable",
      "GitHub repository access could not be checked.",
      true,
    );
  }
  return GitHubRepositoryAccessSchema.parse(value);
}

export function githubInstallGapCandidate(tool: GitHubToolView) {
  if (tool.name === USE_ACTION_TOOL_NAME) {
    if (!isRecord(tool.input) || typeof tool.input.action !== "string") return null;
    if (!tool.input.action.startsWith("plugin:github:github.")) return null;
    if (!isRecord(tool.input.params)) return null;
    const output = isRecord(tool.output) ? tool.output : null;
    const failed = output?.ok === false || tool.status === "failed";
    if (!failed) return null;
    return repositoryTarget(tool.input.params.owner, tool.input.params.repo);
  }

  if (tool.name !== CODEX_COMMAND_TOOL_NAME) return null;
  const input = isRecord(tool.input) ? tool.input : null;
  const output = isRecord(tool.output) ? tool.output : null;
  if (tool.status !== "failed" && output?.status !== "failed") return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const failure = [
    typeof output?.outputPreview === "string" ? output.outputPreview : "",
    tool.errorText ?? "",
  ].join("\n");
  if (!isGitHubAccessFailure(failure)) return null;
  return repositoryFromCommand(`${command}\n${failure}`);
}

export function githubInstallStartHref(owner?: string, returnTo = "/") {
  const search = new URLSearchParams({ returnTo });
  if (owner) search.set("owner", owner);
  return `/api/integrations/github-user/start?${search.toString()}`;
}

function consumeSharedRequest(request: SharedAccessRequest, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  request.consumers += 1;
  return new Promise<GitHubRepositoryAccess>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      request.consumers -= 1;
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      reject(abortReason(signal));
      if (request.consumers === 0 && !request.settled) request.controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void request.promise.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

function withRepositoryTarget(
  data: GitHubRepositoryAccess,
  owner: string | null,
  repo: string | null,
): GitHubRepositoryAccess {
  if (!owner) return data;
  const installation = data.installations.find(
    (candidate) => candidate.account.login.toLowerCase() === owner.toLowerCase(),
  );
  const state = !installation
    ? "missing_installation"
    : installation.suspendedAt
      ? "suspended"
      : repo &&
          !installation.repositories.some(
            (repository) => repository.name.toLowerCase() === repo.toLowerCase(),
          )
        ? "missing_repository"
        : "available";
  return { ...data, target: { owner, repo, state } };
}

function abortReason(signal?: AbortSignal) {
  return signal?.reason ?? new DOMException("The request was aborted.", "AbortError");
}

function repositoryTarget(owner: unknown, repo: unknown) {
  return typeof owner === "string" && typeof repo === "string" && owner.trim() && repo.trim()
    ? { owner: owner.trim(), repo: repo.trim().replace(/\.git$/iu, "") }
    : null;
}

function isGitHubAccessFailure(value: string) {
  if (/GH013|push protection|repository rules?|permission denied/iu.test(value)) return false;
  return /resource not accessible by integration/iu.test(value);
}

function repositoryFromCommand(value: string) {
  const match =
    value.match(/(?:--repo(?:=|\s+)|GH_REPO=)["']?([a-z0-9-]{1,39})\/([^\s"']+)/iu) ??
    value.match(/github\.com[/:]([a-z0-9-]{1,39})\/([^\s"'/:]+)/iu);
  return match ? repositoryTarget(match[1], match[2]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
