# Goat Brain Pointer/Copy Contract

How brain writers cite external sources. This is design principle 6 of the brain foundation
(issue #597): the brain keeps claims and pointers, and copies content only when it has to.

The prompt-ready form of this rule is `GOAT_BRAIN_POINTER_COPY_RULE` in
`packages/goat-brain/src/pointer-copy.ts`. Every brain writing agent embeds that constant in its
system prompt; edit the rule there and here together.

## The rule

Every claim written into the brain has three parts:

1. **The claim itself** — in a page's compiled truth or as a dated timeline entry.
2. **A source pointer** — a `[[source:provider:id|Label]]` inline link, a timeline `--source-ref`,
   or a frontmatter `sources[].ref`. The pointer is mandatory: a claim with no pointer is a
   fabrication risk.
3. **A content snapshot in `evidence/`** — **only** when the source is ephemeral or has no
   canonical live home. When a snapshot exists, claims link the evidence record with
   `[[evidence:ev-...]]`; pages never inline the raw content.

## Per source class

| Source class | Handling | Why |
| --- | --- | --- |
| Meeting transcripts, call recordings (Jamie) | Snapshot into `evidence/` | Ephemeral; no canonical live home. Pages link the evidence record, never inline the transcript. |
| Emails | Snapshot into `evidence/` | Mailboxes are private and mutable; the brain cannot rely on re-fetching. |
| Tracked work items (Linear issues, GitHub issues/PRs) | Pointer + one-line current-state summary | The tracker is the canonical live home; body copies go stale the moment they are written. Never copy the body. |
| Uploaded files (PDFs) | Bytes-by-key + extracted-text copy | The brain itself is the canonical home: the blob holds the bytes (`asset_storage_key`), the document row holds the machine-extracted text, and the page's `sources` entry carries the `upload:<documentId>` ref. See [data-model.md](./data-model.md#binary-assets-pdf). |
| Everything else | Pointer only, by default | Snapshot only if the content could not be re-fetched later. |

## Source ref grammar

A source ref is `provider:id`:

- `provider` — lowercase slug (`[a-z0-9][a-z0-9-]{0,63}`) naming the system, e.g. `jamie`,
  `gmail`, `linear`, `github`.
- `id` — the provider's own identifier. It may contain colons or slashes
  (`jamie:meeting:calendar_event_123` is provider `jamie`, id `meeting:calendar_event_123`), but
  no whitespace, brackets, or pipes, so the ref stays inline-link safe. Whole ref caps at 256
  characters.

Validation and parsing live in `packages/goat-brain/src/schema.ts`
(`isValidGoatBrainSourceRef`, `parseGoatBrainSourceRef`).

## Enforcement

- `[[source:...]]` inline links are shape-validated by
  `packages/goat-brain/src/inline-links.ts`; malformed targets are validation errors on document
  writes (`validate.ts`) and `invalid_source_link` findings in `goat-brain doctor` (`health.ts`).
- Frontmatter `sources[].ref` values that are not `provider:id` shaped surface as
  `nonstandard_source_ref` warnings in `goat-brain doctor` (warning, not error, so legacy refs do
  not break existing brains).
- The ingestion agent's system prompt embeds `GOAT_BRAIN_POINTER_COPY_RULE`
  (`apps/runner/src/goat-brain-agent-ingest.ts`), so ingesting a source with a live canonical
  home produces a pointer plus a one-line state summary, not a body copy.

## Future seam: source resolvers

Pointers are hydrated at **read time** through the integrations layer by *source resolvers* —
per-provider adapters that take a parsed ref and return the source's current title, canonical
URL, and one-line state. The interface shape is defined (and only defined — nothing implements
or invokes it yet) in `packages/goat-brain/src/source-resolvers.ts`:

```ts
type GoatBrainSourceResolver = {
  provider: string; // e.g. "linear"
  resolve(ref: ParsedGoatBrainSourceRef): Promise<GoatBrainResolvedSource | null>;
};
```

When resolvers land, a reader (deterministic read plane or the librarian agent, step 4 of #597)
can turn `[[source:linear:issue_ABC-12]]` into a live link with fresh state instead of trusting
the one-line summary frozen at write time. Implementations belong in the integrations layer
(`integration_events` / `packages/integrations` direction), registered per provider — never in
`packages/goat-brain`.
