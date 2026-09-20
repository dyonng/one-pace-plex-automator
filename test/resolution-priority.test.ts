import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// One Pace re-encodes an arc at a lower resolution and republishes it, so the
// newest release for a slot is regularly the *softer* one. Recency alone
// therefore can't decide which file to keep: a fresh 480p encode was replacing
// a 1080p file already in the library (Arlong Park S06E06-E09, then the same
// thing again on the next batch).
//
// Resolution now outranks recency. The CRC32 rule still decides between two
// releases of equal sharpness — that's the re-release case it was written for.

const root = mkdtempSync(path.join(tmpdir(), "media-res-"));
vi.mock("../src/constants", () => ({
  MEDIA_PATH: (globalThis as Record<string, unknown>).__MEDIA__ as string,
  DOWNLOAD_PATH: "/downloads",
  DATA_DIR: "/data",
}));
(globalThis as Record<string, unknown>).__MEDIA__ = root;

const { getCatalogedCrc32s } = vi.hoisted(() => ({ getCatalogedCrc32s: vi.fn(async () => new Set<string>()) }));

vi.mock("../src/config", () => ({ getConfig: () => ({}) }));
vi.mock("../src/db", () => ({
  getEpisodeByCrc32: vi.fn(() => null), getEpisodesByStatus: vi.fn(() => []),
  updateEpisodeStatus: vi.fn(), upsertEpisode: vi.fn(), deleteEpisode: vi.fn(),
  recordDownloadProgress: vi.fn(), getRetryableFailed: vi.fn(() => []),
  scheduleRetry: vi.fn(), clearRetryState: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({ getQbitClient: () => ({}), isTorrentComplete: vi.fn() }));
vi.mock("../src/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/metadata")>()),
  getCatalogedCrc32s,
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/plex", () => ({ triggerLibraryScan: vi.fn(), syncSingleEpisode: vi.fn(), syncFullLibrary: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordNotification: vi.fn(async () => {}) }));
vi.mock("../src/posters", () => ({ ensureSeasonPoster: vi.fn() }));
vi.mock("../src/settings", () => ({
  getAutoPosters: () => false, getAutoReconcile: () => false, getAutoDownload: () => true,
  getPreferExtended: () => true, getArcFilter: () => ({ include: new Set<string>(), exclude: new Set<string>() }),
  getDownloadSource: () => "torrent",
}));
vi.mock("../src/coverage", () => ({ scanCoverage: vi.fn(), getStoredCoverage: () => null }));
vi.mock("../src/metadata-audit", () => ({ reconcilePlexMetadata: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null, lookupArcText: async () => null }));
vi.mock("../src/pixeldrain-downloads", () => ({ checkEligible: vi.fn(async () => ({ ok: false })), clearTransferFailures: vi.fn() }));

const { newerFileAlreadyOnDisk } = await import("../src/processor");
const { compareResolution, resolutionRank } = await import("../src/metadata");
const { detectSeasonFormat } = await import("../src/fileops");

const write = (folder: string, name: string) => {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), "x");
};

const ARLONG = "Season 06 - Arlong Park";
const WANO = "Season 35 - Wano";
const LOGUETOWN = "Season 06 - Loguetown";

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogedCrc32s.mockResolvedValue(new Set<string>());
  rmSync(path.join(root, "Season 06 - Arlong Park"), { recursive: true, force: true });
  rmSync(path.join(root, "Season 35 - Wano"), { recursive: true, force: true });
  rmSync(path.join(root, "Season 06 - Loguetown"), { recursive: true, force: true });
  // The library names its folders "Season 06" (zero-padded), which the module
  // caches on first scan — mirror that so lookups hit the folders written here.
  mkdirSync(path.join(root, ARLONG), { recursive: true });
  detectSeasonFormat();
});

