const activeRuns = new Map<string, { leaseId: string; controller: AbortController }>();

export function setActiveRun(sessionId: string, leaseId: string, controller: AbortController) {
  activeRuns.set(sessionId, { leaseId, controller });
}

export function clearActiveRun(sessionId: string, controller: AbortController) {
  if (activeRuns.get(sessionId)?.controller === controller) {
    activeRuns.delete(sessionId);
  }
}

export function abortActiveRun(sessionId: string) {
  activeRuns.get(sessionId)?.controller.abort();
}
