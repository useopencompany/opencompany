"use client";

import {
  AlertCircle,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDotDashed,
  Clock,
  FileText,
  Square,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import {
  CODEX_COMMAND_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  type CodexCommandToolOutput,
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  GOAT_BRAIN_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
} from "@/lib/chat-ui";
import {
  formatDebugValue,
  isGoatBrainToolOutput,
  isRecord,
  type ToolCallView,
} from "./assistant-items";

export type CodexToolAction =
  | { type: "implement-plan" }
  | { type: "continue-plan" }
  | {
      type: "answer-question";
      interactionId: string;
      answers: Record<string, { answers: string[] }>;
    };

export function ToolCallItem({
  tool,
  onCodexAction,
  allowCodexPlanActions = false,
}: {
  tool: ToolCallView;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  allowCodexPlanActions?: boolean;
}) {
  if (tool.name === GOAT_BRAIN_TOOL_NAME) {
    return <BrainToolCallRow tool={tool} />;
  }
  if (tool.name === CODEX_COMMAND_TOOL_NAME) {
    return <CodexCommandRow tool={tool} />;
  }
  if (tool.name === CODEX_PLAN_TOOL_NAME && planImplementationAvailable(tool)) {
    return (
      <CodexPlanRow tool={tool} onAction={allowCodexPlanActions ? onCodexAction : undefined} />
    );
  }
  if (tool.name === CODEX_QUESTION_TOOL_NAME && codexQuestionInput(tool.input)) {
    return <CodexQuestionRow tool={tool} onAction={onCodexAction} />;
  }
  return <ToolCallRow tool={tool} />;
}

function CodexPlanRow({
  tool,
  onAction,
}: {
  tool: ToolCallView;
  onAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const output = isRecord(tool.output) ? tool.output : {};
  const text = typeof output.text === "string" ? output.text.trim() : "";
  const run = (action: CodexToolAction) => {
    if (!onAction || submitting) return;
    setError(null);
    setSubmitting(true);
    void onAction(action)
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not continue from this plan.");
      })
      .finally(() => setSubmitting(false));
  };
  return (
    <div
      data-testid="chat-codex-plan-implementation"
      className="max-w-[92%] rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
    >
      <div className="text-[12px] font-semibold text-ink">Implement this plan?</div>
      {text ? (
        <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-ink-muted">
          {text}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!onAction || submitting}
          onClick={() => run({ type: "implement-plan" })}
          className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Starting..." : "Implement plan"}
        </button>
        <button
          type="button"
          disabled={!onAction || submitting}
          onClick={() => run({ type: "continue-plan" })}
          className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:bg-surface-hover disabled:opacity-50"
        >
          Keep planning
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type CodexQuestion = {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  isOther: boolean;
  options: Array<{ label: string; description: string }>;
};

function CodexQuestionRow({
  tool,
  onAction,
}: {
  tool: ToolCallView;
  onAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
}) {
  const input = codexQuestionInput(tool.input);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!input || tool.status !== "waiting") return <ToolCallRow tool={tool} />;

  const submit = () => {
    if (!onAction || submitting || submitted) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of input.questions) {
      const selectedAnswer = selected[question.id]?.trim();
      const note = custom[question.id]?.trim();

      // A question without options is pure free text: the text field is the answer itself,
      // not an annotation on a selected option, so it must not carry the `user_note:` prefix.
      if (question.options.length === 0) {
        if (!note) {
          setError("Answer each question before continuing.");
          return;
        }
        answers[question.id] = { answers: [note] };
        continue;
      }

      // "Other" is a client-side affordance, not an option Codex offered. The note describes the
      // custom choice, so require it and send it as the answer instead of the literal "Other".
      if (selectedAnswer === "Other") {
        if (!note) {
          setError("Describe your Other answer before continuing.");
          return;
        }
        answers[question.id] = { answers: [note] };
        continue;
      }

      if (!selectedAnswer) {
        setError("Answer each question before continuing.");
        return;
      }
      answers[question.id] = {
        answers: [selectedAnswer, ...(note ? [`user_note: ${note}`] : [])],
      };
    }
    setError(null);
    setSubmitting(true);
    void onAction({
      type: "answer-question",
      interactionId: input.interactionId,
      answers,
    })
      .then(() => setSubmitted(true))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not send your answer.");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div
      data-testid="chat-codex-question"
      className="max-w-[92%] rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
    >
      <div className="text-[12px] font-semibold text-ink">Codex needs your input</div>
      {input.autoResolutionMs !== null ? (
        <p className="mt-1 text-[11px] text-ink-subtle">
          Codex will continue automatically if this question expires.
        </p>
      ) : null}
      <div className="mt-3 space-y-4">
        {input.questions.map((question) => (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-[12px] font-medium leading-5 text-ink">
              {question.header ? `${question.header}: ` : ""}
              {question.question}
            </legend>
            {question.options.length > 0 ? (
              <div className="grid gap-1.5">
                {question.options.map((option) => {
                  const checked = selected[question.id] === option.label;
                  return (
                    <label
                      key={option.label}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-[12px] hover:bg-surface-hover"
                    >
                      <input
                        type="radio"
                        name={`codex-question-${input.interactionId}-${question.id}`}
                        checked={checked}
                        onChange={() => {
                          setSelected((current) => ({ ...current, [question.id]: option.label }));
                        }}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-medium text-ink">{option.label}</span>
                        {option.description ? (
                          <span className="block leading-4 text-ink-subtle">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                {question.isOther ? (
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-[12px] hover:bg-surface-hover">
                    <input
                      type="radio"
                      name={`codex-question-${input.interactionId}-${question.id}`}
                      checked={selected[question.id] === "Other"}
                      onChange={() => {
                        setSelected((current) => ({ ...current, [question.id]: "Other" }));
                      }}
                      className="mt-0.5"
                    />
                    <span className="font-medium text-ink">Other</span>
                  </label>
                ) : null}
              </div>
            ) : null}
            <input
              type={question.isSecret ? "password" : "text"}
              value={custom[question.id] ?? ""}
              onChange={(event) =>
                setCustom((current) => ({ ...current, [question.id]: event.target.value }))
              }
              placeholder={
                question.options.length > 0
                  ? question.isOther
                    ? "Optional note or describe Other"
                    : "Optional note"
                  : "Your answer"
              }
              maxLength={4_000}
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-canvas px-2.5 py-2 text-[12px] text-ink outline-none focus:border-border-strong"
            />
          </fieldset>
        ))}
      </div>
      {error ? (
        <p className="mt-2 text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!onAction || submitting || submitted}
        onClick={submit}
        className="mt-3 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "Sending..." : submitted ? "Answer sent" : "Send answer"}
      </button>
    </div>
  );
}

function planImplementationAvailable(tool: ToolCallView) {
  return isRecord(tool.output) && tool.output.implementationAvailable === true;
}

function codexQuestionInput(
  value: unknown,
): { interactionId: string; questions: CodexQuestion[]; autoResolutionMs: number | null } | null {
  if (!isRecord(value) || typeof value.interactionId !== "string") return null;
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  const questions: CodexQuestion[] = [];
  for (const raw of rawQuestions) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.question !== "string") continue;
    const options = Array.isArray(raw.options)
      ? raw.options.filter(isRecord).flatMap((option) =>
          typeof option.label === "string"
            ? [
                {
                  label: option.label,
                  description: typeof option.description === "string" ? option.description : "",
                },
              ]
            : [],
        )
      : [];
    questions.push({
      id: raw.id,
      header: typeof raw.header === "string" ? raw.header : "",
      question: raw.question,
      isSecret: raw.isSecret === true,
      isOther: raw.isOther === true,
      options,
    });
  }
  return questions.length > 0
    ? {
        interactionId: value.interactionId,
        questions,
        autoResolutionMs:
          typeof value.autoResolutionMs === "number" ? value.autoResolutionMs : null,
      }
    : null;
}

function ToolCallRow({ tool }: { tool: ToolCallView }) {
  const meta = getToolCallMeta(tool);
  const Icon = meta.icon;
  return (
    <div
      data-testid={`chat-tool-call-${tool.name}`}
      className="flex max-w-[80%] items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
    >
      <Icon
        size={14}
        strokeWidth={2}
        className={`shrink-0 ${meta.className} ${meta.spin ? "animate-[spin_3s_linear_infinite]" : ""}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium leading-4 text-ink">{tool.label}</span>
          <span className={`${meta.className} shrink-0 text-[11px] leading-4`}>
            {tool.statusText}
          </span>
        </div>
        {tool.detail ? <p className="truncate leading-4 text-ink-subtle">{tool.detail}</p> : null}
      </div>
    </div>
  );
}

function BrainToolCallRow({ tool }: { tool: ToolCallView }) {
  const [expanded, setExpanded] = useState(false);
  const detail = tool.detail ?? "goat_brain";
  const commandPreview = brainOutputCommand(tool.output);
  const stdoutPreview = brainOutputStdout(tool.output);
  const parsedPreview = brainOutputParsed(tool.output);
  const stderrPreview = brainOutputStderr(tool.output);
  const errorPreview = brainOutputError(tool.output, tool.errorText);
  return (
    <div
      data-testid={`chat-tool-call-${tool.name}`}
      className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
            <BookOpen size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 font-medium text-ink/65">Brain</span>
          <span
            title={detail}
            className="inline-flex min-w-0 max-w-[min(440px,calc(100vw-180px))] items-center rounded bg-ink/5 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink/55"
          >
            <span className="min-w-0 truncate">{detail}</span>
          </span>
          <BrainStatusText status={tool.status} />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          <BrainPreviewBlock label="Input" value={formatDebugValue(tool.input)} />
          {commandPreview ? <BrainPreviewBlock label="Command" value={commandPreview} /> : null}
          {stdoutPreview ? <BrainPreviewBlock label="Stdout" value={stdoutPreview} /> : null}
          {parsedPreview ? <BrainPreviewBlock label="Parsed" value={parsedPreview} /> : null}
          {stderrPreview ? <BrainPreviewBlock label="Stderr" value={stderrPreview} /> : null}
          {errorPreview ? <BrainPreviewBlock label="Error" value={errorPreview} /> : null}
          {!isGoatBrainToolOutput(tool.output) && !tool.errorText ? (
            <div className="py-1 text-[11px] text-ink-subtle">Waiting for result</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CodexCommandRow({ tool }: { tool: ToolCallView }) {
  const [expanded, setExpanded] = useState(false);
  const command =
    isRecord(tool.input) && typeof tool.input.command === "string"
      ? tool.input.command
      : (tool.detail ?? CODEX_COMMAND_TOOL_NAME);
  const output = isCodexCommandToolOutput(tool.output) ? tool.output : null;
  const outputPreview = output?.outputPreview?.trim() ? output.outputPreview : null;
  return (
    <div
      data-testid={`chat-tool-call-${tool.name}`}
      className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
            <Terminal size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 font-medium text-ink/65">Command</span>
          <span
            title={command}
            className="inline-flex min-w-0 max-w-[min(440px,calc(100vw-180px))] items-center rounded bg-ink/5 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink/55"
          >
            <span className="min-w-0 truncate">{command}</span>
          </span>
          <CodexCommandStatusText tool={tool} output={output} />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          {outputPreview ? (
            <BrainPreviewBlock label="Output" value={outputPreview} />
          ) : (
            <div className="py-1 text-[11px] text-ink-subtle">
              {output || tool.errorText ? "No output" : "Waiting for result"}
            </div>
          )}
          {tool.errorText?.trim() ? (
            <BrainPreviewBlock label="Error" value={tool.errorText} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CodexCommandStatusText({
  tool,
  output,
}: {
  tool: ToolCallView;
  output: CodexCommandToolOutput | null;
}) {
  const status = codexCommandStatus(tool, output);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
        status.kind === "failed" ? "text-danger" : "text-ink-subtle"
      }`}
    >
      {status.kind === "failed" ? (
        <AlertCircle size={9} strokeWidth={1.9} />
      ) : status.kind === "running" ? (
        <CircleDotDashed
          size={9}
          strokeWidth={2}
          className="animate-[spin_3s_linear_infinite] text-warning"
        />
      ) : null}
      {status.text}
    </span>
  );
}

function codexCommandStatus(
  tool: ToolCallView,
  output: CodexCommandToolOutput | null,
): { text: string; kind: "running" | "done" | "failed" | "stopped" } {
  if (tool.status === "failed" || output?.status === "failed") {
    return { text: "Failed", kind: "failed" };
  }
  if (tool.status === "stopped" || output?.status === "interrupted") {
    return { text: "Stopped", kind: "stopped" };
  }
  if (tool.status === "completed") {
    const exitSuffix =
      typeof output?.exitCode === "number" && output.exitCode !== 0
        ? ` (exit ${output.exitCode})`
        : "";
    return { text: `Done${exitSuffix}`, kind: "done" };
  }
  return { text: "Running", kind: "running" };
}

function isCodexCommandToolOutput(value: unknown): value is CodexCommandToolOutput {
  if (!isRecord(value)) return false;
  return (
    (value.status === "completed" || value.status === "failed" || value.status === "interrupted") &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    (typeof value.outputPreview === "string" || value.outputPreview === undefined)
  );
}

function BrainStatusText({ status }: { status: ToolCallView["status"] }) {
  if (status === "completed") return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
        status === "failed" ? "text-danger" : "text-ink-subtle"
      }`}
    >
      {status === "failed" ? (
        <AlertCircle size={9} strokeWidth={1.9} />
      ) : (
        <CircleDotDashed
          size={9}
          strokeWidth={2}
          className="animate-[spin_3s_linear_infinite] text-warning"
        />
      )}
      {status}
    </span>
  );
}

function BrainPreviewBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1 first:pt-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-ink-subtle">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
        {value}
      </pre>
    </div>
  );
}

function brainOutputCommand(value: unknown) {
  if (!isGoatBrainToolOutput(value)) return null;
  const lines: string[] = [];
  if (value.command) lines.push(`goat_brain ${value.command}`);
  if (Array.isArray(value.argv)) lines.push(`argv: ${JSON.stringify(value.argv)}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

function brainOutputStdout(value: unknown) {
  return isGoatBrainToolOutput(value) && value.stdout?.trim() ? value.stdout : null;
}

function brainOutputStderr(value: unknown) {
  return isGoatBrainToolOutput(value) && value.stderr?.trim() ? value.stderr : null;
}

function brainOutputParsed(value: unknown) {
  return isGoatBrainToolOutput(value) && value.parsed !== undefined
    ? formatDebugValue(value.parsed)
    : null;
}

function brainOutputError(value: unknown, errorText: string | null) {
  if (errorText?.trim()) return errorText;
  return isGoatBrainToolOutput(value) && value.error?.trim() ? value.error : null;
}

function getToolCallMeta(tool: ToolCallView): {
  icon: typeof FileText;
  className: string;
  spin: boolean;
} {
  if (tool.status === "failed") {
    return { icon: AlertCircle, className: "text-danger", spin: false };
  }
  if (tool.status === "completed") {
    return { icon: CheckCircle2, className: "text-emerald-600", spin: false };
  }
  if (tool.status === "waiting") {
    return { icon: Clock, className: "text-ink-subtle", spin: false };
  }
  if (tool.status === "stopped") {
    return { icon: Square, className: "text-ink-subtle", spin: false };
  }
  return {
    icon:
      tool.name === GOAT_BRAIN_TOOL_NAME
        ? BookOpen
        : tool.name === SCHEDULE_TASK_TOOL_NAME ||
            tool.name === EDIT_TASK_SCHEDULE_TOOL_NAME ||
            tool.name === DELETE_TASK_SCHEDULE_TOOL_NAME
          ? CalendarClock
          : CircleDotDashed,
    className: "text-amber-500",
    spin:
      tool.name !== GOAT_BRAIN_TOOL_NAME &&
      tool.name !== SCHEDULE_TASK_TOOL_NAME &&
      tool.name !== EDIT_TASK_SCHEDULE_TOOL_NAME &&
      tool.name !== DELETE_TASK_SCHEDULE_TOOL_NAME,
  };
}
