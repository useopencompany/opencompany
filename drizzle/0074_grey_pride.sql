ALTER TABLE "goat"."tasks" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "goat"."tasks"
SET "name" = COALESCE(
	NULLIF(
		CASE
			WHEN length(regexp_replace(trim(split_part("prompt", E'\n', 1)), '[.!?]+$', '')) > 48
				THEN rtrim(left(regexp_replace(trim(split_part("prompt", E'\n', 1)), '[.!?]+$', ''), 48)) || '...'
			ELSE regexp_replace(trim(split_part("prompt", E'\n', 1)), '[.!?]+$', '')
		END,
		''
	),
	'Untitled task'
);--> statement-breakpoint
ALTER TABLE "goat"."tasks" ALTER COLUMN "name" SET DEFAULT 'Untitled task';--> statement-breakpoint
ALTER TABLE "goat"."tasks" ALTER COLUMN "name" SET NOT NULL;
