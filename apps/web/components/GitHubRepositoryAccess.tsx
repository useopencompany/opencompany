"use client";

import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { buttonVariants } from "@opencompany/ui/components/button";
import { CheckCircle2, ExternalLink, FolderGit2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchGitHubRepositoryAccess,
  type GitHubRepositoryAccess,
  GitHubRepositoryAccessRequestError,
  githubInstallStartHref,
} from "@/lib/github-repository-access";

type AccessState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: GitHubRepositoryAccess; error: null }
  | {
      status: "error";
      data: null;
      error: { message: string; code: GitHubRepositoryAccessRequestError["code"] | null };
    };

type RefreshAccess = (options?: {
  forceTokenRefresh?: boolean;
}) => Promise<GitHubRepositoryAccess | null>;

const APPROVAL_POLL_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export function GitHubRepositoryAccessSection() {
  const access = useGitHubRepositoryAccess();
  const approval = useGitHubAccessApproval(access.state.data, access.refresh);
  const permissionUpdates =
    access.state.data?.installations.filter(
      (installation) => installation.pendingPermissions.length > 0,
    ) ?? [];

  return (
    <section aria-labelledby="github-repository-access-heading" className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted">
          <FolderGit2 className="size-4" />
        </span>
        <div>
          <h2 id="github-repository-access-heading" className="text-[13px] font-semibold text-ink">
            Repository access
          </h2>
          <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">
            Accounts and repositories where both you and the GitHub App have access.
          </p>
        </div>
      </div>

      {access.state.status === "loading" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-[12px] text-ink-subtle">
          <Loader2 className="size-3.5 animate-spin" /> Checking GitHub access…
        </div>
      ) : access.state.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Repository access unavailable</AlertTitle>
          <AlertDescription>{access.state.error.message}</AlertDescription>
        </Alert>
      ) : access.state.data.installations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[12px] leading-5 text-ink-subtle">
          The GitHub App is not installed on an account you can access yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {access.state.data.installations.map((installation) => (
            <details
              key={installation.id}
              className="group rounded-lg border border-border bg-surface"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                  {installation.account.login}
                </span>
                <Badge variant={installation.suspendedAt ? "destructive" : "outline"}>
                  {installation.suspendedAt
                    ? "Suspended"
                    : `${installation.repositories.length} ${installation.repositories.length === 1 ? "repository" : "repositories"}`}
                </Badge>
              </summary>
              <div className="border-t border-border px-3 py-2.5">
                {installation.repositories.length === 0 ? (
                  <p className="text-[11.5px] text-ink-subtle">No reachable repositories.</p>
                ) : (
                  <ul className="grid gap-1.5">
                    {installation.repositories.map((repository) => (
                      <li
                        key={repository.id}
                        className="flex min-w-0 items-center gap-2 text-[11.5px]"
                      >
                        <a
                          href={repository.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 truncate text-ink-muted hover:text-ink hover:underline"
                        >
                          {repository.fullName}
                        </a>
                        {repository.private ? <Badge variant="outline">Private</Badge> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          ))}
        </div>
      )}

      {permissionUpdates.length > 0 ? (
        <Alert variant="warning" data-testid="github-permissions-pending">
          <AlertTitle>New permissions pending approval</AlertTitle>
          <AlertDescription>
            {permissionUpdates
              .map(
                (installation) =>
                  `${installation.account.login}: ${installation.pendingPermissions.map(permissionLabel).join(", ")}`,
              )
              .join(" · ")}
            . Existing GitHub access keeps working while its owner approves the update on GitHub.
          </AlertDescription>
        </Alert>
      ) : null}

      {approval.status === "waiting" ? (
        <Alert variant="warning" data-testid="github-installation-pending">
          <AlertTitle>Pending admin approval</AlertTitle>
          <AlertDescription>
            If GitHub showed Request, an organization owner must approve it. This page will re-check
            automatically.
          </AlertDescription>
        </Alert>
      ) : approval.status === "timed_out" ? (
        <Alert variant="warning" data-testid="github-installation-still-waiting">
          <AlertTitle>Still waiting for admin approval</AlertTitle>
          <AlertDescription>
            GitHub has not granted the requested access yet. Check back later or re-check manually.
          </AlertDescription>
        </Alert>
      ) : approval.status === "approved" ? (
        <Alert data-testid="github-installation-approved">
          <CheckCircle2 />
          <AlertTitle>Repository access updated</AlertTitle>
          <AlertDescription>The new GitHub access is ready to use.</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={githubInstallStartHref(undefined, "/settings/plugins/github")}
          target="_blank"
          rel="noreferrer"
          onClick={approval.begin}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Add organization or account <ExternalLink className="size-3.5" />
        </a>
        {approval.status === "waiting" || approval.status === "timed_out" ? (
          <button
            type="button"
            onClick={() => void approval.recheck()}
            disabled={access.refreshing}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <RefreshCw className={`size-3.5 ${access.refreshing ? "animate-spin" : ""}`} />
            Re-check
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function GitHubInstallGapCard({ owner, repo }: { owner: string; repo: string }) {
  const access = useGitHubRepositoryAccess({ owner, repo });
  const approval = useGitHubAccessApproval(access.state.data, access.refresh, owner);
  const target = access.state.data?.target;
  const returnTo =
    typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;

  if (access.state.status === "error") {
    if (access.state.error.code === "authentication_required") {
      return (
        <Alert variant="warning" className="mt-2 max-w-[92%]" data-testid="github-reconnect">
          <FolderGit2 />
          <AlertTitle>Reconnect GitHub</AlertTitle>
          <AlertDescription>{access.state.error.message}</AlertDescription>
          <a
            href={githubInstallStartHref(owner, returnTo)}
            target="_blank"
            rel="noreferrer"
            className={`mt-2 ${buttonVariants({ variant: "outline", size: "sm" })}`}
          >
            Reconnect GitHub <ExternalLink className="size-3.5" />
          </a>
        </Alert>
      );
    }
    if (access.state.error.code === "rate_limited") {
      return (
        <Alert variant="warning" className="mt-2 max-w-[92%]" data-testid="github-rate-limited">
          <FolderGit2 />
          <AlertTitle>GitHub access check is rate-limited</AlertTitle>
          <AlertDescription>{access.state.error.message}</AlertDescription>
        </Alert>
      );
    }
    return null;
  }
  if (access.state.status !== "ready" || !target) return null;
  if (target.state === "available" && approval.status !== "approved") return null;

  if (target.state === "available") {
    return (
      <Alert className="mt-2 max-w-[92%]" data-testid="github-installation-approved">
        <CheckCircle2 />
        <AlertTitle>Access added for {owner}</AlertTitle>
        <AlertDescription>Retry the GitHub action to continue.</AlertDescription>
      </Alert>
    );
  }

  const repository = `${owner}/${repo}`;
  const requestPending = target.state !== "suspended" && approval.status === "waiting";
  const requestTimedOut = target.state !== "suspended" && approval.status === "timed_out";
  return (
    <Alert variant="warning" className="mt-2 max-w-[92%]" data-testid="github-install-gap">
      <FolderGit2 />
      <AlertTitle>
        {requestPending
          ? `Pending admin approval for ${owner}`
          : requestTimedOut
            ? `Still waiting for access to ${owner}`
            : target.state === "missing_installation"
              ? `GitHub App is not installed on ${owner}`
              : target.state === "suspended"
                ? `GitHub App access is suspended for ${owner}`
                : `GitHub App cannot access ${repository}`}
      </AlertTitle>
      <AlertDescription>
        {requestPending
          ? "GitHub emails an organization owner when approval is required. We will keep checking for access."
          : requestTimedOut
            ? "GitHub has not granted access yet. Check back later or re-check manually."
            : target.state === "suspended"
              ? `The App installation for ${owner} is suspended. An organization owner must restore it on GitHub.`
              : `Your GitHub account can reach ${repository}, but the App installation cannot. Add or request access on GitHub.`}
      </AlertDescription>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={githubInstallStartHref(owner, returnTo)}
          target="_blank"
          rel="noreferrer"
          onClick={target.state === "suspended" ? undefined : approval.begin}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {target.state === "suspended" ? "Review on GitHub" : "Add access"}{" "}
          <ExternalLink className="size-3.5" />
        </a>
        {requestPending || requestTimedOut ? (
          <button
            type="button"
            onClick={() => void approval.recheck()}
            disabled={access.refreshing}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <RefreshCw className={`size-3.5 ${access.refreshing ? "animate-spin" : ""}`} />
            Re-check
          </button>
        ) : null}
      </div>
    </Alert>
  );
}

function useGitHubRepositoryAccess(target: { owner?: string; repo?: string } = {}) {
  const owner = target.owner;
  const repo = target.repo;
  const [state, setState] = useState<AccessState>({ status: "loading", data: null, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(
    async (options: { forceTokenRefresh?: boolean } = {}) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      if (mountedRef.current) setRefreshing(true);
      try {
        const data = await fetchGitHubRepositoryAccess({
          ...(owner ? { owner } : {}),
          ...(repo ? { repo } : {}),
          ...(options.forceTokenRefresh ? { forceRefresh: true } : {}),
          bypassCache: true,
          signal: controller.signal,
        });
        if (mountedRef.current) setState({ status: "ready", data, error: null });
        return data;
      } catch (cause) {
        if (controller.signal.aborted) return null;
        if (mountedRef.current) setState(accessErrorState(cause));
        return null;
      } finally {
        if (mountedRef.current && requestRef.current === controller) setRefreshing(false);
      }
    },
    [owner, repo],
  );

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void fetchGitHubRepositoryAccess({
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, error: null });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (mountedRef.current) setState(accessErrorState(cause));
      });
    return () => {
      controller.abort();
      if (requestRef.current === controller) requestRef.current = null;
    };
  }, [owner, repo]);

  return { state, refresh, refreshing };
}

function useGitHubAccessApproval(
  data: GitHubRepositoryAccess | null,
  refresh: RefreshAccess,
  targetOwner?: string,
) {
  const [state, setState] = useState<
    | { status: "idle" | "approved" }
    | { status: "timed_out"; baseline: string | null }
    | { status: "waiting"; baseline: string | null; pollIndex: number }
  >({ status: "idle" });
  const forcedRefreshUsedRef = useRef(false);
  const signature = data ? accessSignature(data, targetOwner) : null;

  useEffect(() => {
    if (state.status !== "waiting") return;
    const pollIndex = state.pollIndex;
    const timer = window.setTimeout(() => {
      void refresh().then((latest) => {
        setState((current) => {
          if (current.status !== "waiting" || current.pollIndex !== pollIndex) return current;
          if (approvalGranted(latest, current.baseline, targetOwner)) {
            return { status: "approved" };
          }
          return pollIndex + 1 >= APPROVAL_POLL_DELAYS_MS.length
            ? { status: "timed_out", baseline: current.baseline }
            : { ...current, pollIndex: pollIndex + 1 };
        });
      });
    }, APPROVAL_POLL_DELAYS_MS[pollIndex]);
    return () => window.clearTimeout(timer);
  }, [refresh, state, targetOwner]);

  return {
    status: state.status,
    begin: () => {
      forcedRefreshUsedRef.current = false;
      setState({ status: "waiting", baseline: signature, pollIndex: 0 });
    },
    recheck: async () => {
      const forceTokenRefresh = !forcedRefreshUsedRef.current;
      forcedRefreshUsedRef.current = true;
      const latest = await refresh({ forceTokenRefresh });
      const baseline = "baseline" in state ? state.baseline : null;
      if (approvalGranted(latest, baseline, targetOwner)) {
        setState({ status: "approved" });
      }
      return latest;
    },
  };
}

function accessSignature(data: GitHubRepositoryAccess, targetOwner?: string) {
  const installations = targetOwner
    ? data.installations.filter(
        (installation) => installation.account.login.toLowerCase() === targetOwner.toLowerCase(),
      )
    : data.installations;
  return installations
    .map((installation) =>
      [
        installation.id,
        installation.suspendedAt ?? "",
        ...Object.entries(installation.permissions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([permission, level]) => `${permission}=${level}`),
        ...installation.repositories.map((repository) => repository.id).sort(),
      ].join(":"),
    )
    .sort()
    .join("|");
}

function approvalGranted(
  data: GitHubRepositoryAccess | null,
  baseline: string | null,
  targetOwner?: string,
) {
  if (!data || baseline === null) return false;
  if (targetOwner) {
    return (
      data.target?.owner.toLowerCase() === targetOwner.toLowerCase() &&
      data.target.state === "available"
    );
  }
  return accessSignature(data) !== baseline;
}

function accessErrorState(cause: unknown): AccessState {
  return {
    status: "error",
    data: null,
    error: {
      message: cause instanceof Error ? cause.message : "GitHub access could not be checked.",
      code: cause instanceof GitHubRepositoryAccessRequestError ? cause.code : null,
    },
  };
}

function permissionLabel(value: string) {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}
