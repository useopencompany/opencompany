# Updating the changelog

The root `CHANGELOG.md` is the single source for release notes. It follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) with SemVer
versions and is rendered publicly at `/changelog` (the `## [Unreleased]`
section is hidden there until it becomes a release).

## Always work from the true merge history

Entries must reflect what actually merged into `main` — never write them from
memory, open PRs, or branches that might still change. Before updating, list
the merges since the last release date:

```bash
gh pr list --state merged --base main --search "merged:>=2026-06-08" \
  --json number,title,author --limit 100
```

(or `git log --first-parent --oneline main --since=<last release date>`).
Every entry should trace back to one or more of those merged PRs; anything not
in that list does not go in the changelog.

## Writing entries

1. Add entries under `## [Unreleased]` as PRs merge, or in a batch when
   cutting a release.
2. Use the standard categories: `### Added`, `### Changed`, `### Fixed`,
   `### Deprecated`, `### Removed`, `### Security`.
3. Write user-facing, plain-language descriptions (what changed for the user,
   not how), ending with the PR reference and author:

   ```markdown
   - Session pages now use the session title as the browser tab title (#354) — @louis.
   ```

4. Supported inline markdown: `[links](…)`, `` `code` ``, `**bold**`, and
   media (below). Bare URLs auto-link.

## Cutting a release

Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` (minor bump for normal
releases while we're pre-1.0) and add a fresh empty `## [Unreleased]` above it.
The new version goes live on `/changelog` with the next production deploy.

## Screen recordings and images

Short demo clips make entries much better. Media uses standard image syntax on
an indented continuation line under the bullet it illustrates:

```markdown
- Unseen-activity blue dot for sessions (#373) — @louis.
  ![Blue dot demo](https://ezmy3aezqryrdiuz.public.blob.vercel-storage.com/changelog/0.11.0/blue-dot.mp4)
```

`.mp4`/`.webm`/`.mov` URLs render as muted looping autoplay videos; other URLs
as images. Host media in the public `opencompany-changelog` Vercel Blob store —
see [changelog-media.md](./changelog-media.md) for the record → compress →
upload flow (one `ffmpeg` command and one `vercel blob put` command, token via
Infisical). Upload media *before* merging the changelog edit so the URL is
never dead, and treat uploaded blobs as immutable.
