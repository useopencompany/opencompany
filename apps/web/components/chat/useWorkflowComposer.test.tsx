import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkflowCatalogItem } from "@/lib/headless-automation-types";
import { useWorkflowComposer } from "./useWorkflowComposer";

const workflow: WorkflowCatalogItem = {
  id: "ship",
  name: "Ship",
  description: "",
  steps: [
    {
      id: "build",
      title: "Build",
      model: "codex",
      runtimeModel: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      instructions: "Build.",
    },
    { id: "review", title: "Review", model: "glm-5.2", instructions: "Review." },
  ],
};

describe("workflow composer selection", () => {
  it("checks every selected step and drops cloud settings when switching to a gateway model", () => {
    const { result } = renderHook(() => useWorkflowComposer(workflow));
    expect(result.current.capabilities.images).toBe(false);
    expect(result.current.requiresCredits).toBe(true);
    act(() => result.current.update({ ...workflow.steps[1]!, model: "gpt-5.5" }));
    expect(result.current.capabilities.images).toBe(true);
    act(() =>
      result.current.update({
        id: "build",
        title: "Build",
        instructions: "Build.",
        model: "gpt-5.5",
      }),
    );
    expect(result.current.steps[0]).not.toHaveProperty("runtimeModel");
    expect(result.current.steps[0]).not.toHaveProperty("reasoningEffort");
    expect(workflow.steps[0]?.model).toBe("codex");
    act(() => result.current.reset());
    expect(result.current.steps).toEqual(workflow.steps);
  });

  it("resets overrides when the workflow is removed or replaced", () => {
    const { result, rerender } = renderHook(({ selected }) => useWorkflowComposer(selected), {
      initialProps: { selected: workflow as WorkflowCatalogItem | null },
    });
    act(() => result.current.update({ ...workflow.steps[1]!, model: "gpt-5.5" }));
    rerender({ selected: null });
    rerender({ selected: workflow });
    expect(result.current.overrides).toEqual([]);
    act(() => result.current.update({ ...workflow.steps[1]!, model: "gpt-5.5" }));
    rerender({ selected: { ...workflow, id: "other" } });
    expect(result.current.overrides).toEqual([]);
  });

  it("resolves legacy inline models and revalidates already uploaded files after overrides", () => {
    const { result } = renderHook(() =>
      useWorkflowComposer({
        ...workflow,
        steps: [{ id: "build", title: "Build", model: "", instructions: "Use @codex to build." }],
      }),
    );
    expect(result.current.requiresCredits).toBe(false);
    expect(result.current.capabilities).toEqual({ images: true, pdf: true });
    act(() => result.current.update({ ...result.current.steps[0]!, model: "glm-5.2" }));
    expect(result.current.attachmentError([{ kind: "image" }])).toContain("can't read images");
  });
});
