import {
  captureToGoatBrainInbox as captureToSharedGoatBrainInbox,
  type GoatBrainCaptureResult,
  type GoatBrainCaptureSource,
} from "@opencompany/goat-agent/brain-capture";
import { nextAvailableGoatBrainId } from "@opencompany/goat-agent/brain-files";

export * from "@opencompany/goat-agent/brain-capture";

export function captureToGoatBrainInbox(input: {
  brainRef: string;
  userWorkosId: string;
  text?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackText?: string;
  source: GoatBrainCaptureSource;
}): Promise<GoatBrainCaptureResult> {
  const { userWorkosId, ...command } = input;
  return captureToSharedGoatBrainInbox(
    { ...command, actorId: userWorkosId },
    {
      nextAvailableBrainId: nextAvailableGoatBrainId,
    },
  );
}
