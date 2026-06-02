import "@testing-library/jest-dom/vitest";

// jsdom does not implement Range geometry, but ProseMirror's scrollToSelection
// calls Range.getClientRects()/getBoundingClientRect() after editor transactions
// (e.g. typing-driven suggestion/heading tests). Without these stubs those calls
// raise async "getClientRects is not a function" exceptions that fail the run
// even though the assertions pass.
if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

// The jsdom environment used here does not ship a working localStorage
// implementation, so provide a minimal in-memory polyfill for tests that
// read or clear it (e.g. AgentDetail's beforeEach).
if (typeof window !== "undefined" && typeof window.localStorage?.clear !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
    writable: true,
    configurable: true,
  });
}
