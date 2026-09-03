-- Text parts produced by coding engines carry a stable itemId that separates assistant progress
-- updates from the final response. Preserve that semantic boundary in the bounded Electric
-- projection instead of forcing the client to infer messages from adjacency.
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
      'text', part -> 'text',
      'itemId', part -> 'itemId'
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

-- Refresh only rows whose full presentation contains the boundary that older summaries dropped.
WITH refreshed AS (
  SELECT
    message.id,
    goat.chat_presentation_summary_v1(message.presentation) AS presentation_summary
  FROM goat.message_read_model_v1 AS message
  WHERE message.presentation IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(message.presentation -> 'uiMessageParts') = 'array'
          THEN message.presentation -> 'uiMessageParts'
          ELSE '[]'::jsonb
        END
      ) AS part(value)
      WHERE part.value ->> 'type' = 'text'
        AND jsonb_typeof(part.value -> 'itemId') = 'string'
    )
)
UPDATE goat.message_read_model_v1 AS message
SET presentation_summary = refreshed.presentation_summary
FROM refreshed
WHERE message.id = refreshed.id
  AND message.presentation_summary IS DISTINCT FROM refreshed.presentation_summary;
