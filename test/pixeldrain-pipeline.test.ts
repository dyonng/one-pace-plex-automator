import { describe, it, expect, vi, beforeEach } from "vitest";

// Routing between the two transports. The point of Pixeldrain is that it fails
// in a different way than BitTorrent does, so each must be able to cover for the
// other without a human deciding.

const {
  checkEligible, isComplete, isTransferActive, startTransfer,
  setDownloadVia, setEpisodeOriginalFilename, updateEpisodeStatus, getEpisodesByStatus,
  addMagnet, getTorrent, downloadSource, moveAndRename,
} = vi.hoisted(() => ({
  checkEligible: vi.fn(), isComplete: vi.fn(() => false), isTransferActive: vi.fn(() => false),
  startTransfer: vi.fn(), setDownloadVia: vi.fn(), setEpisodeOriginalFilename: vi.fn(),
  updateEpisodeStatus: vi.fn(), getEpisodesByStatus: vi.fn(() => []),
  addMagnet: vi.fn(async () => "hash"), getTorrent: vi.fn(async () => null),
  downloadSource: vi.fn(() => "pixeldrain"),
  moveAndRename: vi.fn(() => ({ replaced: [] })),
}));

vi.mock("../src/constants", () => ({ DOWNLOAD_PATH: "/downloads", MEDIA_PATH: "/media", DATA_DIR: "/data" }));
vi.mock("../src/config", () => ({ getConfig: () => ({}) }));
vi.mock("../src/db", () => ({
  getEpisodesByStatus, updateEpisodeStatus, setDownloadVia, setEpisodeOriginalFilename,
  isGuidSeen: vi.fn(() => false), markGuidSeen: vi.fn(), upsertEpisode: vi.fn(),
  getEpisodeByCrc32: vi.fn(() => null), deleteEpisode: vi.fn(), recordDownloadProgress: vi.fn(),
  getRetryableFailed: vi.fn(() => []), scheduleRetry: vi.fn(), clearRetryState: vi.fn(),
}));
vi.mock("../src/pixeldrain-downloads", () => ({
  checkEligible, isComplete, isTransferActive, startTransfer,
  clearTransferFailures: vi.fn(),
  destinationFor: (f: string) => `/downloads/${f}`,
}));
vi.mock("../src/settings", () => ({
  getAutoDownload: () => true, getPreferExtended: () => true,
  getArcFilter: () => ({ include: new Set(), exclude: new Set() }),
  getDownloadSource: downloadSource, getAutoPosters: () => false, getAutoReconcile: () => false,
}));
vi.mock("../src/qbittorrent", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getQbitClient: () => ({ addMagnet, getTorrent, deleteTorrent: vi.fn(async () => {}) }),
}));
vi.mock("../src/rss", () => ({ fetchNewEpisodes: vi.fn(async () => []), toIsoDate: () => null }));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32: vi.fn(async () => ({
    crc32: "F8FCF23F", arcIndex: 12, arcTitle: "Drum Island", arcPart: 13, arcSaga: "",
    arcDescription: "", episodeNum: 8, episodeTitle: "T", episodeDescription: "",
    chapters: "", originalEpisodes: "", released: "", resolution: "1080p", extended: false,
  })),
  buildPlexFilename: () => "One Pace - Drum Island - S13E08 [1080p][F8FCF23F].mkv",
  extractResolutionFromFilename: () => "1080p", parseResolutionFromFilename: () => "1080p",
  extractCrc32FromFilename: (f: string) => f.match(/\[([0-9A-F]{8})\]/i)?.[1] ?? null,
  isProvisionalKey: (c: string) => c.startsWith("PROV-"),
  getAllArcs: vi.fn(), getAllEpisodes: vi.fn(), getCatalogedCrc32s: vi.fn(async () => new Set()),
  parseReleaseFilename: () => null, resolveArcByTitle: vi.fn(async () => null),
  resolveAliasedRelease: vi.fn(async () => null), parseReleaseTitle: () => null,
  isPreferredRelease: async () => true, provisionalKey: (a: number, e: number) => `PROV-${a}-${e}`,
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/fileops", () => ({
  buildSeasonFolder: () => "Season 13 - Drum Island", findDownloadedFile: () => null,
  findExistingEpisodeFile: () => null, moveAndRename, scanBatchFiles: () => [],
}));
vi.mock("../src/plex", () => ({ triggerLibraryScan: vi.fn(), syncSingleEpisode: vi.fn(), syncFullLibrary: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordNotification: vi.fn(async () => {}) }));
vi.mock("../src/posters", () => ({ ensureSeasonPoster: vi.fn() }));
vi.mock("../src/coverage", () => ({ scanCoverage: vi.fn(), getStoredCoverage: () => null }));
vi.mock("../src/metadata-audit", () => ({ reconcilePlexMetadata: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null, lookupArcText: async () => null }));

