"use client";

import type { ResolvedSkillMetadata } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentToolId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { createContext, useContext } from "react";
import type { PersonalGitHubIntegrationStatus } from "@/components/personal/PersonalCapabilityPanel";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";
import type { GitHubIntegrationRepositoryPayload } from "@/lib/agents/payload";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import type { PersonalIntegrationDetails } from "@/lib/personal/integration-details";
import type { PersonalIntegrationConnections } from "@/lib/personal/integrations-catalog";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

// The immutable identity of the personal agent the surface is rendering. Mutable surfaces
// (config, behavior body) live as context state below, not here.
export type PersonalAgent = {
  id: string;
  name: string;
  defaultModel: string;
  path: string | null;
  config: AgentConfig;
  body: string;
  content: TiptapDoc;
};

// Shared state for the whole /personal surface. The layout-level provider (PersonalShell) keeps
// this mounted across route changes so config edits, the behavior draft, the file list, and the
// github-requested flag survive soft navigation between sub-routes without a server round-trip.
export type PersonalAgentContextValue = {
  agent: PersonalAgent;
  bundleDir: string | null;
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialSessions: SidebarSessionPayload[];
  personalSkills: ResolvedSkillMetadata[];
  githubIntegrationStatus: PersonalGitHubIntegrationStatus;
  // The workspace GitHub integration's usable repository catalog (loaded once at layout
  // mount), so the Behavior editor can offer concrete @owner/repo mention items.
  githubRepositories: GitHubIntegrationRepositoryPayload[];
  // Workspace-level connection state per integration, used to render Connected/Connect badges.
  integrationConnections: PersonalIntegrationConnections;
  // Per-integration accounts/resources/permissions detail for the expandable Integrations rows.
  integrationDetails: PersonalIntegrationDetails;
  // Workspace-level tool permission overrides, used by the personal Integrations tab.
  toolPolicies: WorkspaceToolPolicyOverrides;

  config: AgentConfig;
  setConfig: (config: AgentConfig) => void;

  githubRequested: boolean;

  // Per-user "Pro mode" switch (advanced surfaces, e.g. the Memory inspector). Seeded from the DB
  // at layout load; setProMode flips it optimistically so the sidebar updates without a reload.
  proMode: boolean;
  setProMode: (next: boolean) => void;

  // Per-user opt-in to the legacy company/workspace surface. Seeded from the DB at layout load;
  // the setter flips it optimistically so the sidebar's space switcher updates without a reload.
  companySurfaceEnabled: boolean;
  setCompanySurfaceEnabled: (next: boolean) => void;

  // The behavior editor's live draft. Held as a ref-backed getter (not state) because only the
  // Behavior route reads it, and only at mount — it must not trigger re-renders elsewhere.
  getDraft: () => { body: string; content: TiptapDoc };
  // Push the latest behavior body/doc up so it survives leaving and re-entering /personal/agent.
  setDraft: (body: string, content: TiptapDoc) => void;

  files: AgentBundleFilePayload[];
  upsertFile: (file: AgentBundleFilePayload) => void;

  // Append an integration's @-mention to the agent body server-side, then re-seed config + draft.
  addIntegration: (integration: PersonalIntegrationId) => Promise<boolean>;
  // Append a tool or skill @-mention to the personal agent body, then re-seed config + draft.
  addTool: (toolId: AgentToolId) => Promise<void>;
  addSkill: (skillId: string) => Promise<void>;
};

const PersonalAgentContext = createContext<PersonalAgentContextValue | null>(null);

export function PersonalAgentProvider({
  value,
  children,
}: {
  value: PersonalAgentContextValue;
  children: React.ReactNode;
}) {
  return <PersonalAgentContext.Provider value={value}>{children}</PersonalAgentContext.Provider>;
}

export function usePersonalAgent(): PersonalAgentContextValue {
  const value = useContext(PersonalAgentContext);
  if (!value) {
    throw new Error("usePersonalAgent must be used within the /personal layout (PersonalShell).");
  }
  return value;
}

export function useOptionalPersonalAgent(): PersonalAgentContextValue | null {
  return useContext(PersonalAgentContext);
}
