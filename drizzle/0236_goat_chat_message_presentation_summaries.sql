-- Keep the existing full Chat presentation for compatibility and on-demand reads, while adding a
-- deterministic bounded projection for the Electric transcript shape. Text parts stay exact so the
-- slim transcript preserves ordering; reasoning and tool payloads are compacted for collapsed rows.
ALTER TABLE "goat"."message_read_model_v1"
ADD COLUMN "presentation_summary" jsonb;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."chat_compact_presentation_value_v1"(
  source_value jsonb,
  current_depth integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  compacted jsonb;
  value_type text;
BEGIN
  IF source_value IS NULL THEN
    RETURN NULL;
  END IF;

  value_type := jsonb_typeof(source_value);
  IF value_type = 'string' THEN
    RETURN to_jsonb(left(source_value #>> '{}', 160));
  END IF;
  IF value_type = 'array' THEN
    IF current_depth >= 3 THEN
      RETURN '[]'::jsonb;
    END IF;
    SELECT COALESCE(
      jsonb_agg(
        goat.chat_compact_presentation_value_v1(item.value, current_depth + 1)
        ORDER BY item.ordinality
      ),
      '[]'::jsonb
    )
    INTO compacted
    FROM jsonb_array_elements(source_value) WITH ORDINALITY AS item(value, ordinality)
    WHERE item.ordinality <= 8;
    RETURN compacted;
  END IF;
  IF value_type = 'object' THEN
    IF current_depth >= 3 THEN
      RETURN '{}'::jsonb;
    END IF;
    SELECT COALESCE(
      jsonb_object_agg(
        entry.key,
        goat.chat_compact_presentation_value_v1(entry.value, current_depth + 1)
      ),
      '{}'::jsonb
    )
    INTO compacted
    FROM (
      SELECT ranked.key, ranked.value
      FROM (
        SELECT
          field.key,
          field.value,
          row_number() OVER (
            ORDER BY
              CASE field.key
                WHEN 'type' THEN 1
                WHEN 'toolName' THEN 2
                WHEN 'toolCallId' THEN 3
                WHEN 'state' THEN 4
                WHEN 'status' THEN 5
                WHEN 'ok' THEN 6
                WHEN 'action' THEN 7
                WHEN 'name' THEN 8
                WHEN 'title' THEN 9
                WHEN 'label' THEN 10
                WHEN 'description' THEN 11
                WHEN 'command' THEN 12
                WHEN 'kind' THEN 13
                WHEN 'server' THEN 14
                WHEN 'tool' THEN 15
                WHEN 'path' THEN 16
                WHEN 'file_path' THEN 17
                WHEN 'filePath' THEN 18
                WHEN 'query' THEN 19
                WHEN 'pattern' THEN 20
                WHEN 'url' THEN 21
                WHEN 'detail' THEN 22
                WHEN 'error' THEN 23
                WHEN 'message' THEN 24
                WHEN 'resultCount' THEN 25
                WHEN 'totalUsdMicros' THEN 26
                ELSE 100
              END,
              field.key
          ) AS priority
        FROM jsonb_each(source_value) AS field(key, value)
      ) AS ranked
      WHERE ranked.priority <= 12
    ) AS entry;
    RETURN compacted;
  END IF;

  RETURN source_value;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "goat"."chat_presentation_part_summary_v1"(part jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  part_type text;
  summary jsonb;
  child_summaries jsonb;
BEGIN
  IF part IS NULL OR jsonb_typeof(part) <> 'object' THEN
    RETURN NULL;
  END IF;

  part_type := part ->> 'type';
  IF part_type = 'text' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'type', 'text',
      'text', part -> 'text'
    ));
  END IF;
  IF part_type = 'reasoning' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'type', 'reasoning',
      'text', CASE
        WHEN jsonb_typeof(part -> 'text') = 'string'
        THEN to_jsonb(
          CASE
            WHEN length(part ->> 'text') > 160
            THEN rtrim(left(part ->> 'text', 157)) || '...'
            ELSE part ->> 'text'
          END
        )
        ELSE NULL
      END,
      'state', part -> 'state',
      'presentationSummary', true
    ));
  END IF;
  -- Artifact cards contain already-bounded identifiers and display metadata rather than tool trace
  -- detail, so retain them exactly to keep historical cards renderable before a detail fetch.
  IF part_type = 'data-artifact-file' THEN
    RETURN part;
  END IF;

  IF part_type = 'dynamic-tool' OR part_type LIKE 'tool-%' THEN
    summary := goat.chat_compact_presentation_value_v1(
      part - 'input' - 'output' - 'children' - 'approval' - 'errorText',
      0
    );
    summary := summary || jsonb_strip_nulls(jsonb_build_object(
      'input', goat.chat_compact_presentation_value_v1(part -> 'input', 0),
      'output', goat.chat_compact_presentation_value_v1(part -> 'output', 0),
      'approval', goat.chat_compact_presentation_value_v1(part -> 'approval', 0),
      'errorText', CASE
        WHEN jsonb_typeof(part -> 'errorText') = 'string'
        THEN to_jsonb(left(part ->> 'errorText', 160))
        ELSE NULL
      END,
      'presentationSummary', true
    ));
    IF jsonb_typeof(part -> 'children') = 'array' THEN
      SELECT COALESCE(
        jsonb_agg(goat.chat_presentation_part_summary_v1(child.value) ORDER BY child.ordinality),
        '[]'::jsonb
      )
      INTO child_summaries
      FROM jsonb_array_elements(part -> 'children') WITH ORDINALITY AS child(value, ordinality);
      summary := summary || jsonb_build_object('children', child_summaries);
    END IF;
    RETURN summary;
  END IF;

  RETURN goat.chat_compact_presentation_value_v1(part, 0);
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

