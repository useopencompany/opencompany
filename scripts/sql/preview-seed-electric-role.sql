-- OPTIONAL hardening (issue #351 best-practice upgrade): a dedicated least-privilege
-- `electric` role for the Electric sync service, instead of the branch owner
-- (`neondb_owner`, which carries neon_superuser).
--
-- ⚠️ NOT required for a working preview. The default preview setup points Electric at the
-- branch owner role (same as local dev) — start there. Apply this only once you've
-- verified Electric can still create its publication + replication slot under the reduced
-- privileges on YOUR Neon/Electric versions, because publication creation typically needs
-- elevated rights. Test on a throwaway branch first.
--
--   psql "$SEED_DIRECT_URL" -v electric_password="$ELECTRIC_DB_PASSWORD" \
--     -f scripts/sql/preview-seed-electric-role.sql
--
-- After applying, point the Electric service's DATABASE_URL at this role instead of the
-- branch owner.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'electric') THEN
    EXECUTE format('CREATE ROLE electric WITH LOGIN REPLICATION PASSWORD %L', :'electric_password');
  ELSE
    EXECUTE format('ALTER ROLE electric WITH LOGIN REPLICATION PASSWORD %L', :'electric_password');
  END IF;
END $$;

-- Read-only access to the synced schema.
GRANT USAGE ON SCHEMA public TO electric;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;

-- Electric manages its own publication + logical replication slot. On Postgres this needs
-- CREATE on the database; publication-for-tables additionally needs table ownership or
-- elevated rights. If Electric fails to create its publication under this role, grant the
-- managed Neon replication role membership instead, or fall back to the branch owner.
GRANT CREATE ON DATABASE neondb TO electric;