import { dispatchPending } from "../src/cycle";
import { processDownloading } from "../src/processor";

const FILE = "[One Pace][153-155] Drum Island 08 [1080p][F8FCF23F].mkv";

const ep = (over: Record<string, unknown> = {}) => ({
  crc32: "F8FCF23F", arc_num: 12, arc_title: "Drum Island", arc_part: 13, episode_num: 8,
  resolution: "1080p", original_filename: FILE, final_filename: null, status: "pending",
  torrent_hash: null, magnet_uri: "magnet:?xt=urn:btih:abc", error_message: null, rss_guid: "",
  changelog: [], extended: false, published_at: null,
  pixeldrain_id: "73EVynVY", download_via: "torrent",
  dl_progress: 0, dl_progress_at: null, attempts: 0, next_retry_at: null,
  created_at: 0, updated_at: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  downloadSource.mockReturnValue("pixeldrain");
  isComplete.mockReturnValue(false);
  isTransferActive.mockReturnValue(false);
  getTorrent.mockResolvedValue(null);
  checkEligible.mockResolvedValue({ ok: true, filename: FILE, size: 1_064_717_453 });
});

describe("choosing a transport at dispatch", () => {
  it("uses Pixeldrain when the release offers one and the limits allow it", async () => {
    getEpisodesByStatus.mockReturnValue([ep()]);

    await dispatchPending();

    expect(setDownloadVia).toHaveBeenCalledWith("F8FCF23F", "pixeldrain");
    expect(setEpisodeOriginalFilename).toHaveBeenCalledWith("F8FCF23F", FILE);
    expect(updateEpisodeStatus).toHaveBeenCalledWith("F8FCF23F", "downloading");
    expect(addMagnet).not.toHaveBeenCalled();
  });

  it("falls back to the torrent when Pixeldrain is rate-limited", async () => {
    checkEligible.mockResolvedValue({ ok: false, reason: "Pixeldrain transfer limit reached" });
    getEpisodesByStatus.mockReturnValue([ep()]);

    await dispatchPending();

    expect(setDownloadVia).toHaveBeenCalledWith("F8FCF23F", "torrent");
    expect(addMagnet).toHaveBeenCalled();
  });

  it("uses the torrent for a release with no direct link, without asking Pixeldrain", async () => {
    getEpisodesByStatus.mockReturnValue([ep({ pixeldrain_id: null })]);

    await dispatchPending();

    expect(checkEligible).not.toHaveBeenCalled();
    expect(addMagnet).toHaveBeenCalled();
  });

  it("respects a torrent-only preference", async () => {
    downloadSource.mockReturnValue("torrent");
    getEpisodesByStatus.mockReturnValue([ep()]);

    await dispatchPending();

    expect(checkEligible).not.toHaveBeenCalled();
    expect(addMagnet).toHaveBeenCalled();
  });
});

describe("advancing a Pixeldrain download", () => {
  it("starts the transfer when the file isn't there yet", async () => {
    getEpisodesByStatus.mockImplementation((s: string) =>
      s === "downloading" ? [ep({ status: "downloading", download_via: "pixeldrain" })] : []);

    await processDownloading();

    expect(startTransfer).toHaveBeenCalled();
    expect(moveAndRename).not.toHaveBeenCalled();
  });

  it("does not start a second transfer for one already running", async () => {
    isTransferActive.mockReturnValue(true);
    getEpisodesByStatus.mockImplementation((s: string) =>
      s === "downloading" ? [ep({ status: "downloading", download_via: "pixeldrain" })] : []);

    await processDownloading();

    expect(startTransfer).not.toHaveBeenCalled();
  });

  it("imports through the shared path once the file has landed", async () => {
    isComplete.mockReturnValue(true);
    getEpisodesByStatus.mockImplementation((s: string) =>
      s === "downloading" ? [ep({ status: "downloading", download_via: "pixeldrain" })] : []);

    await processDownloading();

    expect(updateEpisodeStatus).toHaveBeenCalledWith("F8FCF23F", "processing");
    expect(moveAndRename).toHaveBeenCalledWith(
      `/downloads/${FILE}`, expect.stringContaining("S13E08"), "Drum Island", 13, 8
    );
    expect(startTransfer).not.toHaveBeenCalled();
    // The shared importer sleeps 5s after triggering the Plex scan.
  }, 15_000);
});
