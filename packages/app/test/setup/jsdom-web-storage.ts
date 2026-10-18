import { afterEach } from "vitest";

// Node 25+ ships its own `localStorage`/`sessionStorage` globals. Without
// `--localstorage-file` their getters return undefined, and because the keys
// already exist on Node's global, Vitest's jsdom environment does not replace
// them with jsdom's Storage. Point both globals at the jsdom window so tests see
// the same browser storage on every Node version.
type JsdomGlobal = typeof globalThis & {
  jsdom?: { window: Window & typeof globalThis };
};

const jsdomWindow = (globalThis as JsdomGlobal).jsdom?.window;

if (jsdomWindow) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    if (globalThis[key] !== jsdomWindow[key]) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => jsdomWindow[key],
      });
    }
  }
}

// Storage lives as long as the file's jsdom; clear it after each test so a
// remembered preference (e.g. the comment composer mode) never leaks into the
// next test.
afterEach(() => {
  try {
    globalThis.localStorage?.clear();
    globalThis.sessionStorage?.clear();
  } catch {
    // A test may have replaced storage with a throwing stub.
  }
});
