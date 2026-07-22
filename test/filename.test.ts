import { describe, it, expect } from "vitest";
import {
  buildPlexFilename,
  extractCrc32FromFilename,
  parseResolutionFromFilename,
  extractResolutionFromFilename,
} from "../src/metadata";

describe("buildPlexFilename", () => {
  it("formats the canonical Plex name with zero-padded S/E and uppercased CRC", () => {
    expect(buildPlexFilename("Baratie", 5, 1, "1080p", "be634289", ".mkv")).toBe(
      "One Pace - Baratie - S05E01 [1080p][BE634289].mkv"
    );
  });

  it("appends [Extended] before the extension for extended cuts", () => {
    expect(buildPlexFilename("Reverse Mountain", 9, 2, "1080p", "3B7CBD0F", ".mkv", true)).toBe(
      "One Pace - Reverse Mountain - S09E02 [1080p][3B7CBD0F][Extended].mkv"
    );
  });

  it("pads multi-digit seasons and episodes correctly", () => {
    expect(buildPlexFilename("Wano", 35, 53, "480p", "AABBCCDD", ".mkv")).toBe(
      "One Pace - Wano - S35E53 [480p][AABBCCDD].mkv"
    );
  });
});

describe("extractCrc32FromFilename", () => {
  it("extracts the CRC32 bracket, uppercased", () => {
    expect(extractCrc32FromFilename("One Pace - Baratie - S05E01 [1080p][be634289].mkv")).toBe("BE634289");
  });

  it("takes the last 8-hex bracket so a trailing [Extended] tag doesn't hide it", () => {
    // [Extended] is not 8 hex chars, but the point is the CRC must still be found
    // even with a tag after it.
    expect(
      extractCrc32FromFilename("One Pace - Reverse Mountain - S09E02 [1080p][3B7CBD0F][Extended].mkv")
    ).toBe("3B7CBD0F");
  });

  it("ignores the resolution bracket (not 8 hex chars)", () => {
    expect(extractCrc32FromFilename("show [1080p].mkv")).toBeNull();
  });

  it("returns null when there is no CRC32", () => {
    expect(extractCrc32FromFilename("random file name.mkv")).toBeNull();
  });
});

describe("resolution parsing", () => {
  it("parses a resolution tag", () => {
    expect(parseResolutionFromFilename("x [720p].mkv")).toBe("720p");
    expect(parseResolutionFromFilename("x [1080p][ABCD1234].mkv")).toBe("1080p");
  });

  it("returns null when absent", () => {
    expect(parseResolutionFromFilename("no resolution here.mkv")).toBeNull();
  });

  it("extractResolutionFromFilename defaults to 1080p when absent", () => {
    expect(extractResolutionFromFilename("no resolution here.mkv")).toBe("1080p");
    expect(extractResolutionFromFilename("x [480p].mkv")).toBe("480p");
  });
});
