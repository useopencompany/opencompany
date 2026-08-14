import {
  type BrainCaptureResult,
  type BrainCaptureSource,
  captureToBrainInbox as captureToSharedBrainInbox,
} from "@opencompany/agent/brain-capture";
import { nextAvailableBrainId } from "@opencompany/agent/brain-files";

export * from "@opencompany/agent/brain-capture";

export function captureToBrainInbox(input: {
  brainRef: string;
  userWorkosId: string;
  text?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackText?: string;
  source: BrainCaptureSource;
}): Promise<BrainCaptureResult> {
  const { userWorkosId, ...command } = input;
  return captureToSharedBrainInbox(
    { ...command, actorId: userWorkosId },
    {
      nextAvailableBrainId: nextAvailableBrainId,
    },
  );
}
