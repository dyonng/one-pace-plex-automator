import { describe, it, expect, vi, beforeEach } from "vitest";

// After an import fails partway (a qBittorrent outage, a crash), the torrent is
// still in the client because cleanup never ran. Retrying the episode then tries
// to add a torrent qBittorrent already holds, which qBit 5.x refuses with 409 —
// so every retried episode failed to dispatch and sat in "pending" forever, even
// though its download was sitting there complete.

const { getTorrent, addMagnet, updateEpisodeStatus, getEpisodesByStatus } = vi.hoisted(() => ({
  getTorrent: vi.fn(),
  addMagnet: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  getEpisodesByStatus: vi.fn(),
}));

vi.mock("../src/db", () => ({
  getEpisodesByStatus, updateEpisodeStatus,
  isGuidSeen: vi.fn(() => false), markGuidSeen: vi.fn(), upsertEpisode: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({ getQbitClient: () => ({ getTorrent, addMagnet }) }));
vi.mock("../src/rss", () => ({ fetchNewEpisodes: vi.fn(async () => []), toIsoDate: () => null }));
vi.mock("../src/metadata", () => ({
  resolveEpisodeByCrc32: vi.fn(), resolveArcByTitle: vi.fn(), resolveAliasedRelease: vi.fn(),
  extractResolutionFromFilename: () => "1080p", parseResolutionFromFilename: () => "1080p",
  isPreferredRelease: async () => true, parseReleaseTitle: () => null,
  provisionalKey: (a: number, e: number) => `PROV-${a}-${e}`,
}));
vi.mock("../src/onepace-sheet", () => ({ getArcResolution: async () => null }));
vi.mock("../src/processor", () => ({ processDownloading: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordNotification: vi.fn() }));
vi.mock("../src/settings", () => ({
  getAutoDownload: () => true, getPreferExtended: () => true,
  getArcFilter: () => ({ include: new Set(), exclude: new Set() }),
}));
vi.mock("../src/coverage", () => ({ getStoredCoverage: () => null, scanCoverage: vi.fn() }));

import { dispatchPending } from "../src/cycle";

const pending = (over: Record<string, unknown> = {}) => ({
  crc32: "602704E6", arc_num: 0, arc_title: "Skypiea", arc_part: 16, episode_num: 10,
  resolution: "1080p", original_filename: "", final_filename: null, status: "pending",
  torrent_hash: "68f3c17f1e97622d939f76ef5ff6039f7d770f73",
  magnet_uri: "magnet:?xt=urn:btih:68f3c17f1e97622d939f76ef5ff6039f7d770f73",
  error_message: null, rss_guid: "", changelog: [], extended: false,
  published_at: null, created_at: 0, updated_at: 0, ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("dispatching a retried episode", () => {
  it("reattaches to the torrent qBittorrent still holds instead of re-adding it", async () => {
    getEpisodesByStatus.mockReturnValue([pending()]);
    getTorrent.mockResolvedValue({ hash: "68f3c17f1e97622d939f76ef5ff6039f7d770f73", progress: 1 });

    await dispatchPending();

    expect(addMagnet).not.toHaveBeenCalled();
    expect(updateEpisodeStatus).toHaveBeenCalledWith("602704E6", "downloading");
  });

  it("adds the magnet normally when the torrent is gone", async () => {
    getEpisodesByStatus.mockReturnValue([pending()]);
    getTorrent.mockResolvedValue(null);
    addMagnet.mockResolvedValue("newhash");

    await dispatchPending();

    expect(addMagnet).toHaveBeenCalled();
    expect(updateEpisodeStatus).toHaveBeenCalledWith("602704E6", "downloading", { torrent_hash: "newhash" });
  });

  it("adds the magnet for a first-time episode that has no torrent yet", async () => {
    getEpisodesByStatus.mockReturnValue([pending({ torrent_hash: null })]);
    addMagnet.mockResolvedValue("freshhash");

    await dispatchPending();

    expect(getTorrent).not.toHaveBeenCalled();
    expect(addMagnet).toHaveBeenCalled();
  });
});
