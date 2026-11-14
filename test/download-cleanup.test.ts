import { describe, expect, it } from "vitest";
import { findOrphanDownloadEntries } from "../src/download-cleanup";

const NOW = 1_000_000_000;
const OLD = NOW - 2 * 60 * 60 * 1000;
const FRESH = NOW - 10 * 60 * 1000;
const DIR = "/downloads";

describe("findOrphanDownloadEntries", () => {
  it("ignores everything that is not ours in a shared folder", () => {
    const orphans = findOrphanDownloadEntries(
      [
        { name: "Avengers.Endgame.Encore.2026.2160p.DSNP.WEB-DL.DDPA.5.1.DV.HDR.H.265-PiRaTeS", mtimeMs: OLD },
        { name: "incomplete", mtimeMs: OLD },
        { name: "temp", mtimeMs: OLD },
        { name: "some.show.s01e01.mkv", mtimeMs: OLD },
      ],
      new Set(),
      DIR,
      NOW
    );
    expect(orphans).toEqual([]);
  });

  it("flags old unreferenced One Pace folders", () => {
    const orphans = findOrphanDownloadEntries(
      [{ name: "[One Pace][431-441] Post-Enies Lobby [720p]", mtimeMs: OLD }],
      new Set(),
      DIR,
      NOW
    );
    expect(orphans).toEqual(["[One Pace][431-441] Post-Enies Lobby [720p]"]);
  });

  it("keeps folders a live torrent still references", () => {
    const entries = [{ name: "[One Pace][431-441] Post-Enies Lobby [720p]", mtimeMs: OLD }];
    const active = new Set(["/downloads/[One Pace][431-441] Post-Enies Lobby [720p]"]);
    expect(findOrphanDownloadEntries(entries, active, DIR, NOW)).toEqual([]);
  });

  it("keeps folders containing a live torrent file and vice versa", () => {
    const entries = [{ name: "[One Pace] Specials", mtimeMs: OLD }];
    const fileInside = new Set(["/downloads/[One Pace] Specials/[One Pace] Specials 07 [720p][EFF6059A].mkv"]);
    expect(findOrphanDownloadEntries(entries, fileInside, DIR, NOW)).toEqual([]);
  });

  it("never deletes fresh entries, even unreferenced", () => {
    const orphans = findOrphanDownloadEntries(
      [{ name: "[One Pace][96-100] Loguetown [1080p]", mtimeMs: FRESH }],
      new Set(),
      DIR,
      NOW
    );
    expect(orphans).toEqual([]);
  });

  it("matches our prefix case-insensitively", () => {
    const orphans = findOrphanDownloadEntries(
      [{ name: "[one pace] specials", mtimeMs: OLD }],
      new Set(),
      DIR,
      NOW
    );
    expect(orphans).toEqual(["[one pace] specials"]);
  });
});
