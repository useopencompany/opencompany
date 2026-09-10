import { describe, expect, it } from "vitest";
import {
  ChatShareIdSchema,
  CreateWorkspaceBodySchema,
  SaveOnboardingWorkspaceBodySchema,
} from "./schemas";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("public resource IDs", () => {
  it.each(["share_", "goat_chat_share_"])("accepts %s share capabilities", (prefix) => {
    expect(ChatShareIdSchema.parse(`${prefix}${uuid}`)).toBe(`${prefix}${uuid}`);
  });

  it.each(["workspace_", "goat_ws_"])("accepts %s workspace creation and onboarding", (prefix) => {
    const workspaceId = `${prefix}${uuid}`;
    expect(CreateWorkspaceBodySchema.parse({ workspaceId, name: "Example" }).workspaceId).toBe(
      workspaceId,
    );
    expect(
      SaveOnboardingWorkspaceBodySchema.parse({ workspaceId, name: "Example", slug: "example" })
        .workspaceId,
    ).toBe(workspaceId);
  });

  it.each([
    `conversation_${uuid}`,
    "share_not-a-uuid",
    "share_123e4567-e89b-12d3-a456-426614174000",
    `share_${uuid}/extra`,
  ])("rejects invalid share capabilities: %s", (id) => {
    expect(ChatShareIdSchema.safeParse(id).success).toBe(false);
  });

  it.each([`conversation_${uuid}`, "workspace/invalid", "unrelated"])(
    "rejects unrelated workspace IDs: %s",
    (workspaceId) => {
      expect(CreateWorkspaceBodySchema.safeParse({ workspaceId, name: "Example" }).success).toBe(
        false,
      );
      expect(
        SaveOnboardingWorkspaceBodySchema.safeParse({
          workspaceId,
          name: "Example",
          slug: "example",
        }).success,
      ).toBe(false);
    },
  );
});
