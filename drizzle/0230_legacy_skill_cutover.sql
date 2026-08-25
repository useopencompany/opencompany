DROP TABLE "goat"."chat_session_skills";
--> statement-breakpoint
DROP TABLE "goat"."skills";
--> statement-breakpoint
DELETE FROM "goat"."knowledge_command_idempotency"
WHERE "operation" IN ('skill.create', 'skill.import');
--> statement-breakpoint
ALTER TABLE "goat"."knowledge_command_idempotency"
  DROP CONSTRAINT "goat_knowledge_command_idempotency_operation_check";
--> statement-breakpoint
ALTER TABLE "goat"."knowledge_command_idempotency"
  ADD CONSTRAINT "goat_knowledge_command_idempotency_operation_check"
  CHECK (
    "goat"."knowledge_command_idempotency"."operation" IN (
      'brain_document.create',
      'brain_asset.create',
      'brain_asset.replace',
      'wiki_page.create',
      'wiki_timeline.create',
      'brain_import.start'
    )
  );
--> statement-breakpoint
CREATE FUNCTION "goat"."delete_workspace_skill_plugin_references"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "goat"."chat_session_plugins" AS "snapshot"
  USING "goat"."plugins" AS "plugin"
  WHERE "snapshot"."plugin_id" = "plugin"."id"
    AND "plugin"."workspace_id" = OLD."id";

  DELETE FROM "goat"."chat_session_skill_bundles" AS "snapshot"
  USING "goat"."skill_bundles" AS "bundle"
  WHERE "snapshot"."bundle_id" = "bundle"."id"
    AND "bundle"."workspace_id" = OLD."id";

  DELETE FROM "goat"."plugin_skills"
  WHERE "workspace_id" = OLD."id";

  DELETE FROM "goat"."skill_installations"
  WHERE "workspace_id" = OLD."id";

  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "goat_workspaces_delete_skill_plugin_references"
BEFORE DELETE ON "goat"."workspaces"
FOR EACH ROW
EXECUTE FUNCTION "goat"."delete_workspace_skill_plugin_references"();
