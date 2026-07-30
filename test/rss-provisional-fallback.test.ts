import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards the fallback for an RSS entry that carries a CRC32 the catalog doesn't
// know yet (a release landing before the dataset/guide regenerate — e.g. a new
// One Pace special). Two properties matter:
//
//  1. It must not dead-end: the entry falls through to the title-derived
//     provisional path instead of only logging an error.
//  2. If the provisional path can't place it either, the GUID must stay UNSEEN so
//     a later poll can resolve it properly once the sources catch up. Marking it
//     seen would silently drop the release forever.

// vi.mock factories are hoisted above module scope, so the fns they reference
// must be created inside vi.hoisted().
const {
  markGuidSeen, upsertEpisode, updateEpisodeStatus,
  fetchNewEpisodes, resolveEpisodeByCrc32, resolveArcByTitle, resolveAliasedRelease, addMagnet,
} = vi.hoisted(() => ({
  markGuidSeen: vi.fn(),
  upsertEpisode: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  fetchNewEpisodes: vi.fn(),
  resolveEpisodeByCrc32: vi.fn(),
  resolveArcByTitle: vi.fn(),
  resolveAliasedRelease: vi.fn(),
  addMagnet: vi.fn(async () => "hash123"),
}));

vi.mock("../src/db", () => ({
  isGuidSeen: vi.fn(() => false),
  markGuidSeen,
  upsertEpisode,
  updateEpisodeStatus,
  getEpisodesByStatus: vi.fn(() => []),
}));
vi.mock("../src/rss", () => ({ fetchNewEpisodes }));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32,
  resolveArcByTitle,
  resolveAliasedRelease,
  extractResolutionFromFilename: () => "1080p",
  parseResolutionFromFilename: () => "1080p",
  isPreferredRelease: async () => true,
  // Mirrors the real parser: trailing integer = episode, rest = arc title.
  parseReleaseTitle: (t: string) => {
    const parts = t.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if (!/^\d+$/.test(last) || parts.length < 2) return null;
    return { arcTitle: parts.slice(0, -1).join(" "), epNum: parseInt(last, 10), extended: false };
  },
  provisionalKey: (arcPart: number, epNum: number) => `PROV-${arcPart}-${epNum}`,
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/qbittorrent", () => ({ getQbitClient: () => ({ addMagnet }) }));
vi.mock("../src/processor", () => ({ processDownloading: vi.fn(async () => {}) }));
vi.mock("../src/discord", () => ({ sendDiscordNotification: vi.fn(async () => {}) }));
vi.mock("../src/settings", () => ({
  getAutoDownload: () => true,
  getPreferExtended: () => true,
}));
vi.mock("../src/coverage", () => ({
  getStoredCoverage: () => null,
  scanCoverage: vi.fn(async () => {}),
}));

import { pollRss } from "../src/cycle";

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  guid: "guid-1",
  title: "One Piece Fan Letter 01",
  magnet: "magnet:?xt=1",
  filename: "[One Pace] One Piece Fan Letter 01 [1080p][59510B34].mkv",
  crc32: "59510B34",
  pubDate: "2026-07-30",
  changelog: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveEpisodeByCrc32.mockRejectedValue(new Error("CRC32 59510B34 not found in metadata dataset"));
  resolveArcByTitle.mockResolvedValue(null); // unknown arc by default
  resolveAliasedRelease.mockResolvedValue(null); // not a special-cased release by default
});

describe("unresolvable CRC32 falls back to the provisional path", () => {
  it("does NOT mark the GUID seen when the arc can't be placed (stays retryable)", async () => {
    fetchNewEpisodes.mockResolvedValue([entry()]);
    await pollRss();
    expect(resolveEpisodeByCrc32).toHaveBeenCalled();
    // The whole point: a real CRC that's merely unpublished must remain eligible.
    expect(markGuidSeen).not.toHaveBeenCalled();
    expect(upsertEpisode).not.toHaveBeenCalled();
  });

  it("downloads provisionally when the title's arc IS known", async () => {
    resolveArcByTitle.mockResolvedValue({ arcIndex: 3, arcPart: 4, arcTitle: "Baratie", arcSaga: "East Blue", arcDescription: "", arcReleased: "" });
    fetchNewEpisodes.mockResolvedValue([entry({ title: "Baratie 07", guid: "guid-2" })]);

    await pollRss();

    expect(upsertEpisode).toHaveBeenCalledWith(expect.objectContaining({ crc32: "PROV-4-7", arc_part: 4 }));
    expect(addMagnet).toHaveBeenCalled();
    // A successful provisional placement is terminal for this feed item.
    expect(markGuidSeen).toHaveBeenCalledWith("guid-2");
  });

  it("still marks GUIDs seen for entries with no CRC32 at all (unchanged behavior)", async () => {
    fetchNewEpisodes.mockResolvedValue([
      entry({ crc32: null, guid: "guid-3", title: "Not Parseable" }),
    ]);
    await pollRss();
    expect(markGuidSeen).toHaveBeenCalledWith("guid-3");
  });

  it("downloads an aliased special (Fan Letter) at its catalogued slot", async () => {
    // "One Piece Fan Letter" is not an arc, so the generic lookup can't place it;
    // the alias pins it to Specials S00E98 where the dataset's metadata lives.
    resolveAliasedRelease.mockResolvedValue({
      arcIndex: 0, arcPart: 0, arcTitle: "Specials", epNum: 98,
      extended: false, label: "One Piece Fan Letter",
    });
    fetchNewEpisodes.mockResolvedValue([entry({ guid: "guid-fl" })]);

    await pollRss();

    expect(upsertEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ crc32: "PROV-0-98", arc_part: 0, episode_num: 98, arc_title: "Specials" })
    );
    expect(addMagnet).toHaveBeenCalled();
    expect(markGuidSeen).toHaveBeenCalledWith("guid-fl");
    // The alias short-circuits the generic arc lookup entirely.
    expect(resolveArcByTitle).not.toHaveBeenCalled();
  });

  it("resolved entries are unaffected by the fallback", async () => {
    resolveEpisodeByCrc32.mockResolvedValue({
      crc32: "ABCD1234", arcIndex: 3, arcPart: 4, arcTitle: "Baratie", arcSaga: "East Blue",
      arcDescription: "", episodeNum: 7, episodeTitle: "T", episodeDescription: "",
      chapters: "", originalEpisodes: "", released: "", resolution: "1080p", extended: false,
    });
    fetchNewEpisodes.mockResolvedValue([entry({ crc32: "ABCD1234", guid: "guid-4" })]);

    await pollRss();

    expect(upsertEpisode).toHaveBeenCalledWith(expect.objectContaining({ crc32: "ABCD1234" }));
    expect(resolveArcByTitle).not.toHaveBeenCalled();
  });
});
