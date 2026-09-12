import { describe, it, expect, vi, beforeEach } from "vitest";

// When gluetun restarts, qBittorrent's port disappears and every completed
// download in the sweep throws ECONNREFUSED. Marking them all "failed" turns a
// passing outage into a pipeline full of red rows — and then "Retry failed"
// re-downloads episodes that were fine. Infrastructure errors must stay
// retryable, and the sweep must stop rather than burn through the whole queue.

const { isComplete, updateEpisodeStatus, getEpisodesByStatus, getEpisodeByCrc32, sendDiscordNotification } =
  vi.hoisted(() => ({
    isComplete: vi.fn(),
    updateEpisodeStatus: vi.fn(),
    getEpisodesByStatus: vi.fn(),
    getEpisodeByCrc32: vi.fn(),
    sendDiscordNotification: vi.fn(async () => {}),
  }));

vi.mock("../src/constants", () => ({ DOWNLOAD_PATH: "/downloads", MEDIA_PATH: "/media", DATA_DIR: "/data" }));
vi.mock("../src/config", () => ({ getConfig: () => ({}) }));
vi.mock("../src/db", () => ({
  getEpisodesByStatus, updateEpisodeStatus, getEpisodeByCrc32,
  upsertEpisode: vi.fn(), deleteEpisode: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ isComplete, deleteTorrent: vi.fn(async () => {}), getTorrent: vi.fn(async () => null) }),
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
  buildSeasonFolder: () => "Season 1 - Arc", findDownloadedFile: () => null,
  findExistingEpisodeFile: () => null, moveAndRename: vi.fn(), scanBatchFiles: () => [],
}));
vi.mock("../src/plex", () => ({ triggerLibraryScan: vi.fn(), syncSingleEpisode: vi.fn(), syncFullLibrary: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordNotification }));
vi.mock("../src/posters", () => ({ ensureSeasonPoster: vi.fn() }));
vi.mock("../src/settings", () => ({ getAutoPosters: () => false, getAutoReconcile: () => false }));
vi.mock("../src/coverage", () => ({ scanCoverage: vi.fn(), getStoredCoverage: () => null }));
vi.mock("../src/metadata-audit", () => ({ reconcilePlexMetadata: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null, lookupArcText: async () => null }));

import { processDownloading } from "../src/processor";

const ep = (crc32: string) => ({
  crc32, arc_num: 0, arc_title: "Skypiea", arc_part: 16, episode_num: 6,
  resolution: "1080p", original_filename: "", final_filename: null, status: "downloading",
  torrent_hash: `hash-${crc32}`, magnet_uri: null, error_message: null, rss_guid: "",
  changelog: [], extended: false, published_at: null, created_at: 0, updated_at: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The status the processor set just before the throw.
  getEpisodeByCrc32.mockReturnValue({ status: "processing" });
});

describe("qBittorrent outage during a completion sweep", () => {
  it("keeps the episode retryable instead of failing it", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep("602704E6")] : []));
    isComplete.mockRejectedValue(new Error("connect ECONNREFUSED 172.18.0.6:8080"));

    await processDownloading();

    expect(updateEpisodeStatus).toHaveBeenCalledWith("602704E6", "downloading", { error_message: null });
    expect(updateEpisodeStatus).not.toHaveBeenCalledWith("602704E6", "failed", expect.anything());
    // No Discord alert either — the outage is not an episode problem.
    expect(sendDiscordNotification).not.toHaveBeenCalled();
  });

  it("stops the sweep rather than churning through every queued episode", async () => {
    getEpisodesByStatus.mockImplementation((s: string) =>
      s === "downloading" ? [ep("602704E6"), ep("BF59EB14"), ep("0B51015F")] : []);
    isComplete.mockRejectedValue(new Error("connect ECONNREFUSED 172.18.0.6:8080"));

    await processDownloading();

    expect(isComplete).toHaveBeenCalledTimes(1);
  });

  it("still fails an episode for a real, non-infrastructure error", async () => {
    getEpisodesByStatus.mockImplementation((s: string) => (s === "downloading" ? [ep("236CCF51")] : []));
    isComplete.mockResolvedValue(true); // completed, but the file isn't there

    await processDownloading();

    expect(updateEpisodeStatus).toHaveBeenCalledWith("236CCF51", "failed", expect.objectContaining({
      error_message: expect.stringContaining("not found"),
    }));
  });
});
