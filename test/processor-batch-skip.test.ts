import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { mockDeleteTorrent, mockMoveAndRename, mockFindExisting, mockResolve, mockCataloged } =
  vi.hoisted(() => ({
    mockDeleteTorrent: vi.fn(),
    mockMoveAndRename: vi.fn(),
    mockFindExisting: vi.fn(),
    mockResolve: vi.fn(),
    mockCataloged: vi.fn(),
  }));

vi.mock("../src/db", () => ({
  getEpisodeByCrc32: vi.fn(() => null),
  getEpisodesByStatus: vi.fn(() => []),
  getRetryableFailed: vi.fn(() => []),
  upsertEpisode: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  deleteEpisode: vi.fn(),
  recordDownloadProgress: vi.fn(),
  scheduleRetry: vi.fn(),
  clearRetryState: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ deleteTorrent: mockDeleteTorrent }),
  isTorrentComplete: () => true,
}));
vi.mock("../src/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/metadata")>()),
  resolveEpisodeByCrc32: mockResolve,
  getCatalogedCrc32s: mockCataloged,
}));
vi.mock("../src/fileops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fileops")>()),
  moveAndRename: mockMoveAndRename,
  findExistingEpisodeFile: mockFindExisting,
}));
vi.mock("../src/plex", () => ({
  triggerLibraryScan: vi.fn(),
  syncSingleEpisode: vi.fn(),
  syncFullLibrary: vi.fn(),
}));
vi.mock("../src/discord", () => ({
  sendDiscordNotification: vi.fn(),
}));
vi.mock("../src/posters", () => ({
  ensureSeasonPoster: vi.fn(),
}));
vi.mock("../src/settings", () => ({
  getAutoPosters: vi.fn(() => false),
  getAutoReconcile: vi.fn(() => false),
}));

import { importVideos } from "../src/processor";

let batchDir = "";

function meta(episodeNum: number, crc: string) {
  return {
    crc32: crc, arcIndex: 7, arcTitle: "Loguetown", arcSaga: "",
    arcPart: 8, arcDescription: "", episodeNum, episodeTitle: `Ep ${episodeNum}`,
    episodeDescription: "", chapters: "", originalEpisodes: "", released: "",
    resolution: "1080p", extended: true, seasonEpisodeId: `s08e0${episodeNum}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCataloged.mockResolvedValue(new Set(["7191C79A", "1EFBB55B"]));
  mockResolve.mockImplementation(async (crc: string) => {
    if (crc === "7191C79A") return meta(1, crc);
    if (crc === "1EFBB55B") return meta(2, crc);
    throw new Error(`CRC32 ${crc} is not in the dataset`);
  });
  // Ep01: library holds a newer uncatalogued file; ep02: library holds 480p.
  mockFindExisting.mockImplementation((_t: string, _p: number, ep: number) =>
    ep === 1
      ? { filename: "One Pace - Loguetown - S08E01 [1080p][4200CE0D].mkv", crc32: "4200CE0D" }
      : { filename: "One Pace - Loguetown - S08E02 [480p][8E970FD4].mkv", crc32: "8E970FD4" }
  );
  mockMoveAndRename.mockReturnValue({ replaced: [] });

  batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-"));
  // Primary sorts first and is the LARGER file, so importVideos picks it.
  fs.writeFileSync(path.join(batchDir, "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv"), "x".repeat(200));
  fs.writeFileSync(path.join(batchDir, "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv"), "x".repeat(100));
});

afterEach(() => {
  fs.rmSync(batchDir, { recursive: true, force: true });
});

describe("importVideos with an older primary in a batch", () => {
  it("still imports upgradeable siblings instead of dropping the batch", async () => {
    const videos = [
      {
        filePath: path.join(batchDir, "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv"),
        filename: "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv",
        crc32: "7191C79A",
      },
      {
        filePath: path.join(batchDir, "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv"),
        filename: "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv",
        crc32: "1EFBB55B",
      },
    ];
    const ep = {
      crc32: "PROV-8-0-E", arc_num: 7, arc_title: "Loguetown", arc_part: 8,
      episode_num: 0, resolution: "1080p", original_filename: "batch",
      final_filename: null, status: "downloading", torrent_hash: "hash123",
      magnet_uri: "magnet:?xt=1", error_message: null, rss_guid: "g",
      changelog: [], extended: true,
    };

    const imported = await importVideos(ep as never, videos, "hash123");

    expect(imported).toBe(true);
    expect(mockMoveAndRename).toHaveBeenCalledTimes(1);
    expect(mockMoveAndRename.mock.calls[0][0]).toContain("1EFBB55B");
    expect(mockDeleteTorrent).toHaveBeenCalledWith("hash123", false);
  }, 20000);

  it("returns false and only cleans up when no sibling is wanted", async () => {
    fs.unlinkSync(path.join(batchDir, "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv"));
    const videos = [
      {
        filePath: path.join(batchDir, "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv"),
        filename: "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv",
        crc32: "7191C79A",
      },
    ];
    const ep = {
      crc32: "PROV-8-0-E", arc_num: 7, arc_title: "Loguetown", arc_part: 8,
      episode_num: 0, resolution: "1080p", original_filename: "batch",
      final_filename: null, status: "downloading", torrent_hash: "hash123",
      magnet_uri: "magnet:?xt=1", error_message: null, rss_guid: "g",
      changelog: [], extended: true,
    };

    const imported = await importVideos(ep as never, videos, "hash123");

    expect(imported).toBe(false);
    expect(mockMoveAndRename).not.toHaveBeenCalled();
    expect(mockDeleteTorrent).toHaveBeenCalledWith("hash123", false);
  });

  it("refuses to file an unplaceable companion as the batch primary", async () => {
    const companion = "[One Pace][97.5] Loguetown 01.5 [1080p][DEADBEEF].mkv";
    fs.writeFileSync(path.join(batchDir, companion), "x".repeat(300));
    const videos = [
      {
        filePath: path.join(batchDir, companion),
        filename: companion,
        crc32: "DEADBEEF",
      },
      {
        filePath: path.join(batchDir, "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv"),
        filename: "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv",
        crc32: "7191C79A",
      },
      {
        filePath: path.join(batchDir, "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv"),
        filename: "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv",
        crc32: "1EFBB55B",
      },
    ];
    const ep = {
      crc32: "PROV-8-0-E", arc_num: 7, arc_title: "Loguetown", arc_part: 8,
      episode_num: 0, resolution: "1080p", original_filename: "batch",
      final_filename: null, status: "downloading", torrent_hash: "hash123",
      magnet_uri: "magnet:?xt=1", error_message: null, rss_guid: "g",
      changelog: [], extended: true,
    };

    const imported = await importVideos(ep as never, videos, "hash123");

    expect(imported).toBe(true);
    expect(mockMoveAndRename).toHaveBeenCalledTimes(1);
    expect(mockMoveAndRename.mock.calls[0][0]).toContain("1EFBB55B");
    expect(mockDeleteTorrent).toHaveBeenCalledWith("hash123", false);
  }, 20000);
});
