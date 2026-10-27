import { describe, it, expect, vi, beforeEach } from "vitest";

const { kv, coverageReport } = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  coverageReport: { value: null as unknown },
}));

const { mockSearch, mockResolve, mockAddMagnet, mockNotify, mockPrepare } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockResolve: vi.fn(),
  mockAddMagnet: vi.fn(),
  mockNotify: vi.fn(),
  mockPrepare: vi.fn(),
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
vi.mock("../src/batch-fileselect", () => ({
  prepareBatchDownload: mockPrepare,
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
  mockPrepare.mockResolvedValue("packhash");
  mockSearch.mockResolvedValue([]);
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

  it("queues an arc pack when no single release matches", async () => {
    coverageReport.value = report([ep("FFFFFFFF")]) as never;
    mockSearch.mockResolvedValue([
      { source: "nyaa", title: "[One Pace][10-11] Fishman Island [720p]", magnet: "magnet:?xt=pack", torrentUrl: null, infoHash: "d", size: 2 * 1024 ** 3, seeders: 5, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
    ]);

    const queued = await backfillMissing();

    expect(queued).toBe(1);
    expect(mockPrepare).toHaveBeenCalledWith("magnet:?xt=pack");
    expect(mockAddMagnet).not.toHaveBeenCalled();
    expect(kv.get("backfill_attempt:FFFFFFFF")).toBeTruthy();
  });

  it("finds packs with an arc-wide retry query", async () => {
    coverageReport.value = report([ep("55555555")]) as never;
    mockSearch
      .mockResolvedValueOnce([]) // episode-numbered query: nothing usable
      .mockResolvedValueOnce([
        { source: "nyaa", title: "[One Pace][10-11] Fishman Island [720p]", magnet: "magnet:?xt=pack", torrentUrl: null, infoHash: "d", size: 2 * 1024 ** 3, seeders: 5, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
      ]);

    const queued = await backfillMissing();

    expect(mockSearch).toHaveBeenNthCalledWith(2, "One Pace Fishman Island");
    expect(queued).toBe(1);
    expect(mockPrepare).toHaveBeenCalledWith("magnet:?xt=pack");
  });

  it("skips dead, oversized, and wrong-arc packs", async () => {
    coverageReport.value = report([
      ep("11111111"),
      ep("22222222"),
      ep("33333333"),
    ]) as never;
    mockSearch
      .mockResolvedValueOnce([ // dead pack
        { source: "nyaa", title: "[One Pace][10-11] Fishman Island [720p]", magnet: "magnet:?xt=dead", torrentUrl: null, infoHash: "d", size: 2 * 1024 ** 3, seeders: 0, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
      ])
      .mockResolvedValueOnce([ // pack over the size cap
        { source: "animetosho", title: "[One Pace] Fishman Island [2160p]", magnet: "magnet:?xt=huge", torrentUrl: null, infoHash: "e", size: 325 * 1024 ** 3, seeders: 50, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
      ])
      .mockResolvedValueOnce([ // pack for a different arc
        { source: "nyaa", title: "[One Pace][10-11] Punk Hazard [720p]", magnet: "magnet:?xt=wrong", torrentUrl: null, infoHash: "f", size: 2 * 1024 ** 3, seeders: 50, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
      ]);

    const queued = await backfillMissing();

    expect(queued).toBe(0);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("does not queue packs for upgradeable targets", async () => {
    coverageReport.value = report([ep("44444444", { status: "upgradeable" })]) as never;
    mockSearch.mockResolvedValue([
      { source: "nyaa", title: "[One Pace][10-11] Fishman Island [720p]", magnet: "magnet:?xt=pack", torrentUrl: null, infoHash: "d", size: 2 * 1024 ** 3, seeders: 5, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
    ]);

    expect(await backfillMissing()).toBe(0);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockAddMagnet).not.toHaveBeenCalled();
  });

  it("skips sources proven unable to fill the slot", async () => {
    coverageReport.value = report([ep("FFFFFFFF")]) as never;
    const dead = "a".repeat(40);
    const live = "b".repeat(40);
    kv.set("backfill_excluded:FFFFFFFF", JSON.stringify([dead]));
    mockSearch.mockResolvedValue([
      { source: "nyaa", title: "[One Pace] Fishman Island 02 [1080p]", magnet: `magnet:?xt=urn:btih:${dead}`, torrentUrl: null, infoHash: dead, size: 1e9, seeders: 100, leechers: 0, publishedAt: null, pageUrl: null, isBatch: false },
      { source: "nyaa", title: "[One Pace] Fishman Island 02 [1080p]", magnet: `magnet:?xt=urn:btih:${live}`, torrentUrl: null, infoHash: live, size: 1e9, seeders: 50, leechers: 0, publishedAt: null, pageUrl: null, isBatch: false },
    ]);

    expect(await backfillMissing()).toBe(1);
    expect(mockAddMagnet).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${live}`);
  });

  it("does not re-queue an excluded pack, by infoHash or magnet", async () => {
    coverageReport.value = report([ep("FFFFFFFF")]) as never;
    const h1 = "c".repeat(40);
    const h2 = "d".repeat(40);
    kv.set("backfill_excluded:FFFFFFFF", JSON.stringify([h1, h2]));
    mockSearch.mockResolvedValue([
      { source: "nyaa", title: "[One Pace][10-11] Fishman Island [720p]", magnet: "magnet:?xt=pack1", torrentUrl: null, infoHash: h1, size: 2 * 1024 ** 3, seeders: 50, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
      { source: "nyaa", title: "[One Pace][10-11] Fishman Island [1080p]", magnet: `magnet:?xt=urn:btih:${h2}&dn=pack`, torrentUrl: null, infoHash: null, size: 4 * 1024 ** 3, seeders: 60, leechers: 0, publishedAt: null, pageUrl: null, isBatch: true },
    ]);

    expect(await backfillMissing()).toBe(0);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockAddMagnet).not.toHaveBeenCalled();
  });
});