describe("compareResolution", () => {
  it("orders by vertical resolution", () => {
    expect(compareResolution("1080p", "480p")).toBe(1);
    expect(compareResolution("480p", "1080p")).toBe(-1);
    expect(compareResolution("1080p", "1080p")).toBe(0);
    expect(compareResolution("2160p", "1080p")).toBe(1);
  });

  it("has no opinion when either side is untagged", () => {
    expect(compareResolution(null, "1080p")).toBeNull();
    expect(compareResolution("1080p", null)).toBeNull();
    expect(compareResolution("", undefined)).toBeNull();
  });

  it("parses a rank from a tag", () => {
    expect(resolutionRank("480p")).toBe(480);
    expect(resolutionRank("1080p")).toBe(1080);
    expect(resolutionRank("nonsense")).toBeNull();
  });
});

describe("a softer release must never replace a sharper one", () => {
  it("refuses 480p over 1080p even when the 1080p CRC is the catalogued one", async () => {
    write(ARLONG, "One Pace - Arlong Park - S06E09 [1080p][0510B910].mkv");
    // 480p is uncatalogued and 1080p is catalogued — the CRC rule alone would
    // call the incoming file newer and let it through.
    getCatalogedCrc32s.mockResolvedValue(new Set(["0510B910"]));

    expect(await newerFileAlreadyOnDisk("Arlong Park", 6, 9, "EB1B1AA6", "480p"))
      .toBe("One Pace - Arlong Park - S06E09 [1080p][0510B910].mkv");
  });

  it("refuses 720p over 1080p", async () => {
    write(ARLONG, "One Pace - Arlong Park - S06E07 [1080p][4DDEFE2B].mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["4DDEFE2B"]));

    expect(await newerFileAlreadyOnDisk("Arlong Park", 6, 7, "AE7B08F2", "720p")).not.toBeNull();
  });

  it("allows a sharper release to replace a softer one", async () => {
    write(LOGUETOWN, "One Pace - Loguetown - S06E01 [480p][AAAAAAAA].mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["AAAAAAAA"]));

    expect(await newerFileAlreadyOnDisk("Loguetown", 6, 1, "BBBBBBBB", "1080p")).toBeNull();
  });
});

describe("the CRC32 recency rule still governs equal resolutions", () => {
  it("refuses a same-resolution older release when the on-disk CRC is uncatalogued", async () => {
    // Wano S35E12: 1080p replacing 1080p, on-disk hash not in the dataset, so the
    // on-disk file is the newer of the two — the case the CRC rule was written for.
    write(WANO, "One Pace - Wano - S35E12 [1080p][5ACE812A].mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["4E97A31D"]));

    expect(await newerFileAlreadyOnDisk("Wano", 35, 12, "4E97A31D", "1080p"))
      .toBe("One Pace - Wano - S35E12 [1080p][5ACE812A].mkv");
  });

  it("allows a same-resolution uncatalogued release to replace a catalogued one", async () => {
    write(WANO, "One Pace - Wano - S35E12 [1080p][5ACE812A].mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["5ACE812A"]));

    expect(await newerFileAlreadyOnDisk("Wano", 35, 12, "4E97A31D", "1080p")).toBeNull();
  });
});

describe("untagged files stay governed by the CRC32 rule", () => {
  it("does not treat a missing on-disk tag as a downgrade", async () => {
    write(ARLONG, "One Pace - Arlong Park - S06E09.mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["EB1B1AA6"]));

    expect(await newerFileAlreadyOnDisk("Arlong Park", 6, 9, "EB1B1AA6", "480p")).toBeNull();
  });

  it("does not treat a missing incoming tag as a downgrade", async () => {
    // On-disk hash uncatalogued, incoming catalogued — the CRC rule calls the
    // incoming release older. An untagged incoming file gives no resolution
    // signal, so that rule still applies.
    write(ARLONG, "One Pace - Arlong Park - S06E09 [1080p][DEC0DE01].mkv");
    getCatalogedCrc32s.mockResolvedValue(new Set(["EB1B1AA6"]));

    expect(await newerFileAlreadyOnDisk("Arlong Park", 6, 9, "EB1B1AA6", null))
      .toBe("One Pace - Arlong Park - S06E09 [1080p][DEC0DE01].mkv");
  });
});
