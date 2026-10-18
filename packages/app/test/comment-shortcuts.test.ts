import { describe, expect, it } from "vitest";
import {
  getAddCommentShortcutLabel,
  getOpenReaderShortcutLabel,
  matchesAddCommentShortcut,
  matchesOpenReaderShortcut,
  matchReaderNavigationKey,
} from "../src/comment-shortcuts";

describe("comment shortcuts", () => {
  it("formats the add comment shortcut label for Mac platforms", () => {
    expect(getAddCommentShortcutLabel("MacIntel")).toBe("Cmd + Option + M");
    expect(getAddCommentShortcutLabel("iPhone")).toBe("Cmd + Option + M");
  });

  it("formats the add comment shortcut label for non-Mac platforms", () => {
    expect(getAddCommentShortcutLabel("Win32")).toBe("Ctrl + Alt + M");
    expect(getAddCommentShortcutLabel("Linux x86_64")).toBe("Ctrl + Alt + M");
  });

  it("matches the Mac add comment shortcut", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: true,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("matches the Windows add comment shortcut", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "M",
          altKey: true,
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(true);
  });

  it("rejects partial or conflicting modifier combinations", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: false,
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(false);

    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: true,
          ctrlKey: true,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("matches the Mac shortcut from the physical key code even when Option changes the character", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "µ",
          altKey: true,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("rejects non-M physical keys even if the produced character is m", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyN",
          key: "m",
          altKey: true,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });
});

describe("thread reader shortcuts", () => {
  const key = (
    overrides: Partial<{
      code: string;
      key: string;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }>,
  ) => ({
    code: "KeyO",
    key: "o",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("opens the reader with Cmd+Option+O on Mac and Ctrl+Alt+O elsewhere, by physical key", () => {
    expect(
      matchesOpenReaderShortcut(
        key({ key: "ø", altKey: true, metaKey: true }),
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      matchesOpenReaderShortcut(key({ altKey: true, ctrlKey: true }), "Win32"),
    ).toBe(true);
    expect(
      matchesOpenReaderShortcut(
        key({ altKey: true, ctrlKey: true }),
        "MacIntel",
      ),
    ).toBe(false);
    expect(
      matchesOpenReaderShortcut(
        key({ altKey: true, metaKey: true, shiftKey: true }),
        "MacIntel",
      ),
    ).toBe(false);
    expect(getOpenReaderShortcutLabel("MacIntel")).toBe("Cmd + Option + O");
    expect(getOpenReaderShortcutLabel("Linux x86_64")).toBe("Ctrl + Alt + O");
  });

  it("navigates threads with arrows and J/K, without modifiers", () => {
    expect(matchReaderNavigationKey(key({ key: "ArrowRight" }))).toBe(1);
    expect(matchReaderNavigationKey(key({ key: "j" }))).toBe(1);
    expect(matchReaderNavigationKey(key({ key: "J", shiftKey: true }))).toBe(
      null,
    );
    expect(matchReaderNavigationKey(key({ key: "ArrowLeft" }))).toBe(-1);
    expect(matchReaderNavigationKey(key({ key: "k" }))).toBe(-1);
    expect(
      matchReaderNavigationKey(key({ key: "ArrowLeft", metaKey: true })),
    ).toBe(null);
    expect(matchReaderNavigationKey(key({ key: "x" }))).toBe(null);
  });
});
