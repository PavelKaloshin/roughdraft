import { afterEach, describe, expect, it } from "vitest";
import {
  readFullWidthPreference,
  writeFullWidthPreference,
} from "./view-preferences";

afterEach(() => {
  localStorage.clear();
});

describe("full-width view preference", () => {
  it("defaults to false when nothing is stored", () => {
    expect(readFullWidthPreference()).toBe(false);
  });

  it("round-trips an enabled preference", () => {
    writeFullWidthPreference(true);
    expect(readFullWidthPreference()).toBe(true);
  });

  it("round-trips a disabled preference", () => {
    writeFullWidthPreference(true);
    writeFullWidthPreference(false);
    expect(readFullWidthPreference()).toBe(false);
  });
});
