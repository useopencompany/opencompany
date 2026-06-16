---
name: rpi-archiving-artifacts
description: Collects all RPI markdown artifacts (research.md, plan.md, decision-*.md, devlog-*.md, *-review-*.md) into a dated folder, generates a one-page summary, and removes the originals from the project root. Run manually at the end of a feature to archive artifacts for transfer to a separate repository.
---

# Archiving Artifacts

Collects all RPI-generated markdown files into a single dated folder with a summary, ready for archival in a separate repository.

## Workflow

1. **Identify artifacts** — Scan the project root for RPI markdown files:
   - `research.md` and `research-*.md`
   - `plan.md` and `plan-*.md`
   - `decision-*.md`
   - `devlog-*.md`
   - `*-review-*.md` (research-review, plan-review, code-review)

   If no artifacts are found, stop and inform the user.

2. **Determine folder name** — Ask the user for a short feature description (1-3 words). Create the folder name as `YYYYMMDD-featureDescription` using today's date and the description in camelCase. Example: `20260515-asyncJobQueue`.

3. **Create the archive folder** — Create the folder in the project root.

4. **Move artifacts** — Move all identified markdown files into the archive folder, preserving their original filenames.

5. **Generate summary** — Read all moved artifacts and write `summary.md` inside the archive folder. Use the template below. Target roughly one page (~40-60 lines). Distill, don't concatenate.

6. **Report** — List what was archived and where. Remind the user to copy or move the folder to their archival repository.

## Summary Template

```markdown
# Feature Summary: [Feature Name]

**Date:** [YYYY-MM-DD]
**Repository:** [name of current repo]

## Overview
[2-3 sentence high-level description of what was researched, planned, and built]

## Key Decisions
- [Important decisions made and their rationale, distilled from decision-*.md files]

## What Was Built
- [Concrete deliverables and changes, distilled from plan.md and devlog]

## Architecture & Design
[Brief description of the technical approach taken]

## Review Findings
- [Notable findings from reviews, especially anything that required revision]

## Lessons Learned
- [Tricky parts, surprises, or deviations from the plan — from the devlog]
```

## Notes

- This skill is manually invoked. It is never auto-triggered.
- Do not archive `CLAUDE.md`, `README.md`, or any markdown files that are not RPI artifacts.
- If a `.gitignore` entry exists for any of the artifact patterns, mention it to the user but still proceed with archiving.
- The summary should stand on its own — someone reading only `summary.md` should understand what happened without opening the other files.
