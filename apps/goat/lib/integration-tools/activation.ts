import type { IntegrationProviderId } from "./types";

// Deterministic, engine-side provider activation. This is pure routing logic —
// no LLM call, no I/O — run over the latest user turn before the tool set is
// built. Bump the version whenever rules change so recorded traces stay
// comparable across deploys.
export const INTEGRATION_ACTIVATION_VERSION = "goat.integration-activation.v1";

// Both current providers may legitimately activate together ("find the Linear
// issue and its GitHub PR"), so the cap only bites once more providers ship.
export const MAX_ACTIVATED_INTEGRATION_PROVIDERS = 2;

const ACTIVATION_SCORE_THRESHOLD = 2;

export type IntegrationActivationMatch = {
  provider: IntegrationProviderId;
  rule: string;
  matchedText: string;
  score: number;
};

export type IntegrationActivationResult = {
  version: typeof INTEGRATION_ACTIVATION_VERSION;
  activated: IntegrationProviderId[];
  matches: IntegrationActivationMatch[];
  capped: boolean;
  elapsedMs: number;
};

type ActivationRule = {
  rule: string;
  pattern: RegExp;
  score: number;
};

// Strong rules (score 3) activate a provider alone; medium rules (score 2) sit
// exactly at the threshold; weak rules (score 1) only activate in combination.
const PROVIDER_RULES: Record<IntegrationProviderId, readonly ActivationRule[]> = {
  linear: [
    { rule: "alias", pattern: /\blinear\b/i, score: 3 },
    // Issue keys like ENG-123 or OPS-4: uppercase team key + number.
    { rule: "issue-key", pattern: /\b[A-Z][A-Z0-9]{1,6}-\d{1,6}\b/, score: 3 },
    { rule: "term-ticket", pattern: /\btickets?\b/i, score: 2 },
    { rule: "term-sprint", pattern: /\bsprints?\b/i, score: 2 },
    { rule: "term-backlog", pattern: /\bbacklog\b/i, score: 2 },
    { rule: "term-triage", pattern: /\btriage\b/i, score: 1 },
    { rule: "term-cycle", pattern: /\bcycles?\b/i, score: 1 },
    { rule: "term-roadmap", pattern: /\broadmap\b/i, score: 1 },
  ],
  github: [
    { rule: "alias", pattern: /\bgit\s?hub\b/i, score: 3 },
    { rule: "pull-request", pattern: /\bpull[\s-]requests?\b/i, score: 3 },
    // owner/repo#123 cross-reference syntax.
    {
      rule: "repo-issue-ref",
      pattern: /\b[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+\b/,
      score: 3,
    },
    { rule: "term-pr", pattern: /\bprs?\b/i, score: 2 },
    { rule: "term-repo", pattern: /\brepo(?:s|sitor(?:y|ies))?\b/i, score: 2 },
    { rule: "issue-number-ref", pattern: /\bissue\s?#?\d+\b/i, score: 2 },
    { rule: "term-code-review", pattern: /\bcode review\b/i, score: 2 },
    { rule: "term-commit", pattern: /\bcommits?\b/i, score: 1 },
    { rule: "term-branch", pattern: /\bbranch(?:es)?\b/i, score: 1 },
    { rule: "term-merge", pattern: /\bmerged?\b/i, score: 1 },
  ],
};

// "issue(s)" is shared vocabulary: with both trackers connected it is worth one
// ambiguous point to each, but when only one candidate is connected the word is
// unambiguous in context and activates it on its own.
const SHARED_ISSUE_PATTERN = /\bissues?\b/i;
const SHARED_ISSUE_PROVIDERS: readonly IntegrationProviderId[] = ["linear", "github"];

// Short anaphoric follow-ups ("reply to that thread", "and the comments?")
// inherit the previous user turn's activation for exactly one turn.
const CONTINUITY_CUE_PATTERN =
  /\b(that|those|it|them|this|these|same|previous|again|more)\b|^(and|also|now|what about|how about)\b/i;
const CONTINUITY_MAX_MESSAGE_LENGTH = 120;

// Deterministic non-lexical fallback: token overlap between the message and a
// per-provider vocabulary distilled from the registry summaries. Runs only
// when lexical routing (including continuity) found nothing.
const SEMANTIC_VOCABULARY: Record<IntegrationProviderId, readonly string[]> = {
  linear: [
    "issue",
    "issues",
    "ticket",
    "tickets",
    "project",
    "projects",
    "team",
    "teams",
    "assignee",
    "assigned",
    "workflow",
    "status",
    "comment",
    "comments",
    "estimate",
    "milestone",
  ],
  github: [
    "issue",
    "issues",
    "pull",
    "request",
    "requests",
    "repository",
    "repositories",
    "review",
    "reviews",
    "commit",
    "commits",
    "branch",
    "branches",
    "merge",
    "merged",
    "diff",
    "codebase",
    "release",
  ],
};
const SEMANTIC_MIN_OVERLAP = 2;

export function activateIntegrationProviders(input: {
  message: string;
  previousUserMessage?: string | undefined;
  connectedProviders: readonly IntegrationProviderId[];
}): IntegrationActivationResult {
  const startedAt = performance.now();
  const message = input.message ?? "";
  const connected = [...new Set(input.connectedProviders)];

  let matches = lexicalMatches(message, connected);
  let activated = activatedFromMatches(matches);

  if (activated.length === 0 && input.previousUserMessage && hasContinuityCue(message)) {
    const previousMatches = lexicalMatches(input.previousUserMessage, connected);
    const carried = activatedFromMatches(previousMatches).map(
      (provider): IntegrationActivationMatch => ({
        provider,
        rule: "continuity",
        matchedText: truncateMatch(matchedTextForProvider(previousMatches, provider)),
        score: ACTIVATION_SCORE_THRESHOLD,
      }),
    );
    if (carried.length > 0) {
      matches = [...matches, ...carried];
      activated = activatedFromMatches(matches);
    }
  }

  if (activated.length === 0) {
    const fallback = semanticFallbackMatch(message, connected);
    if (fallback) {
      matches = [...matches, fallback];
      activated = [fallback.provider];
    }
  }

  const capped = activated.length > MAX_ACTIVATED_INTEGRATION_PROVIDERS;
  return {
    version: INTEGRATION_ACTIVATION_VERSION,
    activated: capped ? activated.slice(0, MAX_ACTIVATED_INTEGRATION_PROVIDERS) : activated,
    matches,
    capped,
    elapsedMs: Math.max(0, performance.now() - startedAt),
  };
}

function lexicalMatches(
  message: string,
  connected: readonly IntegrationProviderId[],
): IntegrationActivationMatch[] {
  const matches: IntegrationActivationMatch[] = [];

  for (const provider of connected) {
    for (const { rule, pattern, score } of PROVIDER_RULES[provider]) {
      const match = pattern.exec(message);
      if (!match) continue;
      matches.push({ provider, rule, matchedText: truncateMatch(match[0]), score });
    }
  }

  const sharedMatch = SHARED_ISSUE_PATTERN.exec(message);
  if (sharedMatch) {
    const candidates = SHARED_ISSUE_PROVIDERS.filter((provider) => connected.includes(provider));
    const score = candidates.length === 1 ? ACTIVATION_SCORE_THRESHOLD : 1;
    for (const provider of candidates) {
      matches.push({
        provider,
        rule: "shared-term-issue",
        matchedText: truncateMatch(sharedMatch[0]),
        score,
      });
    }
  }

  return matches;
}

// A provider activates when its combined rule score reaches the threshold.
// Results are ordered by total score, then provider id, for determinism.
function activatedFromMatches(matches: readonly IntegrationActivationMatch[]) {
  const scores = new Map<IntegrationProviderId, number>();
  for (const match of matches) {
    scores.set(match.provider, (scores.get(match.provider) ?? 0) + match.score);
  }
  return [...scores.entries()]
    .filter(([, score]) => score >= ACTIVATION_SCORE_THRESHOLD)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([provider]) => provider);
}

function hasContinuityCue(message: string) {
  const trimmed = message.trim();
  return trimmed.length <= CONTINUITY_MAX_MESSAGE_LENGTH && CONTINUITY_CUE_PATTERN.test(trimmed);
}

function matchedTextForProvider(
  matches: readonly IntegrationActivationMatch[],
  provider: IntegrationProviderId,
) {
  return matches.find((match) => match.provider === provider)?.matchedText ?? "";
}

function semanticFallbackMatch(
  message: string,
  connected: readonly IntegrationProviderId[],
): IntegrationActivationMatch | null {
  const tokens = new Set(
    message
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
  if (tokens.size === 0) return null;

  let best: { provider: IntegrationProviderId; overlap: string[] } | null = null;
  for (const provider of connected) {
    const overlap = SEMANTIC_VOCABULARY[provider].filter((term) => tokens.has(term));
    if (overlap.length < SEMANTIC_MIN_OVERLAP) continue;
    if (
      !best ||
      overlap.length > best.overlap.length ||
      (overlap.length === best.overlap.length && provider.localeCompare(best.provider) < 0)
    ) {
      best = { provider, overlap };
    }
  }
  if (!best) return null;

  return {
    provider: best.provider,
    rule: "semantic-fallback",
    matchedText: truncateMatch(best.overlap.join(" ")),
    score: best.overlap.length,
  };
}

function truncateMatch(value: string) {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
