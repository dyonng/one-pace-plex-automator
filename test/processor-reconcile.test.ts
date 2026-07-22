import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the bug where the post-ingest reconcile ran inside the
// download-check guard (`_processing`), so a slow/hung reconcile froze
// completion detection — and completion detection is what fires the
// "Download Complete" Discord notification. The reconcile must run OUTSIDE that
// guard: while it's in flight, a fresh processDownloading() must still run the
// download loop.

const isComplete = vi.fn(async () => true);
const deleteTorrent = vi.fn(async () => {});
const getEpisodesByStatus = vi.fn();
const updateEpisodeStatus = vi.fn();
const sendDiscordNotification = vi.fn(async () => {});
const reconcilePlexMetadata = vi.fn();

vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ isComplete, deleteTorrent }),
}));
vi.mock("../src/db", () => ({
  getEpisodesByStatus,
  updateEpisodeStatus,
  getEpisodeByCrc32: vi.fn(),
  upsertEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
}));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32: vi.fn(async () => ({
    arcTitle: "Baratie",
    arcIndex: 4,
    arcPart: 5,
    episodeNum: 1,
    episodeTitle: "Sanji",
    extended: false,
    resolution: "1080p",
    crc32: "ABCD1234",
  })),
  buildPlexFilename: vi.fn(() => "One Pace - Baratie - S05E01 [1080p][ABCD1234].mkv"),
  isProvisionalKey: vi.fn(() => false),
  extractResolutionFromFilename: vi.fn(() => "1080p"),
  parseResolutionFromFilename: vi.fn(() => "1080p"),
  extractCrc32FromFilename: vi.fn(() => "ABCD1234"),
  getAllArcs: vi.fn(async () => []),
  getAllEpisodes: vi.fn(async () => []),
}));
vi.mock("../src/fileops", () => ({
  findDownloadedFile: vi.fn(() => "/downloads/file.mkv"), // dirname === DOWNLOAD_PATH → no batch siblings
  moveAndRename: vi.fn(() => ({ replaced: [] })),
  buildSeasonFolder: vi.fn(),
  scanBatchFiles: vi.fn(() => []),
}));
vi.mock("../src/plex", () => ({
  triggerLibraryScan: vi.fn(async () => {}),
  syncSingleEpisode: vi.fn(async () => {}),
  syncFullLibrary: vi.fn(async () => {}),
}));
vi.mock("../src/discord", () => ({ sendDiscordNotification }));
vi.mock("../src/posters", () => ({ ensureSeasonPoster: vi.fn(async () => {}) }));
vi.mock("../src/settings", () => ({
  getAutoPosters: () => false,
  getAutoReconcile: () => true,
}));
vi.mock("../src/coverage", () => ({
  getStoredCoverage: () => null, // skip coverage rescan
  scanCoverage: vi.fn(async () => {}),
}));
vi.mock("../src/onepace-descriptions", () => ({
  lookupEpisodeText: vi.fn(async () => null),
  lookupArcText: vi.fn(async () => null),
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: vi.fn(async () => null) }));
vi.mock("../src/metadata-audit", () => ({ reconcilePlexMetadata }));

const RECONCILE_RESULT = {
  episodesUpdated: 0, seasonsUpdated: 0, thumbsTriggered: 0,
  thumbsGenerated: 0, postersApplied: 0, flaggedEpisodes: 0, flaggedSeasons: 0,
};

const episode = {
  crc32: "ABCD1234", arc_num: 4, arc_title: "Baratie", arc_part: 5, episode_num: 1,
  resolution: "1080p", original_filename: "orig.mkv", final_filename: null,
  status: "downloading", torrent_hash: "hash1", magnet_uri: "magnet:?x",
  error_message: null, rss_guid: "guid1", changelog: [], extended: false,
  created_at: 0, updated_at: 0,
};

describe("processDownloading: reconcile does not block completion detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isComplete.mockResolvedValue(true);
  });

  it("runs the download loop again while a prior reconcile is still in flight", async () => {
    vi.useFakeTimers();
    const { processDownloading } = await import("../src/processor");

    // First completion resolves an episode; every later poll finds nothing.
    getEpisodesByStatus.mockReturnValueOnce([episode]).mockReturnValue([]);

    // Hold the reconcile "in flight" via a gate we control.
    let releaseReconcile!: () => void;
    const gate = new Promise<void>((r) => (releaseReconcile = r));
    reconcilePlexMetadata.mockReturnValue(gate.then(() => RECONCILE_RESULT));

    // Pass 1: completes the episode, then starts the (gated) reconcile.
    const p1 = processDownloading();
    await vi.advanceTimersByTimeAsync(6000); // past the hardcoded 5s post-scan wait

    expect(getEpisodesByStatus).toHaveBeenCalledTimes(1);
    expect(sendDiscordNotification).toHaveBeenCalledTimes(1); // completion notified
    expect(sendDiscordNotification.mock.calls[0][0].type).toBe("download_complete");
    expect(reconcilePlexMetadata).toHaveBeenCalledTimes(1); // reconcile started

    // Pass 2 while the reconcile is still gated. With the bug, `_processing`
    // would still be held and this call would return before touching the DB.
    const p2 = processDownloading();
    await vi.advanceTimersByTimeAsync(100);
    await p2;

    // The download loop ran a second time — the reconcile did NOT block it.
    expect(getEpisodesByStatus).toHaveBeenCalledTimes(2);

    releaseReconcile();
    await vi.advanceTimersByTimeAsync(100);
    await p1;
    vi.useRealTimers();
  });
});
