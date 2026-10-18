function isApplePlatform(platform?: string | null) {
  if (!platform) return false;

  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function getAddCommentShortcutLabel(platform?: string | null) {
  return isApplePlatform(platform) ? "Cmd + Option + M" : "Ctrl + Alt + M";
}

interface AddCommentShortcutEventLike {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function matchesAddCommentShortcut(
  event: AddCommentShortcutEventLike,
  platform?: string | null,
) {
  if (event.shiftKey || event.code !== "KeyM" || !event.altKey) {
    return false;
  }

  return isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Thread reader (the centered dialog for long threads):
 *
 * - Cmd+Option+O (Mac) / Ctrl+Alt+O opens it for the selected thread (the
 *   one under the cursor or picked in the rail), matched by physical key
 *   like Cmd+Option+M because Option changes `key` on a Mac.
 * - O on a focused rail thread opens it (like R replies).
 * - Inside it, ←/→ or J/K move to the previous/next thread in document
 *   order; Escape closes.
 */
export function matchesOpenReaderShortcut(
  event: AddCommentShortcutEventLike,
  platform?: string | null,
) {
  if (event.shiftKey || event.code !== "KeyO" || !event.altKey) {
    return false;
  }

  return isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function getOpenReaderShortcutLabel(platform?: string | null) {
  return isApplePlatform(platform) ? "Cmd + Option + O" : "Ctrl + Alt + O";
}

/** Reader navigation: 1 = next thread, -1 = previous, null = not ours. */
export function matchReaderNavigationKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): 1 | -1 | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowRight" || event.key === "j") return 1;
  if (event.key === "ArrowLeft" || event.key === "k") return -1;
  return null;
}

/**
 * Composer keyboard flow. Where the composer offers Comment / Ask / Change
 * (a new root comment, or a new user reply in a plain thread, when the
 * backend can reach an agent):
 *
 * 1. Typing: Mod+Enter confirms the text and moves to the mode-selection
 *    step (an empty draft is submitted as before, which discards it).
 *    Escape cancels, as before.
 * 2. Mode-selection step (the text is read-only, focus is on the mode radio
 *    group): 1 / 2 / 3 pick Comment / Ask / Change; ←/→ and ↑/↓ cycle;
 *    Mod+Enter or Enter sends with the selected mode; Escape goes back to
 *    editing the text (a second Escape then cancels).
 *
 * In both steps Mod+Shift+A picks Ask and Mod+Shift+E picks Change ("edit");
 * pressing the shortcut of the mode that is already selected goes back to
 * Comment. Where no mode picker is shown (editing an existing comment, a
 * reply in an Ask/Change thread, backends without an agent), one Mod+Enter
 * saves. "Mod" is Cmd or Ctrl: both are accepted on every platform.
 */
export type ComposerModeShortcutTarget = "ask" | "change";

export function matchComposerModeShortcut(
  event: AddCommentShortcutEventLike,
  platform?: string | null,
): ComposerModeShortcutTarget | null {
  if (!event.shiftKey || event.altKey) return null;
  const hasModifier = isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!hasModifier) return null;
  if (event.code === "KeyA") return "ask";
  if (event.code === "KeyE") return "change";
  return null;
}

export function getComposerModeShortcutLabel(
  target: ComposerModeShortcutTarget,
  platform?: string | null,
) {
  const modifier = isApplePlatform(platform) ? "Cmd" : "Ctrl";
  return `${modifier} + Shift + ${target === "ask" ? "A" : "E"}`;
}

interface ComposerKeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Mod+Enter (Cmd or Ctrl, on any platform), the composer's submit key. */
export function isComposerSubmitShortcut(event: ComposerKeyEventLike) {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
}

export type ModeStepKeyAction =
  | { type: "select"; index: number }
  | { type: "cycle"; delta: 1 | -1 }
  | { type: "submit" }
  | { type: "edit" };

/**
 * Keys of the mode-selection step (see above). Mod+Shift+A/E are matched
 * separately with `matchComposerModeShortcut`; anything else returns null so
 * Tab and friends keep their default behavior.
 */
export function matchModeStepKey(
  event: ComposerKeyEventLike,
): ModeStepKeyAction | null {
  if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
    return { type: "submit" };
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Escape") return { type: "edit" };
  if (event.shiftKey) return null;
  if (event.key === "1" || event.key === "2" || event.key === "3") {
    return { type: "select", index: Number(event.key) - 1 };
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    return { type: "cycle", delta: 1 };
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    return { type: "cycle", delta: -1 };
  }
  return null;
}

/** The compact help line shown during the mode-selection step. */
export function getModeStepHint(platform?: string | null) {
  const send = isApplePlatform(platform) ? "⌘↵" : "Ctrl+↵";
  return `1 Comment · 2 Ask · 3 Change · ←/→ · ${send} send · Esc edit`;
}
