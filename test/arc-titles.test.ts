import { describe, it, expect } from "vitest";
import { canonicalizeArcTitle } from "../src/arc-titles";

describe("canonicalizeArcTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(canonicalizeArcTitle("  Romance   Dawn ")).toBe("romance dawn");
  });

  it("folds accepted spelling variants to a single canonical form", () => {
    expect(canonicalizeArcTitle("Arabasta")).toBe("alabasta");
    expect(canonicalizeArcTitle("Alabasta")).toBe("alabasta");
    expect(canonicalizeArcTitle("Whiskey Peak")).toBe("whisky peak");
    expect(canonicalizeArcTitle("Whisky Peak")).toBe("whisky peak");
  });

  it("so variant spellings compare equal", () => {
    expect(canonicalizeArcTitle("Arabasta")).toBe(canonicalizeArcTitle("alabasta"));
  });

  it("leaves unknown titles as normalized-but-unmapped", () => {
    expect(canonicalizeArcTitle("Enies Lobby")).toBe("enies lobby");
  });

  it("handles null/empty safely", () => {
    expect(canonicalizeArcTitle("")).toBe("");
    // @ts-expect-error — exercising the runtime null guard
    expect(canonicalizeArcTitle(null)).toBe("");
  });
});
