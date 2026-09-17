import { jsonSchema, type ToolSet } from "ai";
import {
  WORKFLOWS_FLAT_INPUT_SCHEMA,
  WorkflowCommandSchema,
  workflowCommandToToolInput,
} from "../src/workflow-tool";
import type { Variant } from "./types";

// The winning grouped shape is the production tool. Candidates translate only
// arguments; they still execute its production parser and dispatcher.
export function applyWorkflowVariant(tools: ToolSet, variant: Variant) {
  const original = tools.workflows;
  if (!original?.execute || variant === "workflow-grouped" || variant === "v5") return;
  const execute = original.execute;
  const { command, workflowId, expectedVersion, cursor, prompt, ...fields } =
    WORKFLOWS_FLAT_INPUT_SCHEMA.properties;
  if (variant === "workflow-flat") {
    tools.workflows = {
      description: original.description ?? "",
      inputSchema: jsonSchema(WORKFLOWS_FLAT_INPUT_SCHEMA),
      execute: (args, context) =>
        execute(workflowCommandToToolInput(WorkflowCommandSchema.parse(args)), context),
    };
  } else if (variant === "workflow-describe") {
    tools.workflows = {
      description: `${original.description} Before create/update, call command fields to learn the writable fields. Supply them in the workflow object.`,
      inputSchema: jsonSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string", enum: [...command.enum, "fields"] },
          workflowId,
          expectedVersion,
          cursor,
          prompt,
          workflow: { type: "object", additionalProperties: true },
        },
        required: ["command"],
      }),
      execute: (args, context) => {
        if ((args as Record<string, unknown>).command === "fields") return { fields };
        return execute(args, context);
      },
    };
  }
}
