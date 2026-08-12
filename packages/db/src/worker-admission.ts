export const GOAT_BRAIN_WORKER_ADMISSION_CHANNEL = "goat_brain_worker_admission_v1";

export const GOAT_BRAIN_WORKERS = ["brain_import", "brain_ingest", "google_drive_sync"] as const;

export type GoatBrainWorker = (typeof GOAT_BRAIN_WORKERS)[number];

export function parseGoatBrainWorkerAdmission(value: string): GoatBrainWorker | null {
  try {
    const parsed = JSON.parse(value) as { worker?: unknown };
    return typeof parsed.worker === "string" && isGoatBrainWorker(parsed.worker)
      ? parsed.worker
      : null;
  } catch {
    return null;
  }
}

function isGoatBrainWorker(value: string): value is GoatBrainWorker {
  return GOAT_BRAIN_WORKERS.some((worker) => worker === value);
}
