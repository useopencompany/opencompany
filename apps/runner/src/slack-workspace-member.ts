import { type SubscriptionExecute, subscriptionRows } from "@opencompany/db/session-subscriptions";
import { sql } from "drizzle-orm";

export type SlackWorkspaceMember = {
  userId: string;
  role: "admin" | "member";
};

// Completing Slack provisioning proves that the signed-in opencompany admin and the Slack user
// who exchanged the ticket are the same person. Prefer that durable account link to email, while
// keeping verified Slack email matching for every other workspace member.
export async function resolveSlackWorkspaceMember(
  execute: SubscriptionExecute,
  input: {
    workspaceId: string;
    teamId: string;
    slackUserId: string;
    email: string;
  },
): Promise<SlackWorkspaceMember | undefined> {
  const [member] = subscriptionRows<SlackWorkspaceMember>(
    await execute(sql`
      SELECT member.user_workos_id AS "userId", member.role
      FROM goat.workspace_members member
      JOIN goat.users account ON account.workos_user_id = member.user_workos_id
      LEFT JOIN goat.slack_provisioning_connections provisioning
        ON provisioning.workspace_id = member.workspace_id
        AND provisioning.team_id = ${input.teamId}
        AND provisioning.authorized_by = member.user_workos_id
        AND provisioning.slack_user_id = ${input.slackUserId}
      WHERE member.workspace_id = ${input.workspaceId}
        AND (
          provisioning.workspace_id IS NOT NULL
          OR (lower(account.email) = ${input.email} AND ${input.email} <> '')
        )
      ORDER BY (provisioning.workspace_id IS NOT NULL) DESC, member.user_workos_id
      LIMIT 1
    `),
  );
  return member;
}
