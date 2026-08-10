import type { GoatBrainWithWorkspace } from "@opencompany/db/goat-workspaces";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/brain-capture", () => ({ captureToGoatBrainInbox: vi.fn() }));

import { resolveGoatMcpBrain } from "./mcp-server";

function brainWithWorkspace(input: {
  id: string;
  slug: string;
  name?: string;
  workspaceId?: string;
  workspaceName?: string;
}): GoatBrainWithWorkspace {
  return {
    brain: {
      id: input.id,
      slug: input.slug,
      name: input.name ?? input.slug,
    } as GoatBrainWithWorkspace["brain"],
    workspace: {
      id: input.workspaceId ?? "goat_ws_1",
      name: input.workspaceName ?? "Acme",
      workosOrganizationId: null,
    },
    workspaceRole: "member",
  };
}

const generalAcme = brainWithWorkspace({
  id: "general-aaaaaaaaaaaa",
  slug: "general",
  workspaceId: "goat_ws_acme",
  workspaceName: "Acme",
});
const generalOther = brainWithWorkspace({
  id: "general-bbbbbbbbbbbb",
  slug: "general",
  workspaceId: "goat_ws_other",
  workspaceName: "Other",
});
const research = brainWithWorkspace({
  id: "research-cccccccccccc",
  slug: "research",
  name: "Research",
  workspaceId: "goat_ws_acme",
  workspaceName: "Acme",
});

describe("resolveGoatMcpBrain", () => {
  it("auto-selects the only accessible brain when the param is omitted", () => {
    const result = resolveGoatMcpBrain([generalAcme], undefined);
    expect(result).toEqual({ ok: true, brain: generalAcme.brain });
  });

  it("lists the choices when the param is omitted with multiple brains", () => {
    const result = resolveGoatMcpBrain([generalAcme, research], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(generalAcme.brain.id);
    expect(result.error).toContain(research.brain.id);
  });

  it("errors when the user has no brains", () => {
    const result = resolveGoatMcpBrain([], undefined);
    expect(result.ok).toBe(false);
  });

  it("resolves an exact brain id", () => {
    const result = resolveGoatMcpBrain([generalAcme, research], research.brain.id);
    expect(result).toEqual({ ok: true, brain: research.brain });
  });

  it("resolves a unique slug", () => {
    const result = resolveGoatMcpBrain([generalAcme, research], "research");
    expect(result).toEqual({ ok: true, brain: research.brain });
  });

  it("rejects a slug that matches brains in multiple workspaces", () => {
    const result = resolveGoatMcpBrain([generalAcme, generalOther], "general");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(generalAcme.brain.id);
    expect(result.error).toContain(generalOther.brain.id);
  });

  it("suggests list_brains for unknown brains", () => {
    const result = resolveGoatMcpBrain([generalAcme], "missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("list_brains");
  });
});
