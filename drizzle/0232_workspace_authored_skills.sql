ALTER TABLE "goat"."skill_bundles" ALTER COLUMN "source_url" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ALTER COLUMN "source_path" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ALTER COLUMN "source_ref" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ALTER COLUMN "resolved_commit" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" DROP CONSTRAINT "skill_bundles_source_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" DROP CONSTRAINT "skill_bundles_commit_check";
--> statement-breakpoint
DROP INDEX "goat"."skill_bundles_workspace_integrity_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_bundles_workspace_integrity_idx"
  ON "goat"."skill_bundles" USING btree ("workspace_id", "integrity", "source_type");
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ADD CONSTRAINT "skill_bundles_source_type_check"
  CHECK ("source_type" IN ('github', 'skills.sh', 'workspace'));
--> statement-breakpoint
ALTER TABLE "goat"."skill_bundles" ADD CONSTRAINT "skill_bundles_commit_check"
  CHECK (
    (
      "source_type" = 'workspace'
      AND "source_url" IS NULL
      AND "source_path" IS NULL
      AND "source_ref" IS NULL
      AND "resolved_commit" IS NULL
    )
    OR (
      "source_type" IN ('github', 'skills.sh')
      AND "source_url" IS NOT NULL
      AND "source_path" IS NOT NULL
      AND "source_ref" IS NOT NULL
      AND "resolved_commit" ~ '^[0-9a-f]{40}$'
    )
  );
