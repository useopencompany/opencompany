DO $$
BEGIN
  IF to_regclass('public.workspace_github_installations') IS NOT NULL
    AND to_regclass('public.workspace_github_integration_installations') IS NULL THEN
    ALTER TABLE "workspace_github_installations" RENAME TO "workspace_github_integration_installations";
  ELSIF to_regclass('public.workspace_github_installations') IS NOT NULL
    AND to_regclass('public.workspace_github_integration_installations') IS NOT NULL THEN
    INSERT INTO "workspace_github_integration_installations"
      ("id", "workspace_id", "installation_id", "account_login", "account_type", "created_at", "updated_at")
    SELECT "id", "workspace_id", "installation_id", "account_login", "account_type", "created_at", "updated_at"
    FROM "workspace_github_installations"
    ON CONFLICT ("workspace_id") DO UPDATE SET
      "installation_id" = EXCLUDED."installation_id",
      "account_login" = EXCLUDED."account_login",
      "account_type" = EXCLUDED."account_type",
      "updated_at" = EXCLUDED."updated_at";
    DROP TABLE "workspace_github_installations";
  END IF;

  IF to_regclass('public.workspace_github_repositories') IS NOT NULL
    AND to_regclass('public.workspace_github_integration_repositories') IS NULL THEN
    ALTER TABLE "workspace_github_repositories" RENAME TO "workspace_github_integration_repositories";
  ELSIF to_regclass('public.workspace_github_repositories') IS NOT NULL
    AND to_regclass('public.workspace_github_integration_repositories') IS NOT NULL THEN
    INSERT INTO "workspace_github_integration_repositories"
      ("id", "workspace_id", "installation_id", "github_repo_id", "full_name", "default_branch", "private", "selected_at", "created_at", "updated_at")
    SELECT "id", "workspace_id", "installation_id", "github_repo_id", "full_name", "default_branch", "private", "selected_at", "created_at", "updated_at"
    FROM "workspace_github_repositories"
    ON CONFLICT ("workspace_id", "full_name") DO UPDATE SET
      "installation_id" = EXCLUDED."installation_id",
      "github_repo_id" = EXCLUDED."github_repo_id",
      "default_branch" = EXCLUDED."default_branch",
      "private" = EXCLUDED."private",
      "selected_at" = EXCLUDED."selected_at",
      "updated_at" = EXCLUDED."updated_at";
    DROP TABLE "workspace_github_repositories";
  END IF;
END $$;
--> statement-breakpoint
ALTER INDEX IF EXISTS "workspace_github_installations_workspace_idx" RENAME TO "workspace_github_integration_installations_workspace_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "workspace_github_installations_installation_idx" RENAME TO "workspace_github_integration_installations_installation_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "workspace_github_repositories_workspace_idx" RENAME TO "workspace_github_integration_repositories_workspace_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "workspace_github_repositories_workspace_full_name_idx" RENAME TO "workspace_github_integration_repositories_workspace_full_name_idx";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_github_installations_workspace_id_workspaces_id_fk'
  ) THEN
    ALTER TABLE "workspace_github_integration_installations"
      RENAME CONSTRAINT "workspace_github_installations_workspace_id_workspaces_id_fk"
      TO "workspace_github_integration_installations_workspace_id_workspaces_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_github_repositories_workspace_id_workspaces_id_fk'
  ) THEN
    ALTER TABLE "workspace_github_integration_repositories"
      RENAME CONSTRAINT "workspace_github_repositories_workspace_id_workspaces_id_fk"
      TO "workspace_github_integration_repositories_workspace_id_workspaces_id_fk";
  END IF;

END $$;
