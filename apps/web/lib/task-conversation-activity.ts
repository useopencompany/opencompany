import type { TaskStatus } from "@opencompany/core";
import type { HeadlessChatRunReadModel } from "./headless-chat-collections";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

// The Run the Task page treats as the one the Task is doing. Stop, the run timer, and the working
// state all follow it; a message the user queued behind the live turn is a newer Run, but it is
// not what the Task is doing, so a queued Run only counts when nothing is running.
//
// The Task row and its Run rows arrive on separate Electric shapes, so either can be stale for a
// while. The runner settles a Task in the same transaction that settles its Run, and a follow-up
// reopens the Task in the same transaction that queues the next Run, so a terminal Task never has
// a live Run. A Run row that still looks live but is not newer than the Task's settlement is
// therefore a stale projection and must not keep the Task "working"; a Run written after the
// settlement is the Task's next turn and wins over a Task row that has not caught up yet.
export function selectActiveTaskRun(
  task: { status: TaskStatus; updatedAt: string | Date },
  runs: readonly HeadlessChatRunReadModel[],
): HeadlessChatRunReadModel | null {
  const candidates = isTerminalTaskStatus(task.status)
    ? runs.filter((run) => isNewerThan(run.updatedAt, task.updatedAt))
    : runs;
  const newestWith = (statuses: readonly HeadlessChatRunReadModel["status"][]) =>
    candidates
      .filter((candidate) => statuses.includes(candidate.status))
      .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  return newestWith(["running", "paused"]) ?? newestWith(["queued"]);
}

function isNewerThan(value: string | Date, reference: string | Date): boolean {
  const valueMs = toMs(value);
  const referenceMs = toMs(reference);
  return Number.isFinite(valueMs) && Number.isFinite(referenceMs) && valueMs > referenceMs;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
