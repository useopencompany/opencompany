"use client";

import { Button } from "@opencompany/ui/components/button";
import { Label } from "@opencompany/ui/components/label";
import { Textarea } from "@opencompany/ui/components/textarea";
import { Send } from "@opencompany/ui/icons";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { GoatModelOption } from "@/lib/model-options";
import { createGoatTaskAction, type TaskFormState } from "@/lib/tasks";

const INITIAL_STATE: TaskFormState = {
  ok: false,
  error: null,
};

export function TaskComposer({
  models,
  defaultModel,
}: {
  models: readonly GoatModelOption[];
  defaultModel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(createGoatTaskAction, INITIAL_STATE);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
    }
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="prompt">Task</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={5}
          placeholder="Ask Goat to research, compare, or produce a first pass."
          className="min-h-32 resize-y text-sm"
          maxLength={10_000}
          required
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2 sm:min-w-72">
          <Label htmlFor="model">Model</Label>
          <select
            id="model"
            name="model"
            defaultValue={defaultModel}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
        <SubmitButton />
      </div>

      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full sm:w-auto">
      <Send className="size-4" />
      {pending ? "Starting" : "Start task"}
    </Button>
  );
}
