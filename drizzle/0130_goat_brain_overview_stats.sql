-- Attribute Brain reads to the Brain they targeted so the overview can report
-- per-Brain retrieval activity. Existing audit rows stay nullable because
-- their target Brain cannot be reconstructed reliably from chat history.
ALTER TABLE "goat"."brain_tool_runs" ADD COLUMN IF NOT EXISTS "brain_ref" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goat"."brain_tool_runs" ADD CONSTRAINT "brain_tool_runs_brain_ref_brains_id_fk" FOREIGN KEY ("brain_ref") REFERENCES "goat"."brains"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_tool_runs_brain_created_at_idx" ON "goat"."brain_tool_runs" USING btree ("brain_ref", "created_at");
