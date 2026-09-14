// React Native 0.86's abort-controller polyfill omits AbortSignal.throwIfAborted() and .any().
function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    for (const signal of signals) signal.removeEventListener("abort", abort);
    controller.abort();
  };

  if (signals.some((signal) => signal.aborted)) {
    abort();
    return controller.signal;
  }

  for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
