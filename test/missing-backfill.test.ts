import { describe, it, expect, vi, beforeEach } from "vitest";

const { kv, coverageReport } = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  coverageReport: { value: null as unknown },
}));

const { mockSearch, mockResolve, mockAddMagnet, mockNotify } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockResolve: vi.fn(),
  mockAddMagnet: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock("../src/db", () => ({
  getKv: vi.fn((k: string) => kv.get(k) ?? null),
  setKv: vi.fn((k: string, v: string) => void kv.set(k, v)),
  getEpisodeByCrc32: vi.fn(() => null),
  getEpisodesByStatus: vi.fn(() => []),
  upsertEpisode: vi.fn(),
  updateEpisodeStatus: vi.fn(),
}));
vi.mock("../src/coverage", () => ({
  getStoredCoverage: () => coverageReport.value,
}));
vi.mock("../src/torrent-search", () => ({
  searchTorrents: mockSearch,
}));
vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ addMagnet: mockAddMagnet }),
}));
vi.mock("../src/discord", () => ({
  sendDiscordNotification: mockNotify,
}));
vi.mock("../src/settings", () => ({
  getAutoSearchMissing: vi.fn(() => true),
  getMissingSearchPerCycle: vi.fn(() => 2),
  getAutoDownload: vi.fn(() => true),
  getSettingValue: vi.fn(() => ""),
}));
vi.mock("../src/rss", () => ({
  toIsoDate: () => null,
}));
vi.mock("../src/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/metadata")>()),
  resolveEpisodeByCrc32: mockResolve,
}));

import { backfillMissing } from "../src/missing-backfill";
import { getAutoSearchMissing } from "../src/settings";

function ep(crc: string, overrides = {}) {
  return {
    arcPart: 35, arcTitle: "Fishman Island", episodeNum: 2,
    seasonEpisodeId: "s35e02", episodeTitle: "Ep 2",
    datasetCrc32: crc, status: "missing",
    diskFilename: null, diskCrc32: null, hasMagnet: false, extended: false,
    ...overrides,
  };
}

function report(episodes: unknown[]) {
  return {
    scannedAt: Date.now(), mediaPath: "/media", mediaPathExists: true,
    totals: { episodes: 1, present: 0, missing: 1, upgradeable: 0, downloading: 0 },
    arcs: [{ arcPart: 35, arcTitle: "Fishman Island", arcSaga: "", total: 1, present: 0, missing: 1, upgradeable: 0, downloading: 0, seasonFolder: null, episodes }],
    extras: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  mockAddMagnet.mockResolvedValue("hash123");
  mockResolve.mockImplementation(async (crc: string) => ({
    crc32: crc, arcIndex: 0, arcTitle: "Fishman Island", arcSaga: "",
    arcPart: 35, arcDescription: "", episodeNum: 2, episodeTitle: "Ep 2",
    episodeDescription: "", chapters: "", originalEpisodes: "", released: "",
    resolution: "1080p", extended: false, seasonEpisodeId: "s35e02",
  }));
});

describe("missing backfill", () => {
  it("queues a hasMagnet target without searching", async () => {
    coverageReport.value = report([ep("AAAAAAAA", { hasMagnet: true })]) as never;
    kv.set("magnet:AAAAAAAA", JSON.stringify({ magnet: "magnet:?xt=1" }));

    const queued = await backfillMissing();

    expect(queued).toBe(1);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAddMagnet).toHaveBeenCalledWith("magnet:?xt=1");
  });

  it("searches and queues the best seeded match", async () => {
    coverageReport.value = report([ep("BBBBBBBB")]) as never;
    mockSearch.mockResolvedValue([
      { source: "nyaa", title: "[One Pace] Fishman Island 02 [1080p]", magnet: "magnet:?xt=low", torrentUrl: null, infoHash: "a", size: 1, seeders: 2, leechers: 0, publishedAt: null, pageUrl: null, isBatch: false },
      { source: "animetosho", title: "[One Pace] Fishman Island 02 [1080p]", magnet: "magnet:?xt=high", torrentUrl: null, infoHash: "b", size: 1, seeders: 50, leechers: 1, publishedAt: null, pageUrl: null, isBatch: false },
      { source: "nyaa", title: "[One Pace] Fishman Island 03 [1080p]", magnet: "magnet:?xt=wrong", torrentUrl: null, infoHash: "c", size: 1, seeders: 99, leechers: 0, publishedAt: null, pageUrl: null, isBatch: false },
    ]);

    const queued = await backfillMissing();

    expect(mockSearch).toHaveBeenCalledWith("One Pace Fishman Island 02");
    expect(queued).toBe(1);
    expect(mockAddMagnet).toHaveBeenCalledWith("magnet:?xt=high");
  });

  it("records a negative attempt when nothing matches", async () => {
    coverageReport.value = report([ep("CCCCCCCC")]) as never;
    mockSearch.mockResolvedValue([]);

    const queued = await backfillMissing();

    expect(queued).toBe(0);
    expect(kv.get("backfill_attempt:CCCCCCCC")).toBeTruthy();
  });

  it("skips targets attempted within 24h", async () => {
    coverageReport.value = report([ep("DDDDDDDD")]) as never;
    kv.set("backfill_attempt:DDDDDDDD", String(Date.now()));

    const queued = await backfillMissing();

    expect(queued).toBe(0);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("does nothing when auto-search is off", async () => {
    vi.mocked(getAutoSearchMissing).mockReturnValueOnce(false);
    coverageReport.value = report([ep("EEEEEEEE")]) as never;

    expect(await backfillMissing()).toBe(0);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
