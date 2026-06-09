"use client";

import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalCapabilityPanel } from "@/components/personal/PersonalCapabilityPanel";

export default function PersonalSkillsPage() {
  const { config, personalSkills, githubRequested, githubIntegrationStatus } = usePersonalAgent();

  return (
    <div className="h-full overflow-y-auto">
      <PersonalCapabilityPanel
        section="skills"
        config={config}
        personalSkills={personalSkills}
        githubRequested={githubRequested}
        githubStatus={githubIntegrationStatus}
      />
    </div>
  );
}
