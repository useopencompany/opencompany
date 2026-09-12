-- Renames the default wiki from "Wiki" to "Company". "Wiki → Wiki" read like a
-- placeholder; the default wiki holds the company's shared knowledge, so the
-- name now says what is in it.
--
-- The slug moves with the name, because the sidebar's per-wiki routes
-- (/wiki/[wikiSlug]/...) ship in the same change: no slug-based URL exists yet,
-- so this is the last moment the slug can change without breaking a link. Slugs
-- are immutable after creation by design (UpdateWikiBody accepts name and
-- instructions, never slug), so a later rename cannot repeat this.
--
-- Conditional on the current values, so a workspace that deliberately renamed
-- its default wiki keeps that name. Idempotent: after a successful run no row
-- matches the predicate anymore.

UPDATE goat.wikis AS default_wiki
SET "name" = 'Company',
    "slug" = 'company',
    "updated_at" = now()
WHERE default_wiki."is_default"
  AND default_wiki."name" = 'Wiki'
  AND default_wiki."slug" = 'wiki'
  -- A workspace that already holds a wiki slugged "company" keeps its default
  -- wiki as-is: the unique index on (workspace_id, slug) would otherwise fail
  -- the migration, and suffixing would leave two wikis both named "Company".
  -- The default wiki stays reachable at /wiki/wiki either way.
  AND NOT EXISTS (
    SELECT 1
    FROM goat.wikis AS sibling
    WHERE sibling."workspace_id" = default_wiki."workspace_id"
      AND sibling."slug" = 'company'
  );
