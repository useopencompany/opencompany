interface ChatLifecycle {
  abort: () => void;
  resume: () => void;
}
let lifecycle: ChatLifecycle | null = null;

export function registerChatAbortHandler(abort: () => void, resume: () => void): () => void {
  const registered = { abort, resume };
  lifecycle = registered;
  return () => {
    if (lifecycle === registered) lifecycle = null;
  };
}

export function abortChatActivity(): void {
  lifecycle?.abort();
}
export function resumeChatActivity(): void {
  lifecycle?.resume();
}
