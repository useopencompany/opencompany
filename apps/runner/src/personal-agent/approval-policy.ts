import type { ActionDispatcher } from "@opencompany/agent/chat-agent";
// Approvals live in the opencompany app; a phone has no way to answer one. Instead of pausing the
// Run, an action that would need approval fails with a message the model relays to the user.
export function withoutActionApprovals(dispatcher: ActionDispatcher): ActionDispatcher {
  const { needsApproval, ...rest } = dispatcher;
  if (!needsApproval) return dispatcher;
  return {
    ...rest,
    execute: async (call) => {
      if (await needsApproval(call)) {
        return {
          ok: false,
          action: call.action,
          error: {
            code: "internal",
            message:
              "This action needs your approval in the opencompany app, and approvals are not available over phone channels yet. Tell the user what you wanted to do and that they can run it from the app.",
          },
        };
      }
      return dispatcher.execute(call);
    },
  };
}
