import "@testing-library/jest-dom/vitest";

// Node's experimental global Web Storage (enabled by default on newer Node
// releases) shadows jsdom's `window.localStorage`, exposing an object without
// the standard `Storage` methods (`clear`, `getItem`, ...). Install a small
// spec-compliant in-memory polyfill whenever the active implementation is
// missing those methods so component tests can rely on `localStorage`.
function createMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store = new Map();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

if (typeof window !== "undefined" && typeof window.localStorage?.clear !== "function") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
