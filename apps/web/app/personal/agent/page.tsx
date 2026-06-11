"use client";

import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalBehaviorEditor } from "@/components/personal/PersonalBehaviorEditor";

// The agent's editable `.agent` body. Seeds from the live draft held in the layout so leaving and
// re-entering this route keeps in-flight edits; keystrokes flow back up via setDraft.
export default function PersonalAgentPage() {
  const { agent, config, getDraft, setConfig, setDraft } = usePersonalAgent();
  const draft = getDraft();

  return (
    <div className="h-full overflow-y-auto">
      <PersonalBehaviorEditor
        agentId={agent.id}
        initialBody={draft.body || config.instructions}
        initialContent={draft.content}
        config={config}
        onConfigChange={setConfig}
        onDraftChange={setDraft}
      />
    </div>
  );
}
