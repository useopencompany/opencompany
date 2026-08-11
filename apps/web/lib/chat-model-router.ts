import {
  type GoatChatModelRoutingResult,
  resolveAutoGoatModel as resolveSharedAutoGoatModel,
} from "@opencompany/goat-agent/chat-model-router";

export * from "@opencompany/goat-agent/chat-model-router";

// Preserve the existing web adapter input while the shared service keeps provider identity
// vocabulary out of its application contract.
export function resolveAutoGoatModel(
  input: {
    prompt: string;
    attachments: readonly { kind: string }[];
    gatewayApiKey: string;
    userWorkosId: string;
    workspaceId: string;
  },
  options: Parameters<typeof resolveSharedAutoGoatModel>[1] = {},
): Promise<GoatChatModelRoutingResult> {
  const { userWorkosId, ...request } = input;
  return resolveSharedAutoGoatModel({ ...request, actorId: userWorkosId }, options);
}
