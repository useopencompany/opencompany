// Direct provider calls are cheap compared to the old sub-agent workers, so
// the per-turn budget is looser while still bounding provider traffic.
export const MAX_ACTION_CALLS_PER_TURN = 16;
