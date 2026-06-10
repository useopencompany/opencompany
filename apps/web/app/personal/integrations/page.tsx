"use client";

import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalCapabilityPanel } from "@/components/personal/PersonalCapabilityPanel";

export default function PersonalIntegrationsPage() {
  const {
    config,
    personalSkills,
    githubRequested,
    githubIntegrationStatus,
    integrationConnections,
    toolPolicies,
    addIntegration,
  } = usePersonalAgent();

  return (
    <div className="h-full overflow-y-auto">
      <PersonalCapabilityPanel
        section="integrations"
        config={config}
        personalSkills={personalSkills}
        githubRequested={githubRequested}
        githubStatus={githubIntegrationStatus}
        connections={integrationConnections}
        toolPolicies={toolPolicies}
        onAddIntegration={addIntegration}
      />
    </div>
  );
}
