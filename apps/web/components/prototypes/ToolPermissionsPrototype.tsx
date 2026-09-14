"use client";

import { Badge } from "@opencompany/ui/components/badge";
import { Button } from "@opencompany/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@opencompany/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { cn } from "@opencompany/ui/lib/utils";
import { ChevronDown, RefreshCw, RotateCcw, Wrench } from "lucide-react";
import { useState } from "react";
import { CapabilityModeToggle } from "@/components/CapabilityModeToggle";
import { ApprovalCard } from "@/components/chat/ApprovalCard";
import { SettingsContent } from "@/components/SettingsChrome";
import { APPROVAL_TOOL_ID, GMAIL_GROUPS } from "./tool-permission-fixture";
import {
  clearGroupOverrides,
  effectiveToolMode,
  groupMode,
  isOverridden,
  MODE_LABELS,
  overriddenToolIds,
  type PrototypeGroup,
  type PrototypeState,
  persistedPayload,
  setGroupMode,
  setToolMode,
  type ToolMode,
} from "./tool-permission-model";

const EMPTY_STATE: PrototypeState = { groups: {}, tools: {} };

const APPROVAL_GROUP = GMAIL_GROUPS.find((group) =>
  group.tools.some((tool) => tool.id === APPROVAL_TOOL_ID),
) as PrototypeGroup;
const APPROVAL_TOOL = APPROVAL_GROUP.tools.find(
  (tool) => tool.id === APPROVAL_TOOL_ID,
) as PrototypeGroup["tools"][number];

export function ToolPermissionsPrototype() {
  const [state, setState] = useState<PrototypeState>(EMPTY_STATE);
  const [approvalChoice, setApprovalChoice] = useState<string | null>(null);

  const reset = () => {
    setState(EMPTY_STATE);
    setApprovalChoice(null);
  };

  return (
    <SettingsContent
      title="Tool-level permissions"
      description="A design prototype for letting one tool be an exception to its group. Nothing here is saved and no real Gmail connection is touched."
      icon={<Wrench className="size-5 text-ink-subtle" />}
      badge={<Badge variant="warning">Prototype</Badge>}
    >
      <ConceptSummary />
      <ToolsSection state={state} setState={setState} />
      <ApprovalSection
        state={state}
        setState={setState}
        choice={approvalChoice}
        onChoose={setApprovalChoice}
      />
      <PersistedSection state={state} onReset={reset} />
    </SettingsContent>
  );
}

function ConceptSummary() {
  return (
    <section className="rounded-xl border border-border bg-surface-muted px-4 py-3.5">
      <h2 className="text-[13px] font-semibold leading-5 text-ink">The group stays the control</h2>
      <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
        Every tool inherits its group, so nothing changes for people who never open the tool list.
        Open it and any single tool can be pinned to <ModeChip>On</ModeChip>,{" "}
        <ModeChip>Ask</ModeChip>, or <ModeChip>Off</ModeChip> — an explicit tool setting wins over
        its group, in both directions. Try putting{" "}
        <span className="font-medium text-ink">Organize Gmail</span> on <ModeChip>On</ModeChip> and
        then pinning <span className="font-medium text-ink">Trash thread</span> to{" "}
        <ModeChip>Ask</ModeChip>.
      </p>
    </section>
  );
}

function ModeChip({ children }: { children: string }) {
  return (
    <span className="rounded bg-surface px-1 py-0.5 font-medium text-ink ring-1 ring-inset ring-border">
      {children}
    </span>
  );
}

function ToolsSection({
  state,
  setState,
}: {
  state: PrototypeState;
  setState: (next: PrototypeState) => void;
}) {
  return (
    <section aria-labelledby="prototype-tools" className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Wrench className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
        <div>
          <h2 id="prototype-tools" className="text-[13px] font-semibold leading-5 text-ink">
            Tools
          </h2>
          <p className="text-[12px] leading-4 text-ink-subtle">
            Choose whether Gmail capabilities run automatically, ask first, or stay unavailable.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5">
        <Badge variant="success">Ready</Badge>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-4 text-ink">17 tools discovered</p>
          <p className="mt-0.5 text-[11px] leading-4 text-ink-faint">
            Tools discovered later inherit their group, so a new read tool never lands unset.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {GMAIL_GROUPS.map((group) => (
          <GroupCard key={group.id} group={group} state={state} setState={setState} />
        ))}
      </div>
    </section>
  );
}

