export const BRAIN_WORKER_ADMISSION_CHANNEL = "goat_brain_worker_admission_v1";

export const BRAIN_WORKERS = ["brain_import", "brain_ingest", "google_drive_sync"] as const;

export type BrainWorker = (typeof BRAIN_WORKERS)[number];

export function parseBrainWorkerAdmission(value: string): BrainWorker | null {
  try {
    const parsed = JSON.parse(value) as { worker?: unknown };
    return typeof parsed.worker === "string" && isBrainWorker(parsed.worker) ? parsed.worker : null;
  } catch {
    return null;
  }
}

function isBrainWorker(value: string): value is BrainWorker {
  return BRAIN_WORKERS.some((worker) => worker === value);
}
