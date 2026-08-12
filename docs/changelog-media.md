# Changelog media (screen recordings)

> For the overall changelog process (categories, entry style, working from the
> true merge history), see [changelog.md](./changelog.md). This page covers
> only the media hosting and upload flow.

The public `/changelog` page (rendered from the root `CHANGELOG.md`) supports
inline images and short screen recordings via standard Markdown image syntax:

```markdown
### Added

- Unseen-activity blue dot for sessions.
  ![Blue dot demo](https://ezmy3aezqryrdiuz.public.blob.vercel-storage.com/changelog/0.11.0/blue-dot.mp4)
```

URLs ending in `.mp4`, `.webm`, or `.mov` render as muted, looping, autoplaying
videos (GIF-style). Anything else renders as a lazy-loaded image. On GitHub the
same line degrades to a plain link, which keeps `CHANGELOG.md` valid
Keep a Changelog Markdown.

## Where media lives

Vercel Blob access mode is **per-store and immutable after creation**, so we run
two stores (see [env-vars.md](./env-vars.md#vercel-blob-stores)):

| Store | Access | Purpose | Token |
|---|---|---|---|
| `opencompany-changelog` | Public | Changelog media, served by direct CDN URL | `CHANGELOG_BLOB_READ_WRITE_TOKEN` (Infisical `prod` + `/release`) |
| `opencompany-attachments` | Private | Session attachments and Brain assets | `BLOB_READ_WRITE_TOKEN` (web, canonical API, and runner runtimes) |

Changelog media never goes through the deploy pipeline — blobs are uploaded at
authoring time and served straight from Blob's CDN, so CI needs no changes when
adding recordings. The upload token is an authoring-time credential only; the
web app never reads it at runtime.

## Authoring flow

1. **Record** the clip (macOS: `Cmd+Shift+5`, or any screen recorder). Keep it
   short — 5–15 seconds, one feature per clip.

2. **Compress** to a small H.264 MP4:

   ```bash
   ffmpeg -i raw.mov -vcodec h264 -crf 28 -preset slow -movflags +faststart \
     -an -vf "scale=1280:-2" demo.mp4
   ```

   Target well under ~2 MB per clip. `-an` strips audio (videos play muted
   anyway); `+faststart` lets playback begin before the full file downloads.

3. **Upload** to the public changelog store, namespaced by release version. The
   token comes from Infisical, so no local env setup is needed:

   ```bash
   infisical run --env=prod --path=/release -- sh -c \
     'vercel blob put demo.mp4 --access public \
        --rw-token "$CHANGELOG_BLOB_READ_WRITE_TOKEN" \
        --pathname changelog/0.11.0/blue-dot.mp4'
   ```

   This prints the public URL
   (`https://ezmy3aezqryrdiuz.public.blob.vercel-storage.com/changelog/...`).

4. **Reference** the printed URL in `CHANGELOG.md` as an indented continuation
   line under the bullet it illustrates (two-space indent keeps it attached to
   that entry).

Blob pathnames are namespaced `changelog/<version>/<name>.mp4` so assets are
easy to audit or clean up per release. Treat blobs as immutable — if a clip
needs to change, upload under a new name (Blob CDN caches for up to a month).