function GroupCard({
  group,
  state,
  setState,
}: {
  group: PrototypeGroup;
  state: PrototypeState;
  setState: (next: PrototypeState) => void;
}) {
  const [open, setOpen] = useState(false);
  const mode = groupMode(state, group);
  const overrides = overriddenToolIds(state, group);
  const toolCount = group.tools.length;

  return (
    <Card className="gap-3 bg-surface py-3 shadow-none">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] px-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-[13px] font-medium leading-5 text-ink">
              {group.label}
            </CardTitle>
            {overrides.length > 0 ? (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="rounded-full border border-border px-1.5 py-0.5 text-[10.5px] font-medium leading-4 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                {overrides.length} custom
              </button>
            ) : null}
          </div>
          <p className="text-[12px] leading-4 text-ink-subtle">{group.description}</p>
        </div>
        <CapabilityModeToggle
          label={group.label}
          mode={mode}
          onChange={(next) => setState(setGroupMode(state, group, next))}
        />
      </CardHeader>
      <CardContent className="px-3">
        {overrides.length > 0 ? (
          // Changing the group never silently discards an explicit tool decision; it says what
          // stayed behind and offers the one-click undo.
          <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[11.5px] leading-4 text-ink-muted">
            {overrides.length === 1
              ? "1 tool keeps its own setting"
              : `${overrides.length} tools keep their own setting`}
            <button
              type="button"
              onClick={() => setState(clearGroupOverrides(state, group))}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <RotateCcw className="size-3" />
              Reset to group
            </button>
          </p>
        ) : null}
        <div className="rounded-md border border-border/70">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-muted"
          >
            {toolCount} {toolCount === 1 ? "tool" : "tools"}
            {overrides.length > 0 ? (
              <span className="text-ink-faint">· {overrides.length} custom</span>
            ) : null}
            <ChevronDown
              className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
            />
          </button>
          {open ? (
            <div className="border-t border-border/70 p-2">
              <ul className="overflow-hidden rounded-md border border-border/70">
                {group.tools.map((tool) => (
                  <li
                    key={tool.id}
                    className="flex items-start justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-4 text-ink">{tool.name}</p>
                      <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                        {tool.description}
                      </p>
                    </div>
                    <ToolModeSelect
                      group={group}
                      toolId={tool.id}
                      toolName={tool.name}
                      state={state}
                      setState={setState}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The trigger always shows the mode the tool actually runs in, so the column can be read top to
 * bottom. Muted means inherited; full ink with a dot means this row was set by hand.
 */
function ToolModeSelect({
  group,
  toolId,
  toolName,
  state,
  setState,
}: {
  group: PrototypeGroup;
  toolId: string;
  toolName: string;
  state: PrototypeState;
  setState: (next: PrototypeState) => void;
}) {
  const effective = effectiveToolMode(state, group, toolId);
  const overridden = isOverridden(state, toolId);
  const inherited = groupMode(state, group);

  return (
    <Select
      value={overridden ? effective : "inherit"}
      onValueChange={(next) => setState(setToolMode(state, group, toolId, next as ToolMode))}
    >
      <SelectTrigger
        aria-label={`Permission for ${toolName}`}
        className={cn(
          "h-7 w-[106px] shrink-0 gap-1.5 px-2 text-[12px]",
          overridden ? "text-ink" : "border-transparent bg-transparent text-ink-subtle shadow-none",
        )}
      >
        <SelectValue>
          <span className="flex items-center gap-1.5">
            {overridden ? <span className="size-1.5 rounded-full bg-ink-muted" /> : null}
            {MODE_LABELS[effective]}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">Use group ({MODE_LABELS[inherited]})</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="ask">Ask</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ApprovalSection({
  state,
  setState,
  choice,
  onChoose,
}: {
  state: PrototypeState;
  setState: (next: PrototypeState) => void;
  choice: string | null;
  onChoose: (choice: string | null) => void;
}) {
  const siblingCount = APPROVAL_GROUP.tools.length - 1;

  const decide = (next: string) => {
    onChoose(next);
    if (next === "always_tool") {
      setState(setToolMode(state, APPROVAL_GROUP, APPROVAL_TOOL_ID, "on"));
    } else if (next === "always_group") {
      setState(setGroupMode(state, APPROVAL_GROUP, "on"));
    }
  };

  return (
    <section aria-labelledby="prototype-approval" className="flex flex-col gap-3">
      <div>
        <h2 id="prototype-approval" className="text-[13px] font-semibold leading-5 text-ink">
          The same change in chat
        </h2>
        <p className="text-[12px] leading-4 text-ink-subtle">
          Today one “Always allow” turns on the whole group. Decide here and watch the settings
          above move.
        </p>
      </div>
      <ApprovalCard
        testId="prototype-action-approval"
        approvalId="prototype"
        presentation={{
          kind: "integration",
          source: "Gmail",
          question: "Label this thread “Investors”?",
          description: APPROVAL_TOOL.description,
          code: null,
          paths: [],
          lines: [
            { label: "Thread", value: "Re: Seed round — next steps" },
            { label: "Label", value: "Investors" },
          ],
        }}
        allow={[
          {
            id: "always_group",
            label: `Always allow ${APPROVAL_GROUP.label}`,
            busyLabel: "Saving...",
          },
          { id: "always_tool", label: "Always allow this tool", busyLabel: "Saving..." },
          { id: "once", label: "Allow once", busyLabel: "Allowing...", hint: "↵" },
        ]}
        deny={{ id: "decline", label: "Deny", busyLabel: "Denying...", hint: "Esc" }}
        onChoose={decide}
        submitting={null}
        error={null}
      />
      <p className="text-[12px] leading-5 text-ink-muted">
        {choice === "always_tool" ? (
          <>
            <span className="font-medium text-ink">Label thread</span> is now On. The other{" "}
            {siblingCount} tools in {APPROVAL_GROUP.label} — including{" "}
            <span className="font-medium text-ink">Trash thread</span> — still ask.
          </>
        ) : choice === "always_group" ? (
          <>
            All {APPROVAL_GROUP.tools.length} {APPROVAL_GROUP.label} tools are now On, including{" "}
            <span className="font-medium text-ink">Trash thread</span> and{" "}
            <span className="font-medium text-ink">Trash message</span>. This is what today’s single
            “Always allow” does.
          </>
        ) : choice === "once" ? (
          <>Allowed once. Nothing was saved, so the next label write asks again.</>
        ) : choice === "decline" ? (
          <>Denied. Nothing was saved.</>
        ) : (
          <>
            Today this card offers one “Always allow”, and it grants all{" "}
            {APPROVAL_GROUP.tools.length} {APPROVAL_GROUP.label} tools.
          </>
        )}
      </p>
    </section>
  );
}

function PersistedSection({ state, onReset }: { state: PrototypeState; onReset: () => void }) {
  const payload = persistedPayload(state);
  const empty = Object.keys(payload).length === 0;

  return (
    <section aria-labelledby="prototype-persisted" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="prototype-persisted" className="text-[13px] font-semibold leading-5 text-ink">
            What gets saved
          </h2>
          <p className="text-[12px] leading-4 text-ink-subtle">
            The existing <code className="font-mono text-[11.5px]">capability_modes</code> jsonb,
            plus a <code className="font-mono text-[11.5px]">tools</code> key. Defaults and
            inherited tools write nothing, so no migration is needed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onReset}>
          <RotateCcw />
          Reset
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-surface-muted px-3 py-2.5 font-mono text-[11.5px] leading-5 text-ink/80 ring-1 ring-inset ring-border-subtle">
        {empty ? "{}  // untouched connection stores nothing" : JSON.stringify(payload, null, 2)}
      </pre>
    </section>
  );
}
