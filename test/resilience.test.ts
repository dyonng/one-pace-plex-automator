import { describe, it, expect, vi, beforeEach } from "vitest";

// Resilience guards. The failure that motivated these: a VPN container updated,
// qBittorrent went away mid-download, and six episodes sat in "downloading" for
// seven hours with nothing anywhere reporting it.

const {
  isComplete, getTorrent, updateEpisodeStatus, getEpisodesByStatus, getEpisodeByCrc32,
  recordDownloadProgress, getRetryableFailed, scheduleRetry, clearRetryState, sendDiscordNotification,
} = vi.hoisted(() => ({
  isComplete: vi.fn(), getTorrent: vi.fn(async () => null),
  updateEpisodeStatus: vi.fn(), getEpisodesByStatus: vi.fn(), getEpisodeByCrc32: vi.fn(),
  recordDownloadProgress: vi.fn(), getRetryableFailed: vi.fn(() => []),
  scheduleRetry: vi.fn(), clearRetryState: vi.fn(), sendDiscordNotification: vi.fn(async () => {}),
}));

vi.mock("../src/constants", () => ({ DOWNLOAD_PATH: "/downloads", MEDIA_PATH: "/media", DATA_DIR: "/data" }));
vi.mock("../src/config", () => ({ getConfig: () => ({}) }));
vi.mock("../src/db", () => ({
  getEpisodesByStatus, updateEpisodeStatus, getEpisodeByCrc32, recordDownloadProgress,
  getRetryableFailed, scheduleRetry, clearRetryState,
  upsertEpisode: vi.fn(), deleteEpisode: vi.fn(),
}));
vi.mock("../src/qbittorrent", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getQbitClient: () => ({ isComplete, getTorrent, deleteTorrent: vi.fn(async () => {}) }),
}));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32: vi.fn(), buildPlexFilename: vi.fn(() => "x.mkv"),
  extractResolutionFromFilename: () => "1080p", parseResolutionFromFilename: () => "1080p",
  extractCrc32FromFilename: () => null, isProvisionalKey: (c: string) => c.startsWith("PROV-"),
  getAllArcs: vi.fn(), getAllEpisodes: vi.fn(), getCatalogedCrc32s: vi.fn(async () => new Set()),
  parseReleaseFilename: vi.fn(() => null), resolveArcByTitle: vi.fn(async () => null),
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/fileops", () => ({
  buildSeasonFolder: () => "S", findDownloadedFile: () => null,
  findExistingEpisodeFile: () => null, moveAndRename: vi.fn(), scanBatchFiles: () => [],
}));
vi.mock("../src/plex", () => ({ triggerLibraryScan: vi.fn(), syncSingleEpisode: vi.fn(), syncFullLibrary: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordNotification }));
vi.mock("../src/posters", () => ({ ensureSeasonPoster: vi.fn() }));
vi.mock("../src/settings", () => ({ getAutoPosters: () => false, getAutoReconcile: () => false }));
vi.mock("../src/coverage", () => ({ scanCoverage: vi.fn(), getStoredCoverage: () => null }));
vi.mock("../src/metadata-audit", () => ({ reconcilePlexMetadata: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null, lookupArcText: async () => null }));

import { processDownloading, requeueRetryableFailures } from "../src/processor";
import { isTorrentComplete } from "../src/qbittorrent";

const ep = (over: Record<string, unknown> = {}) => ({
  crc32: "602704E6", arc_num: 0, arc_title: "Skypiea", arc_part: 16, episode_num: 10,
  resolution: "1080p", original_filename: "", final_filename: null, status: "downloading",
  torrent_hash: "hash-1", magnet_uri: null, error_message: null, rss_guid: "",
  changelog: [], extended: false, published_at: null,
  dl_progress: 0, dl_progress_at: null, attempts: 0, next_retry_at: null,
  created_at: 0, updated_at: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getTorrent.mockResolvedValue(null);
  getRetryableFailed.mockReturnValue([]);
  getEpisodeByCrc32.mockReturnValue({ status: "processing" });
  getEpisodesByStatus.mockImplementation(() => []);
});

describe("download progress watchdog", () => {
  it("records progress for an in-flight download so a stall becomes visible", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep()] : []));
    getTorrent.mockResolvedValue({ hash: "hash-1", state: "downloading", progress: 0.42 } as never);

    await processDownloading();

    expect(recordDownloadProgress).toHaveBeenCalledWith("602704E6", 0.42);
    expect(updateEpisodeStatus).not.toHaveBeenCalled();
  });
});

describe("a torrent that disappears from qBittorrent", () => {
  // The miss counter is keyed by torrent hash and lives for the process, so each
  // test uses its own hash rather than inheriting the previous test's count.
  it("is not written off on a single missing reading", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep({ torrent_hash: "gone-a" })] : []));
    await processDownloading();
    expect(updateEpisodeStatus).not.toHaveBeenCalled();
  });

  it("fails the episode once it is confirmed gone, rather than waiting forever", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep({ torrent_hash: "gone-b" })] : []));
    await processDownloading();
    await processDownloading();
    await processDownloading();

    expect(updateEpisodeStatus).toHaveBeenCalledWith("602704E6", "failed", {
      error_message: expect.stringContaining("no longer in qBittorrent"),
    });
  });

  it("forgets the miss count as soon as the torrent reappears", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep({ torrent_hash: "gone-c" })] : []));
    await processDownloading();
    await processDownloading();
    getTorrent.mockResolvedValue({ hash: "gone-c", state: "downloading", progress: 0.5 } as never);
    await processDownloading();
    getTorrent.mockResolvedValue(null);
    await processDownloading();

    expect(updateEpisodeStatus).not.toHaveBeenCalledWith("602704E6", "failed", expect.anything());
  });
});

describe("automatic retry of failed episodes", () => {
  it("re-queues a due failure and schedules the next attempt", async () => {
    getRetryableFailed.mockReturnValue([ep({ status: "failed", attempts: 0, error_message: "boom" })]);

    const n = await requeueRetryableFailures();

    expect(n).toBe(1);
    expect(updateEpisodeStatus).toHaveBeenCalledWith("602704E6", "pending", { error_message: null });
    const [crc, attempts, nextAt] = scheduleRetry.mock.calls[0];
    expect(crc).toBe("602704E6");
    expect(attempts).toBe(1);
    expect(nextAt).toBeGreaterThan(Date.now());
  });

  it("backs off further with each attempt", async () => {
    getRetryableFailed.mockReturnValue([ep({ status: "failed", attempts: 0 })]);
    await requeueRetryableFailures();
    const firstGap = scheduleRetry.mock.calls[0][2] - Date.now();

    vi.clearAllMocks();
    getRetryableFailed.mockReturnValue([ep({ status: "failed", attempts: 1 })]);
    await requeueRetryableFailures();
    const secondGap = scheduleRetry.mock.calls[0][2] - Date.now();

    expect(secondGap).toBeGreaterThan(firstGap);
  });

  it("does nothing when the query reports no episode is due", async () => {
    expect(await requeueRetryableFailures()).toBe(0);
    expect(updateEpisodeStatus).not.toHaveBeenCalled();
  });
});

describe("isTorrentComplete", () => {
  it("treats seeding states and full progress as complete", () => {
    expect(isTorrentComplete({ state: "stalledUP", progress: 0 })).toBe(true);
    expect(isTorrentComplete({ state: "downloading", progress: 1 })).toBe(true);
  });

  it("does not treat a stalled download as complete", () => {
    expect(isTorrentComplete({ state: "stalledDL", progress: 0.3 })).toBe(false);
  });
});
