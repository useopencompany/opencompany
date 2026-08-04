# LinkedIn Network in Main Chat

Status: researched recommendation
Date: 2026-08-04

## User job

Founders want to ask OpenCompany relationship questions that are awkward to answer manually from LinkedIn:

- "Who do I know that is CTO at a small early-stage company?"
- "Who could intro me to person X?"
- "Which operators in my network know fintech infrastructure?"

The core job is not "search LinkedIn." It is "turn my private relationship graph into a trusted, searchable operating asset." Main chat should answer with people the user plausibly knows, explain why each match was returned, and preserve enough provenance that the user can trust the recommendation before reaching out.

## API reality

The official LinkedIn path is not a normal public OAuth integration:

- The Connections API returns first-degree connections for the authenticated member, but LinkedIn marks it restricted to approved developers and says connections are only available for the member who granted access. It does not allow browsing second-degree connections or the connections of those connections. Source: [LinkedIn Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api?context=linkedin%2Fcompliance%2Fcontext).
- The Connections Size API only returns the count of first-degree connections and also requires acceptance to a LinkedIn Partner Program. Source: [LinkedIn Connections Size API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-size).
- The Profile API is restricted and says data returned from the Profile API may only be stored for authenticated members with permission; it may not be stored for other members. Source: [LinkedIn Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api?view=li-lms-2025-04).
- LinkedIn's own account data export includes a `Connections` data category with first and last name, public profile URL, email address when authorized by that connection, company, position, and connection date for first-degree connections. LinkedIn says larger downloads can take up to 24 hours, category-specific downloads may arrive within minutes, and download links expire after 72 hours. Sources: [Export connections from LinkedIn](https://www.linkedin.com/help/linkedin/answer/a566336/export-connections-from-linkedin?lang=en), [Download your account data](https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data).

This means the best MVP should not depend on LinkedIn granting restricted API access, and it should not pretend the existing managed public LinkedIn capability can see a user's network. Browser automation against a logged-in LinkedIn session would be brittle and high-risk because it would be scraping a private logged-in surface.

## Recommendation

Build a first-party "Personal network" import and query layer, starting with user-provided LinkedIn `Connections.csv` from the official data export. Treat official API sync as a later enhancement if LinkedIn partner access becomes available.

This aligns with the product philosophy: one reliable, understandable workflow beats a broad LinkedIn scraper. For a 2-10 person team, a founder can export their connections once, upload the CSV, and immediately ask useful questions in main chat.

## Product shape

1. Import

Add a "LinkedIn connections CSV" import path under Brain/import or Settings/Integrations. The user uploads the CSV from LinkedIn's account data export. We parse only the known fields:

- first name
- last name
- profile URL
- email address, if present
- company
- position
- connected on

Show a short import review before committing: row count, skipped rows, duplicate count, and "emails are private and only shown when directly relevant."

2. Storage

Use a structured table as the retrieval source of truth, not only free-form Brain pages. Brain is good for curation and memory, but relationship questions need deterministic filters, refreshes, duplicate handling, and provenance.

Suggested table: `goat_network_contacts`

- `id`
- `workspace_id`
- `user_workos_id`
- `source` = `linkedin_export`
- `source_import_id`
- `full_name`
- `first_name`
- `last_name`
- `profile_url`
- `email`
- `company_name`
- `title`
- `connected_on`
- `search_text`
- `profile_embedding` or reuse the existing Brain embedding path if available
- `normalized_company_key`
- `normalized_title_seniority`
- `created_at`
- `updated_at`
- `archived_at`

Unique key: `(user_workos_id, source, profile_url)` when profile URL exists, with a fallback hash on name/company/title for rows without URLs.

3. Main chat tool

Expose a first-party read-only action source, not a managed capability:

Source id: `personal_network`

Actions:

- `personal_network.search_people`: filters and ranks imported contacts by title, company, keywords, company size/stage tags when present, and recency of connection.
- `personal_network.find_intro_candidates`: given a target person/company/profile URL, returns first-degree contacts who may be able to help, ordered by direct target match, same current company, same prior/imported company when available later, same domain/theme, and relationship freshness.
- `personal_network.get_person`: retrieves one imported contact with provenance and freshness.

The chat answer should distinguish evidence from inference:

- "You know Ada directly; imported from LinkedIn export on July 20, 2026."
- "Grace may be a good intro path because she is currently at Acme, the target's company. I do not know whether she personally knows the target."

4. Enrichment

Keep the first version useful without enrichment. Title and company are enough for queries like "CTO" or "founder."

For "small early-stage company," add optional enrichment in a second pass:

- deterministic heuristics from company/title text first
- public web lookup for company website/about/funding where user asks
- metered lead/company capabilities only after explicit user intent and normal paid-action controls

Do not silently enrich every imported connection through paid providers. That would be expensive, surprising, and hard to explain.

5. Privacy and controls

- The import is personal to the user by default. Let the user explicitly share it with the workspace later.
- Provide delete and refresh controls.
- Do not show connection emails in normal answers unless the user asks for contact details.
- Do not save public/managed LinkedIn lookup results into Brain or this network table unless the user explicitly asks.
- Never claim second-degree certainty. If we infer an intro path through company overlap, label it as an inference.

## Implementation plan

1. Add `linkedin_export` parsing behind an upload route.
2. Add `goat_network_imports` and `goat_network_contacts` tables plus tests for duplicate handling and CSV preamble/header tolerance.
3. Add a `personal_network` action resolver in `@opencompany/goat-agent` and include it in `resolveGoatActionCatalog` when imported contacts exist.
4. Add action execution tests for `search_people`, `find_intro_candidates`, and privacy behavior around emails.
5. Add a small settings/import UI with upload, review, commit, refresh, delete, and last-import freshness.
6. Add prompt guidance that personal-network answers require Brain or `personal_network`, not managed LinkedIn public lookups.
7. Optional later: apply for LinkedIn partner access for official ongoing sync, but keep CSV import as the fallback even if partner access is granted.

## Non-goals for v1

- No LinkedIn logged-in browser scraping.
- No second-degree network browsing.
- No automatic outreach or LinkedIn messaging.
- No workspace-wide sharing by default.
- No bulk paid enrichment on import.

## Current repo note

Goat already exposes a managed `linkedin` source for public LinkedIn research in `apps/goat/lib/capabilities/catalog.ts`. That source explicitly does not connect to the user's account, so it should remain separate from this feature. The new surface should be a first-party `personal_network` connected/internal source backed by user-imported data.
