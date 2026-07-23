ALTER TABLE "goat"."workspace_capabilities"
	DROP CONSTRAINT "goat_workspace_capabilities_source_check",
	ADD CONSTRAINT "goat_workspace_capabilities_source_check"
		CHECK ("source" IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead', 'seo')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_capabilities"
	VALIDATE CONSTRAINT "goat_workspace_capabilities_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs"
	DROP CONSTRAINT "goat_capability_runs_source_check",
	ADD CONSTRAINT "goat_capability_runs_source_check"
		CHECK ("source" IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead', 'seo')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs"
	VALIDATE CONSTRAINT "goat_capability_runs_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs"
	DROP CONSTRAINT "goat_capability_runs_provider_check",
	ADD CONSTRAINT "goat_capability_runs_provider_check"
		CHECK ("provider" IN ('tikhub', 'apify', 'pdl', 'semrush')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs"
	VALIDATE CONSTRAINT "goat_capability_runs_provider_check";
