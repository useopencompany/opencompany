-- Skill selections already live in each Run's settings. Keep the same safe, user-visible metadata
-- on the triggering Message so Electric transcripts and public shares can render the selection
-- after the optimistic client row is replaced.
CREATE OR REPLACE FUNCTION "goat"."chat_presentation_v1"(debug_trace jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN debug_trace IS NULL THEN NULL
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'schemaVersion', debug_trace -> 'schemaVersion',
      'model', debug_trace -> 'model',
      'mentions', debug_trace -> 'mentions',
      'aborted', debug_trace -> 'aborted',
      'finishReason', debug_trace -> 'finishReason',
      'uiMessageParts', debug_trace -> 'uiMessageParts',
      'durationMs', debug_trace -> 'durationMs',
      'usage', debug_trace -> 'usage',
      'error', debug_trace -> 'error',
      'scheduledWakeup', debug_trace -> 'scheduledWakeup'
    ))
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."chat_presentation_summary_v1"(presentation jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  part_summaries jsonb;
BEGIN
  IF presentation IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(presentation -> 'uiMessageParts') = 'array' THEN
    SELECT COALESCE(
      jsonb_agg(goat.chat_presentation_part_summary_v1(part.value) ORDER BY part.ordinality),
      '[]'::jsonb
    )
    INTO part_summaries
    FROM jsonb_array_elements(presentation -> 'uiMessageParts')
      WITH ORDINALITY AS part(value, ordinality);
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', presentation -> 'schemaVersion',
    'model', presentation -> 'model',
    'mentions', goat.chat_compact_presentation_value_v1(presentation -> 'mentions', 0),
    'aborted', presentation -> 'aborted',
    'finishReason', presentation -> 'finishReason',
    'uiMessageParts', part_summaries,
    'durationMs', presentation -> 'durationMs',
    'usage', presentation -> 'usage',
    'error', presentation -> 'error',
    'scheduledWakeup', goat.chat_compact_presentation_value_v1(
      presentation -> 'scheduledWakeup',
      0
    )
  ));
END
$$;--> statement-breakpoint

-- Backfill previously selected Skills from the durable Run. Updating the source Message also lets
-- the existing projection trigger refresh both presentation columns without a second data path.
UPDATE goat.chat_messages AS message
SET debug_trace = COALESCE(message.debug_trace, '{}'::jsonb) ||
  jsonb_build_object('mentions', hydrated.mentions)
FROM goat.codex_chat_turns AS run
CROSS JOIN LATERAL (
  SELECT jsonb_agg(
    CASE
      WHEN mention.value ? 'name' OR installation.name IS NULL THEN mention.value
      ELSE mention.value || jsonb_build_object('name', installation.name)
    END
    ORDER BY mention.ordinality
  ) AS mentions
  FROM jsonb_array_elements(run.settings -> 'mentions')
    WITH ORDINALITY AS mention(value, ordinality)
  LEFT JOIN goat.skill_installations AS installation
    ON installation.id = mention.value ->> 'id'
) AS hydrated
WHERE message.id = run.user_message_id
  AND message.role = 'user'
  AND jsonb_typeof(COALESCE(message.debug_trace, '{}'::jsonb)) = 'object'
  AND jsonb_typeof(run.settings -> 'mentions') = 'array'
  AND jsonb_array_length(run.settings -> 'mentions') > 0
  AND message.debug_trace -> 'mentions' IS DISTINCT FROM hydrated.mentions;
