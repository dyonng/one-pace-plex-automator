import { describe, it, expect } from "vitest";
import { parseVer, isVersionNewer } from "../src/update-check";

describe("parseVer", () => {
  it("parses a strict semver triple", () => {
    expect(parseVer("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVer("10.0.27")).toEqual([10, 0, 27]);
  });

  it("rejects non-triples and junk", () => {
    expect(parseVer("1.2")).toBeNull();
    expect(parseVer("v1.2.3")).toBeNull();
    expect(parseVer("1.2.3-beta")).toBeNull();
    expect(parseVer("")).toBeNull();
    expect(parseVer(null)).toBeNull();
    expect(parseVer(undefined)).toBeNull();
  });
});

describe("isVersionNewer", () => {
  it("is true only when candidate is strictly newer", () => {
    expect(isVersionNewer("1.1.0", "1.0.28")).toBe(true);
    expect(isVersionNewer("1.0.28", "1.0.27")).toBe(true);
    expect(isVersionNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("is false for equal or older", () => {
    expect(isVersionNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isVersionNewer("1.0.27", "1.0.28")).toBe(false);
    expect(isVersionNewer("1.0.9", "1.0.10")).toBe(false); // numeric, not lexical
  });

  it("compares each component numerically", () => {
    expect(isVersionNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isVersionNewer("1.2.10", "1.2.9")).toBe(true);
  });

  it("is false when either side is unparseable", () => {
    expect(isVersionNewer("bad", "1.0.0")).toBe(false);
    expect(isVersionNewer("1.0.0", null)).toBe(false);
    expect(isVersionNewer(null, null)).toBe(false);
  });
});