UPDATE goat.message_read_model_v1
SET presentation_summary = goat.chat_presentation_summary_v1(presentation);--> statement-breakpoint

-- Mirror the latest Task-aware projector from 0204 and add the summary to the same atomic upsert.
CREATE OR REPLACE FUNCTION "goat"."project_message_read_model_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM goat.message_read_model_v1 WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO goat.message_read_model_v1 (
    id, conversation_id, actor_id, workspace_id, role, content, task_id, presentation,
    presentation_summary, attachments, created_at, updated_at
  )
  SELECT
    NEW.id,
    COALESCE(linked_task.session_id, NEW.session_id),
    conversation.user_workos_id,
    COALESCE(linked_task.workspace_id, conversation_task.workspace_id, runtime.workspace_id),
    NEW.role,
    NEW.content,
    NEW.task_id,
    goat.chat_presentation_v1(NEW.debug_trace),
    goat.chat_presentation_summary_v1(goat.chat_presentation_v1(NEW.debug_trace)),
    goat.chat_attachments_v1(NEW.attachments),
    NEW.created_at,
    NEW.updated_at
  FROM goat.chat_sessions AS conversation
  LEFT JOIN goat.tasks AS conversation_task
    ON conversation_task.session_id = conversation.id
   AND conversation_task.user_workos_id = conversation.user_workos_id
  LEFT JOIN LATERAL (
    SELECT candidate.workspace_id
    FROM goat.codex_chat_sessions AS candidate
    WHERE candidate.chat_session_id = conversation.id
      AND candidate.user_workos_id = conversation.user_workos_id
    ORDER BY candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  ) AS runtime ON true
  LEFT JOIN goat.tasks AS linked_task
    ON conversation.kind = 'task'
   AND linked_task.id = NEW.task_id
   AND linked_task.user_workos_id = conversation.user_workos_id
   AND linked_task.session_id IS NOT NULL
   AND (
     linked_task.workspace_id IS NULL
     OR linked_task.workspace_id = runtime.workspace_id
   )
  WHERE conversation.id = NEW.session_id
    AND conversation.kind IN ('chat', 'task')
  ON CONFLICT (id) DO UPDATE SET
    conversation_id = EXCLUDED.conversation_id,
    actor_id = EXCLUDED.actor_id,
    workspace_id = EXCLUDED.workspace_id,
    role = EXCLUDED.role,
    content = EXCLUDED.content,
    task_id = EXCLUDED.task_id,
    presentation = EXCLUDED.presentation,
    presentation_summary = EXCLUDED.presentation_summary,
    attachments = EXCLUDED.attachments,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;
