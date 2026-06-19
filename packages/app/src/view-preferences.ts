// Persisted, machine-local view preferences (survive across runs via
// localStorage). These are UI-only toggles, never document content.

const FULL_WIDTH_KEY = "roughdraft:full-width";

export function readFullWidthPreference(): boolean {
  try {
    return localStorage.getItem(FULL_WIDTH_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeFullWidthPreference(value: boolean): void {
  try {
    localStorage.setItem(FULL_WIDTH_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage failures (private mode, disabled storage); the toggle
    // still works for the current session.
  }
}
