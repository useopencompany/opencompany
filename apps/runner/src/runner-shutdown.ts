import type { WorkerStopOptions } from "./polling-worker";

export type RunnerDrainTask = {
  name: string;
  activeCount?: () => number;
  stop: (options: WorkerStopOptions) => Promise<unknown>;
};

export type RunnerDrainResult = {
  activeAtStart: number;
  interruptedAtDeadline: number;
  deadlineExceeded: boolean;
  unfinishedTasks: string[];
};

export async function drainRunnerTasks(input: {
  tasks: RunnerDrainTask[];
  drainMs: number;
  postAbortWaitMs: number;
  onDeadline?: (result: Omit<RunnerDrainResult, "unfinishedTasks">) => Promise<void> | void;
}): Promise<RunnerDrainResult> {
  const abort = new AbortController();
  const unfinished = new Set(input.tasks.map((task) => task.name));
  const activeAtStart = activeWorkCount(input.tasks);
  const drain = Promise.allSettled(
    input.tasks.map(async (task) => {
      try {
        await task.stop({ signal: abort.signal });
      } finally {
        unfinished.delete(task.name);
      }
    }),
  );
  const drained = await settlesWithin(drain, input.drainMs);
  if (drained) {
    return {
      activeAtStart,
      interruptedAtDeadline: 0,
      deadlineExceeded: false,
      unfinishedTasks: [],
    };
  }

  const interruptedAtDeadline = activeWorkCount(input.tasks);
  await input.onDeadline?.({
    activeAtStart,
    interruptedAtDeadline,
    deadlineExceeded: true,
  });
  abort.abort(new Error("Runner shutdown drain deadline exceeded."));
  await settlesWithin(drain, input.postAbortWaitMs);
  return {
    activeAtStart,
    interruptedAtDeadline,
    deadlineExceeded: true,
    unfinishedTasks: Array.from(unfinished),
  };
}

export async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function activeWorkCount(tasks: RunnerDrainTask[]) {
  return tasks.reduce((total, task) => total + Math.max(0, task.activeCount?.() ?? 0), 0);
}
