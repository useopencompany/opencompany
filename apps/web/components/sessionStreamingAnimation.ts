export function shouldAnimateStreamingAppend(previousContent: string, nextContent: string) {
  return nextContent.length > previousContent.length && nextContent.startsWith(previousContent);
}

// How many characters the streaming display buffer should reveal on a single
// frame, given the backlog of received-but-not-yet-shown characters. Revealing
// a fraction of the backlog keeps a steady stream flowing at an even cadence,
// while a sudden burst is drained quickly so the display never lags far behind
// generation. Returns 0 once caught up (so the reveal loop can stop). This
// paces *display* only — it never gates how fast tokens are received.
export function revealStep(backlog: number) {
  if (backlog <= 0) return 0;
  return Math.max(1, Math.ceil(backlog / 9));
}
