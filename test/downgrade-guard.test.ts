import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// One Pace's feed carries a re-release alongside the release it supersedes, so
// the same slot can be queued twice with different CRC32s. Whichever download
// finished last used to win — the older file could land on top of the newer one,
// and hitting "Retry" on a stale row would downgrade a good episode.
//
// The rule mirrors the coverage report's: a CRC32 the dataset has never listed
// came from a release that landed after the dataset was generated, so it is
// newer than anything the catalog knows.

const root = mkdtempSync(path.join(tmpdir(), "media-"));
vi.mock("../src/constants", async () => ({
  MEDIA_PATH: (globalThis as Record<string, unknown>).__MEDIA__ as string,
  DOWNLOAD_PATH: "/downloads",
  DATA_DIR: "/data",
}));
(globalThis as Record<string, unknown>).__MEDIA__ = root;

const { findExistingEpisodeFile } = await import("../src/fileops");

const seasonDir = path.join(root, "Season 27 - Post-War");

beforeEach(() => {
  rmSync(seasonDir, { recursive: true, force: true });
  mkdirSync(seasonDir, { recursive: true });
});

describe("findExistingEpisodeFile", () => {
  const write = (name: string) => writeFileSync(path.join(seasonDir, name), "x");

  it("returns the file and CRC32 occupying a season/episode slot", () => {
    write("One Pace - Post-War - S27E01 [1080p][5DC550F9].mkv");
    expect(findExistingEpisodeFile("Post-War", 27, 1)).toEqual({
      filename: "One Pace - Post-War - S27E01 [1080p][5DC550F9].mkv",
      crc32: "5DC550F9",
    });
  });

  it("returns null for an empty slot", () => {
    write("One Pace - Post-War - S27E01 [1080p][5DC550F9].mkv");
    expect(findExistingEpisodeFile("Post-War", 27, 2)).toBeNull();
  });

  it("does not let S27E01 match S27E011", () => {
    write("One Pace - Post-War - S27E011 [1080p][5DC550F9].mkv");
    expect(findExistingEpisodeFile("Post-War", 27, 1)).toBeNull();
  });

  it("reports a null CRC32 for an untagged file rather than skipping it", () => {
    write("One Pace - Post-War - S27E01.mkv");
    expect(findExistingEpisodeFile("Post-War", 27, 1)).toEqual({
      filename: "One Pace - Post-War - S27E01.mkv",
      crc32: null,
    });
  });

  it("ignores non-video files in the season folder", () => {
    write("S27E01.nfo");
    expect(findExistingEpisodeFile("Post-War", 27, 1)).toBeNull();
  });
});

describe("parseReleaseFilename", () => {
  // A release that lands before the dataset regenerates has no catalog entry to
  // look up, but its filename still names the arc and episode — and it is the
  // NEWER file, so dropping it left the stale catalogued release in the library.
  it("recovers arc and episode from a One Pace release filename", async () => {
    const { parseReleaseFilename } = await import("../src/metadata");
    expect(parseReleaseFilename("[One Pace][252-254] Skypiea 08 [1080p][A1DFB514].mkv"))
      .toEqual({ arcTitle: "Skypiea", epNum: 8, extended: false });
  });

  it("handles a hyphenated multi-word arc", async () => {
    const { parseReleaseFilename } = await import("../src/metadata");
    expect(parseReleaseFilename("[One Pace][585-586] Post-War 03 [1080p][8ABAF3B1].mkv"))
      .toEqual({ arcTitle: "Post-War", epNum: 3, extended: false });
  });

  it("flags an extended cut", async () => {
    const { parseReleaseFilename } = await import("../src/metadata");
    expect(parseReleaseFilename("[One Pace][1091-1092] Egghead 21 Extended [1080p][DEADBEEF].mkv"))
      .toEqual({ arcTitle: "Egghead", epNum: 21, extended: true });
  });

  it("returns null when nothing episode-shaped is left", async () => {
    const { parseReleaseFilename } = await import("../src/metadata");
    expect(parseReleaseFilename("[One Pace][1-7] Romance Dawn [1080p].mkv")).toBeNull();
  });
});
