"use client";

import type { useWorkflowComposer } from "@/components/chat/useWorkflowComposer";
import { StepCloudRuntimeControls, StepRuntimePicker } from "@/components/WorkflowModelControls";
import {
  isWorkflowCloudRuntime,
  resolveWorkflowStepModelSelection,
  WORKFLOW_MODEL_OPTIONS,
  workflowStepSettings,
} from "@/lib/workflow-model-options";

export function WorkflowComposerControls({
  selection,
  disabled,
}: {
  selection: ReturnType<typeof useWorkflowComposer>;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Workflow models">
      {selection.steps.map((step, index) => {
        let token = step.model;
        try {
          const resolved = resolveWorkflowStepModelSelection(step);
          token =
            WORKFLOW_MODEL_OPTIONS.find(
              (option) =>
                option.engine === resolved.engine &&
                (option.engine !== "opencompany" || option.id === resolved.model),
            )?.token ?? token;
        } catch {
          // Keep the picker available so an unavailable saved model can be replaced for this run.
        }
        const option = WORKFLOW_MODEL_OPTIONS.find((option) => option.token === token);
        return (
          <div key={step.id} className="flex flex-wrap items-center gap-1">
            {selection.steps.length > 1 ? (
              <span className="text-[11.5px] text-ink-subtle" title={step.title}>
                Step {index + 1}
              </span>
            ) : null}
            <StepRuntimePicker
              value={token}
              disabled={disabled}
              onChange={(model) => {
                selection.update({
                  id: step.id,
                  title: step.title,
                  instructions: step.instructions,
                  ...workflowStepSettings({ model }),
                });
              }}
            />
            {option && isWorkflowCloudRuntime(option.engine) ? (
              <StepCloudRuntimeControls
                engine={option.engine}
                step={{ ...step, model: token }}
                disabled={disabled}
                compact
                onChange={(patch) => selection.update({ ...step, model: token, ...patch })}
              />
            ) : null}
          </div>
        );
      })}
      <span className="text-[11.5px] text-ink-subtle">
        {selection.overrides.length ? "This run only" : "Workflow defaults"}
      </span>
      {selection.overrides.length ? (
        <button
          type="button"
          disabled={disabled}
          onClick={selection.reset}
          className="rounded-md px-1 text-[11.5px] text-ink-subtle hover:text-ink focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Reset
        </button>
      ) : null}
      {selection.error ? (
        <span role="alert" className="text-[12px] text-danger">
          {selection.error}
        </span>
      ) : null}
    </div>
  );
}
