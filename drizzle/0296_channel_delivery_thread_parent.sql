-- A workflow run can now post a short root message and follow it with detail in that message's
-- thread. The reply is queued before Slack has assigned the root a timestamp, so it points at the
-- root delivery instead of a thread_ts and the worker resolves the real timestamp when it sends.
ALTER TABLE "goat"."channel_deliveries"
	ADD COLUMN "thread_parent_id" text REFERENCES "goat"."channel_deliveries" ("id") ON DELETE CASCADE;

CREATE INDEX "channel_deliveries_thread_parent_idx"
	ON "goat"."channel_deliveries" ("thread_parent_id")
	WHERE "thread_parent_id" IS NOT NULL;
