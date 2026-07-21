// Shim: the capture-first Brain inbox flow moved to @opencompany/goat-agent so
// apps/runner can use it too. This binds the app-specific draft-id allocation
// and ingest-worker wake; the exported surface is unchanged.
import {
  captureToGoatBrainInbox as captureToGoatBrainInboxWithDeps,
  type GoatBrainCaptureResult,
} from "@opencompany/goat-agent/brain-capture";
import { nextAvailableGoatBrainId } from "@/lib/brain";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

export {
  deriveCaptureTitle,
  GOAT_BRAIN_CAPTURE_FOLDER,
  type GoatBrainCaptureResult,
  type GoatBrainCaptureSource,
} from "@opencompany/goat-agent/brain-capture";

export async function captureToGoatBrainInbox(
  input: Parameters<typeof captureToGoatBrainInboxWithDeps>[0],
): Promise<GoatBrainCaptureResult> {
  return captureToGoatBrainInboxWithDeps(input, {
    nextAvailableBrainId: nextAvailableGoatBrainId,
    wakeIngest: triggerGoatBrainIngestWake,
  });
}
