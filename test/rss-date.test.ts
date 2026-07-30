import { describe, it, expect } from "vitest";
import { toIsoDate } from "../src/rss";

// The feed's publication date becomes the air date for episodes the catalog
// doesn't list yet, so it has to normalize to exactly what Plex expects
// (YYYY-MM-DD) and fail closed on anything it can't read.
describe("toIsoDate", () => {
  it("converts an RFC-2822 feed date", () => {
    expect(toIsoDate("Sun, 28 Jun 2026 00:00:00 +0000")).toBe("2026-06-28");
  });

  it("passes a plain date through untouched (no timezone shift)", () => {
    expect(toIsoDate("2026-06-28")).toBe("2026-06-28");
  });

  it("takes the date part of an ISO timestamp", () => {
    expect(toIsoDate("2026-06-28T00:00:00Z")).toBe("2026-06-28");
    // A late-evening UTC timestamp must not roll backwards a day.
    expect(toIsoDate("2026-06-28T23:30:00Z")).toBe("2026-06-28");
  });

  it("returns null for missing or unparseable values", () => {
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate("   ")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate("not a date")).toBeNull();
  });
});
