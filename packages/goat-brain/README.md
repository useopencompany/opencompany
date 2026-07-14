# Goat Brain

Shared Goat Brain contracts for Markdown documents, validation, retrieval, and CLI behavior.

## Inline Links

Inline links are parsed and formatted by `src/inline-links.ts`. Keep new link syntax, validation,
target extraction, and formatting helpers there so CLI, DB projections, retrieval, and UI behavior
stay aligned.

Canonical forms:

```md
[[page:acme|Acme]]
[[evidence:ev-acme-pricing-thread|Acme pricing thread]]
[[source:gmail:thread_123|Gmail thread]]
```

Compatibility forms:

```md
[[acme|Acme]]
[^ev:ev-seed]
```

Compatibility forms remain readable for old content, but new generated content should use typed
links. Page links resolve to brain documents. Evidence links resolve to first-class evidence records
when present and can also cite local timeline evidence ids. Source links are parser and display
ready; they do not create graph edges until a source-detail route exists. Escaped link syntax and
link-shaped text inside inline, fenced, or indented code remain literal Markdown.

Use these helpers instead of hand-writing regexes or string templates:

- `parseGoatBrainInlineLinks(text)`
- `formatGoatBrainPageLink(id, label?)`
- `formatGoatBrainEvidenceLink(id, label?)`
- `formatGoatBrainSourceLink(ref, label?)`
- `pageLinkTargets(text)`
- `evidenceLinkTargets(text)`
- `sourceLinkTargets(text)`
