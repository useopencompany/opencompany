# ADR 0007: Canonical Roots for Standalone Skill Imports

- Status: Accepted
- Date: 2026-09-02
- Standards: [Agent Skills](https://agentskills.io/specification) (loader shipped in
  [ADR 0005](./0005-agent-skills-and-plugins.md))

## Context

Agent Skills requires the declared Skill name to match its parent directory. Public monorepos can
use a different source directory while installers such as skills.sh select and install the Skill by
its declared name. Treating the repository directory as the installed root rejects otherwise
portable Skills and conflates source discovery with the canonical artifact.

## Decision

For standalone imports, the source repository path is provenance rather than the installed bundle
root. Discovery selects a Skill by its strictly parsed declared name, fetches the exact subtree at a
pinned commit, and materializes the canonical stored and runtime bundle under that name. Preview
reports when the source directory is normalized. The stored bundle still passes the Agent Skills
name-to-parent-directory invariant because its canonical root is the declared name.

Plugin child directories remain part of the immutable Plugin package contract. They are not
normalized and must match their declared Skill names.

Skill import resource limits remain a separate client policy rather than a format rule. Standalone
and Plugin Skills allow up to 512 files while retaining the existing 1 MiB total and 512 KiB
per-file limits. Remote files are fetched with bounded concurrency and timeouts.

## Consequences

- skills.sh URLs select by declared name even when the backing repository directory differs.
- Source provenance continues to record the original repository path and exact commit.
- Stored and mounted Skill bundles remain standards-compliant and integrity-pinned.
- Plugin package validation remains strict and does not rewrite third-party package layouts.
