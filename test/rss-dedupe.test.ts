import { describe, it, expect, vi, beforeEach } from "vitest";

// One episode can appear in a single feed batch twice: One Pace lists a
// re-release alongside the release it supersedes. The two took different
// branches — the new hash isn't catalogued yet so it went provisional, the old
// one resolved cleanly — so both were queued and both were downloaded. The
// import guard then threw the loser away, which is the right outcome bought at
// full price (~780MB wasted in the batch this is modelled on).

const {
  markGuidSeen, upsertEpisode, fetchNewEpisodes, resolveEpisodeByCrc32, resolveArcByTitle,
  resolveAliasedRelease, addMagnet, getEpisodeByCrc32, findExistingEpisodeFile, newerFileAlreadyOnDisk,
} = vi.hoisted(() => ({
  markGuidSeen: vi.fn(), upsertEpisode: vi.fn(), fetchNewEpisodes: vi.fn(),
  resolveEpisodeByCrc32: vi.fn(), resolveArcByTitle: vi.fn(), resolveAliasedRelease: vi.fn(),
  addMagnet: vi.fn(async () => "hash"), getEpisodeByCrc32: vi.fn(() => null),
  findExistingEpisodeFile: vi.fn(() => null), newerFileAlreadyOnDisk: vi.fn(async () => null),
}));

vi.mock("../src/db", () => ({
  isGuidSeen: vi.fn(() => false), markGuidSeen, upsertEpisode,
  updateEpisodeStatus: vi.fn(), getEpisodesByStatus: vi.fn(() => []),
  getEpisodeByCrc32, setDownloadVia: vi.fn(), setEpisodeOriginalFilename: vi.fn(),
}));
vi.mock("../src/fileops", () => ({ findExistingEpisodeFile }));
vi.mock("../src/processor", () => ({
  processDownloading: vi.fn(), requeueRetryableFailures: vi.fn(async () => 0), newerFileAlreadyOnDisk,
}));
vi.mock("../src/rss", () => ({ fetchNewEpisodes, toIsoDate: (d: string) => d?.slice(0, 10) ?? null }));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32, resolveArcByTitle, resolveAliasedRelease,
  extractResolutionFromFilename: () => "1080p", parseResolutionFromFilename: () => "1080p",
  isPreferredRelease: async () => true,
  parseReleaseTitle: (t: string) => {
    const parts = t.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if (!/^\d+$/.test(last) || parts.length < 2) return null;
    return { arcTitle: parts.slice(0, -1).join(" "), epNum: parseInt(last, 10), extended: false };
  },
  provisionalKey: (a: number, e: number) => `PROV-${a}-${e}`,
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/qbittorrent", () => ({ getQbitClient: () => ({ addMagnet }) }));
vi.mock("../src/discord", () => ({ sendDiscordNotification: vi.fn() }));
vi.mock("../src/settings", () => ({
  getAutoDownload: () => true, getPreferExtended: () => true,
  getArcFilter: () => ({ include: new Set<string>(), exclude: new Set<string>() }),
  getDownloadSource: () => "torrent",
}));
vi.mock("../src/pixeldrain-downloads", () => ({
  checkEligible: vi.fn(async () => ({ ok: false, reason: "off" })), clearTransferFailures: vi.fn(),
}));
vi.mock("../src/coverage", () => ({ getStoredCoverage: () => null, scanCoverage: vi.fn() }));

import { pollRss } from "../src/cycle";

const item = (over: Record<string, unknown>) => ({
  guid: "g", title: "Post-War 01", magnet: "magnet:?xt=1",
  filename: "f.mkv", crc32: null, pubDate: "2020-05-25",
  changelog: [], pixeldrainId: null, ...over,
});

const POST_WAR = {
  arcIndex: 26, arcPart: 27, arcTitle: "Post-War", arcSaga: "", arcDescription: "", arcReleased: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveArcByTitle.mockResolvedValue(POST_WAR);
  resolveAliasedRelease.mockResolvedValue(null);
  getEpisodeByCrc32.mockReturnValue(null);
  findExistingEpisodeFile.mockReturnValue(null);
  newerFileAlreadyOnDisk.mockResolvedValue(null);
});

