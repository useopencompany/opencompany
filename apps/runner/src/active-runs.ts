const activeRuns = new Map<
  string,
  { leaseId: string; leaseOwner: string; controller: AbortController }
>();

export type ActiveRunSnapshot = {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
};

export function setActiveRun(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  controller: AbortController,
) {
  activeRuns.set(sessionId, { leaseId, leaseOwner, controller });
}

export function clearActiveRun(sessionId: string, controller: AbortController) {
  if (activeRuns.get(sessionId)?.controller === controller) {
    activeRuns.delete(sessionId);
  }
}

export function abortActiveRun(sessionId: string) {
  activeRuns.get(sessionId)?.controller.abort();
}

export function listActiveRuns(): ActiveRunSnapshot[] {
  return Array.from(activeRuns.entries()).map(([sessionId, run]) => ({
    sessionId,
    leaseId: run.leaseId,
    leaseOwner: run.leaseOwner,
  }));
}
