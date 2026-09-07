import "@testing-library/jest-dom/vitest";
import { PROTOCOL_VERSION } from "@opencompany/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubInstallGapCard, GitHubRepositoryAccessSection } from "./GitHubRepositoryAccess";

const POLL_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

describe("GitHub repository access polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses bounded, backoff GET polling and re-checks without rotating OAuth tokens", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json(accessResponse()));
    vi.stubGlobal("fetch", fetchMock);

    render(<GitHubRepositoryAccessSection />);
    await flushPromises();
    fireEvent.click(screen.getByRole("link", { name: "Add organization or account" }));

    for (const delay of POLL_DELAYS_MS) {
      act(() => vi.advanceTimersByTime(delay));
      await flushPromises();
    }

    expect(screen.getByTestId("github-installation-still-waiting")).toHaveTextContent(
      "Still waiting for admin approval",
    );
    const callsAfterPolling = fetchMock.mock.calls.length;
    act(() => vi.advanceTimersByTime(5 * 60_000));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterPolling);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flushPromises();

    expect(fetchMock.mock.calls.at(-2)?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("GET");
  });

  it("does not approve a target when only an unrelated organization changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(accessResponse({ owner: "opencompany" })))
      .mockResolvedValueOnce(
        Response.json(
          accessResponse({
            owner: "opencompany",
            extraInstallation: installation("unrelated", ["new-repo"]),
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<GitHubInstallGapCard owner="opencompany" repo="private-repo" />);
    expect(await screen.findByTestId("github-install-gap")).toHaveTextContent(
      "GitHub App cannot access opencompany/private-repo",
    );
    fireEvent.click(screen.getByRole("link", { name: "Add access" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flushPromises();

    expect(screen.queryByTestId("github-installation-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("github-install-gap")).toHaveTextContent(
      "Pending admin approval for opencompany",
    );
  });

  it("keeps a suspended installation distinct from pending admin approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          accessResponse({ owner: "opencompany", suspendedAt: "2026-09-02T12:00:00Z" }),
        ),
      ),
    );

    render(<GitHubInstallGapCard owner="opencompany" repo="private-repo" />);

    expect(await screen.findByTestId("github-install-gap")).toHaveTextContent(
      "GitHub App access is suspended for opencompany",
    );
    fireEvent.click(screen.getByRole("link", { name: "Review on GitHub" }));
    expect(screen.queryByText(/Pending admin approval/u)).not.toBeInTheDocument();
  });

  it("aborts the shared access request when its last card unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
              once: true,
            });
          }),
      ),
    );

    const view = render(<GitHubInstallGapCard owner="opencompany" repo="private-repo" />);
    await flushPromises();
    view.unmount();
    await flushPromises();

    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ["authentication_required", 409, "github-reconnect", "Reconnect GitHub"],
    ["rate_limited", 429, "github-rate-limited", "GitHub access check is rate-limited"],
  ] as const)("renders the %s recovery state", async (code, status, testId, title) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code,
              message:
                code === "authentication_required"
                  ? "Reconnect GitHub in Settings to inspect repository access."
                  : "Try again later.",
              requestId: "request_access",
              retryable: code === "rate_limited",
            },
            meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
          },
          { status },
        ),
      ),
    );

    render(<GitHubInstallGapCard owner="opencompany" repo="private-repo" />);

    expect(await screen.findByTestId(testId)).toHaveTextContent(title);
  });
});

function accessResponse(
  input: {
    owner?: string;
    suspendedAt?: string;
    extraInstallation?: ReturnType<typeof installation>;
  } = {},
) {
  const owner = input.owner;
  return {
    checkedAt: "2026-09-02T12:00:00.000Z",
    target: owner
      ? { owner, repo: null, state: input.suspendedAt ? "suspended" : "available" }
      : null,
    installations: owner
      ? [
          {
            ...installation(owner, []),
            suspendedAt: input.suspendedAt ?? null,
          },
          ...(input.extraInstallation ? [input.extraInstallation] : []),
        ]
      : [],
  };
}

function installation(owner: string, repositories: string[]) {
  return {
    id: `installation-${owner}`,
    account: {
      id: `account-${owner}`,
      login: owner,
      type: "Organization",
      avatarUrl: null,
      htmlUrl: `https://github.com/${owner}`,
    },
    repositorySelection: "selected",
    permissions: { metadata: "read" },
    pendingPermissions: [],
    suspendedAt: null,
    repositories: repositories.map((repo) => ({
      id: `repository-${owner}-${repo}`,
      name: repo,
      fullName: `${owner}/${repo}`,
      private: true,
      htmlUrl: `https://github.com/${owner}/${repo}`,
    })),
  } as const;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
