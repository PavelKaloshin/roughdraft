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
 * Composer mode shortcuts, active while typing a new root comment:
 * Mod+Shift+A picks Ask, Mod+Shift+E picks Change ("edit"). Pressing the
 * shortcut of the mode that is already selected goes back to Comment.
 * Mod+Enter still saves with the current mode and Escape still cancels.
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
