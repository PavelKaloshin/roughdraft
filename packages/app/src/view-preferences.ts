// Persisted, machine-local view preferences (survive across runs via
// localStorage). These are UI-only toggles, never document content.

const FULL_WIDTH_KEY = "roughdraft:full-width";
const OUTLINE_RAIL_KEY = "roughdraft:outline-rail";

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

/** The single-file outline rail starts open; hiding it is what gets remembered. */
export function readOutlineRailPreference(): boolean {
  try {
    return localStorage.getItem(OUTLINE_RAIL_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeOutlineRailPreference(value: boolean): void {
  try {
    localStorage.setItem(OUTLINE_RAIL_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage failures; the toggle still works for this session.
  }
}
