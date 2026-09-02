"use client";

import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { buttonVariants } from "@opencompany/ui/components/button";
import { CheckCircle2, ExternalLink, FolderGit2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchGitHubRepositoryAccess,
  type GitHubRepositoryAccess,
  githubInstallStartHref,
} from "@/lib/github-repository-access";

type AccessState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: GitHubRepositoryAccess; error: null }
  | { status: "error"; data: null; error: string };

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
          <AlertDescription>{access.state.error}</AlertDescription>
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
        {approval.status === "waiting" ? (
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
  const approval = useGitHubAccessApproval(access.state.data, access.refresh);
  const target = access.state.data?.target;
  const returnTo =
    typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;

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
  return (
    <Alert variant="warning" className="mt-2 max-w-[92%]" data-testid="github-install-gap">
      <FolderGit2 />
      <AlertTitle>
        {approval.status === "waiting"
          ? `Pending admin approval for ${owner}`
          : target.state === "missing_installation"
            ? `GitHub App is not installed on ${owner}`
            : target.state === "suspended"
              ? `GitHub App access is suspended for ${owner}`
              : `GitHub App cannot access ${repository}`}
      </AlertTitle>
      <AlertDescription>
        {approval.status === "waiting"
          ? "GitHub emails an organization owner when approval is required. We will keep checking for access."
          : `Your GitHub account can reach ${repository}, but the App installation cannot. Add or request access on GitHub.`}
      </AlertDescription>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={githubInstallStartHref(owner, returnTo)}
          target="_blank"
          rel="noreferrer"
          onClick={approval.begin}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Add access <ExternalLink className="size-3.5" />
        </a>
        {approval.status === "waiting" ? (
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

  const refresh = useCallback(
    async (forceRefresh = false) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setRefreshing(true);
      try {
        const data = await fetchGitHubRepositoryAccess({
          ...(owner ? { owner } : {}),
          ...(repo ? { repo } : {}),
          ...(forceRefresh ? { forceRefresh: true } : {}),
          signal: controller.signal,
        });
        setState({ status: "ready", data, error: null });
        return data;
      } catch (cause) {
        if (controller.signal.aborted) return null;
        setState({
          status: "error",
          data: null,
          error: cause instanceof Error ? cause.message : "GitHub access could not be checked.",
        });
        return null;
      } finally {
        if (requestRef.current === controller) setRefreshing(false);
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
        setState({
          status: "error",
          data: null,
          error: cause instanceof Error ? cause.message : "GitHub access could not be checked.",
        });
      });
    return () => controller.abort();
  }, [owner, repo]);

  return { state, refresh, refreshing };
}

function useGitHubAccessApproval(
  data: GitHubRepositoryAccess | null,
  refresh: (forceRefresh?: boolean) => Promise<GitHubRepositoryAccess | null>,
) {
  const [status, setStatus] = useState<"idle" | "waiting" | "approved">("idle");
  const baselineRef = useRef<string | null>(null);
  const signature = data ? accessSignature(data) : null;

  useEffect(() => {
    if (status !== "waiting" || !signature) return;
    if (baselineRef.current === null) {
      baselineRef.current = signature;
      return;
    }
    if (signature !== baselineRef.current || data?.target?.state === "available") {
      setStatus("approved");
    }
  }, [data?.target?.state, signature, status]);

  useEffect(() => {
    if (status !== "waiting") return;
    const interval = window.setInterval(() => void refresh(true), 10_000);
    const onFocus = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, status]);

  return {
    status,
    begin: () => {
      baselineRef.current = signature;
      setStatus("waiting");
    },
    recheck: () => refresh(true),
  };
}

function accessSignature(data: GitHubRepositoryAccess) {
  return data.installations
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

function permissionLabel(value: string) {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}
