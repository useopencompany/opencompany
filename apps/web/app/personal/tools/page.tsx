"use client";

import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalCapabilityPanel } from "@/components/personal/PersonalCapabilityPanel";

export default function PersonalToolsPage() {
  const { config, personalSkills, githubRequested, githubIntegrationStatus, addTool } =
    usePersonalAgent();

  return (
    <div className="h-full overflow-y-auto">
      <PersonalCapabilityPanel
        section="tools"
        config={config}
        personalSkills={personalSkills}
        githubRequested={githubRequested}
        githubStatus={githubIntegrationStatus}
        onAddTool={addTool}
      />
    </div>
  );
}
