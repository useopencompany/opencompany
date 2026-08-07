import type { ParsedBrainSourceRef } from "./schema";

// Source resolvers are the future seam for hydrating [[source:provider:id]]
// pointers at read time through the integrations layer. The brain stores only
// the pointer (plus a one-line state summary for tracked items, per the
// pointer/copy contract); a resolver fetches the source's current title, URL,
// and state when a reader wants it. This package defines the shape only —
// implementations live in the integrations layer, registered per provider,
// and no resolver is invoked anywhere yet.

export type BrainResolvedSource = {
  ref: string;
  provider: string;
  /** Canonical live URL, when the provider has one. */
  url: string | null;
  title: string | null;
  /** One-line current state, e.g. "In Progress — assigned to Ada". */
  state: string | null;
  /** ISO-8601 UTC timestamp of when the source was hydrated. */
  fetchedAt: string;
};

export type BrainSourceResolver = {
  /** Provider segment of the source refs this resolver handles, e.g. "linear". */
  provider: string;
  /** Returns null when the source no longer exists or is not reachable. */
  resolve(ref: ParsedBrainSourceRef): Promise<BrainResolvedSource | null>;
};
