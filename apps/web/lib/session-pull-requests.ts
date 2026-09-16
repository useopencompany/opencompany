"use client";

import { isPullRequestState, type PullRequestState } from "@opencompany/core/pull-requests";
import { createApiClient, type SessionPullRequestDto } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

/** A linked pull request as a sidebar row renders it. */
export type SessionPullRequest = {
  conversationId: string;
  repository: string;
  number: number;
  url: string;
  state: PullRequestState;
};

/**
 * The pull requests the signed-in user's coding sessions opened.
 *
 * The API refreshes each PR's state against GitHub behind its own TTL, so the client can ask
 * freely; this is a plain read, not a request to go and poll GitHub.
 *
 * A link whose state the client does not recognise is dropped rather than rendered: the generated
 * protocol types widen enums to `string`, so this is the only place the narrowing can happen, and
 * a badge whose colour we cannot choose is worse than no badge.
 */
export async function listSessionPullRequests(
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<SessionPullRequest[]> {
  const baseUrl = headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  const response = await client.v1["session-pull-requests"].$get();
  if (!response.ok) throw new Error("Could not load pull request status.");

  const { data } = (await response.json()) as { data: SessionPullRequestDto[] };
  return data.flatMap((link) =>
    isPullRequestState(link.state) ? [{ ...link, state: link.state }] : [],
  );
}