describe("the same episode appearing twice in one batch", () => {
  beforeEach(() => {
    // E7B15590 is catalogued (the superseded release); 5DC550F9 is not, which is
    // exactly what makes it the newer of the two.
    resolveEpisodeByCrc32.mockImplementation(async (crc: string) => {
      if (crc === "E7B15590") {
        return {
          crc32: crc, arcIndex: 26, arcPart: 27, arcTitle: "Post-War", arcSaga: "",
          arcDescription: "", episodeNum: 1, episodeTitle: "Creeping Future", episodeDescription: "",
          chapters: "", originalEpisodes: "", released: "", resolution: "1080p", extended: false,
        };
      }
      throw new Error(`CRC32 ${crc} not found in metadata dataset`);
    });
  });

  it("downloads only the newer release, not both", async () => {
    fetchNewEpisodes.mockResolvedValue([
      item({ guid: "new", crc32: "5DC550F9", title: "Post-War 01" }),
      item({ guid: "old", crc32: "E7B15590", title: "Post-War 01" }),
    ]);

    await pollRss();

    const queued = upsertEpisode.mock.calls.map((c) => c[0].crc32);
    expect(queued).toEqual(["PROV-27-1"]);
    expect(queued).not.toContain("E7B15590");
    // The superseded entry is finished with — it must not come back next poll.
    expect(markGuidSeen).toHaveBeenCalledWith("old");
    expect(addMagnet).toHaveBeenCalledTimes(1);
  });

  it("is order-independent — the newer one wins whichever comes first", async () => {
    fetchNewEpisodes.mockResolvedValue([
      item({ guid: "old", crc32: "E7B15590", title: "Post-War 01" }),
      item({ guid: "new", crc32: "5DC550F9", title: "Post-War 01" }),
    ]);

    await pollRss();

    expect(upsertEpisode.mock.calls.map((c) => c[0].crc32)).toEqual(["PROV-27-1"]);
  });

  it("leaves a different episode in the same batch alone", async () => {
    resolveEpisodeByCrc32.mockImplementation(async (crc: string) => {
      if (crc === "AAAA1111") {
        return {
          crc32: crc, arcIndex: 26, arcPart: 27, arcTitle: "Post-War", arcSaga: "",
          arcDescription: "", episodeNum: 9, episodeTitle: "Other", episodeDescription: "",
          chapters: "", originalEpisodes: "", released: "", resolution: "1080p", extended: false,
        };
      }
      throw new Error(`CRC32 ${crc} not found`);
    });
    fetchNewEpisodes.mockResolvedValue([
      item({ guid: "new", crc32: "5DC550F9", title: "Post-War 01" }),
      item({ guid: "other", crc32: "AAAA1111", title: "Post-War 09" }),
    ]);

    await pollRss();

    const queued = upsertEpisode.mock.calls.map((c) => c[0].crc32).sort();
    expect(queued).toEqual(["AAAA1111", "PROV-27-1"]);
  });
});

describe("releases there is no point downloading", () => {
  const resolvedOnce = {
    crc32: "E7B15590", arcIndex: 26, arcPart: 27, arcTitle: "Post-War", arcSaga: "",
    arcDescription: "", episodeNum: 1, episodeTitle: "T", episodeDescription: "",
    chapters: "", originalEpisodes: "", released: "", resolution: "1080p", extended: false,
  };

  it("skips one already in the library", async () => {
    resolveEpisodeByCrc32.mockResolvedValue(resolvedOnce);
    getEpisodeByCrc32.mockReturnValue({ status: "done" });
    findExistingEpisodeFile.mockReturnValue({ filename: "x.mkv", crc32: "E7B15590" });
    fetchNewEpisodes.mockResolvedValue([item({ guid: "dup", crc32: "E7B15590" })]);

    await pollRss();

    expect(upsertEpisode).not.toHaveBeenCalled();
    expect(addMagnet).not.toHaveBeenCalled();
    expect(markGuidSeen).toHaveBeenCalledWith("dup");
  });

  it("skips a downgrade before spending the bandwidth, not after", async () => {
    resolveEpisodeByCrc32.mockResolvedValue(resolvedOnce);
    newerFileAlreadyOnDisk.mockResolvedValue("One Pace - Post-War - S27E01 [1080p][5DC550F9].mkv");
    fetchNewEpisodes.mockResolvedValue([item({ guid: "older", crc32: "E7B15590" })]);

    await pollRss();

    expect(addMagnet).not.toHaveBeenCalled();
    expect(markGuidSeen).toHaveBeenCalledWith("older");
  });

  it("still queues a genuine upgrade", async () => {
    resolveEpisodeByCrc32.mockResolvedValue(resolvedOnce);
    getEpisodeByCrc32.mockReturnValue({ status: "done" });
    findExistingEpisodeFile.mockReturnValue(null); // nothing on disk for that slot
    fetchNewEpisodes.mockResolvedValue([item({ guid: "up", crc32: "E7B15590" })]);

    await pollRss();

    expect(upsertEpisode).toHaveBeenCalledWith(expect.objectContaining({ crc32: "E7B15590" }));
    expect(addMagnet).toHaveBeenCalled();
  });
});
