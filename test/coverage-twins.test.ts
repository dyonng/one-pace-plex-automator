import { describe, it, expect, vi, beforeEach } from "vitest";

// The dataset occasionally lists one release under two episode numbers —
// Post-Enies Lobby 05 and 06 share CRC32 CEF78887 (a re-cut renumbering
// leaving a stale row). The twin slot must see the bytes already on disk,
// not report a phantom "missing" that sends the backfill chasing a pack
// whose file would import into the other slot and be skipped.

const { getAllEpisodes, getCatalogedCrc32s, readdirSync, existsSync } = vi.hoisted(() => ({
  getAllEpisodes: vi.fn(),
  getCatalogedCrc32s: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock("fs", () => ({
  default: { existsSync, readdirSync },
  existsSync, readdirSync,
}));
vi.mock("../src/constants", () => ({ MEDIA_PATH: "/media" }));
vi.mock("../src/db", () => ({
  getKv: vi.fn(() => null),
  setKv: vi.fn(),
  getEpisodeByCrc32: vi.fn(() => null),
  getEpisodesByStatus: vi.fn(() => []),
}));
vi.mock("../src/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/metadata")>()),
  getAllEpisodes,
  getCatalogedCrc32s,
  extractCrc32FromFilename: (f: string) => (f.match(/\[([0-9A-Fa-f]{8})\]/)?.[1] ?? null),
}));
vi.mock("../src/rss", () => ({ getRssMagnetMap: async () => new Map() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null }));

import { scanCoverage } from "../src/coverage";

const CRC = "CEF78887";
const FILENAME = `One Pace - Post-Enies Lobby - S20E05 [1080p][${CRC}].mkv`;

function entry(episodeNum: number, overrides = {}) {
  return {
    crc32: CRC, arcIndex: 20, arcPart: 20, arcTitle: "Post-Enies Lobby", arcSaga: "Water 7",
    arcDescription: "", episodeNum, episodeTitle: `Post-Enies Lobby 0${episodeNum}`,
    episodeDescription: "", chapters: "440-441", originalEpisodes: "", released: "2021-01-01",
    resolution: "1080p", extended: false, seasonEpisodeId: `s20e0${episodeNum}`,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  readdirSync.mockImplementation((p: string) =>
    p === "/media"
      ? [{ name: "Season 20", isDirectory: () => true, isFile: () => false }]
      : [{ name: FILENAME, isDirectory: () => false, isFile: () => true }]
  );
  getCatalogedCrc32s.mockResolvedValue(new Set([CRC]));
  getAllEpisodes.mockResolvedValue([entry(5), entry(6)]);
});

describe("coverage: duplicate-CRC twin slots", () => {
  it("reports the twin slot present off the same file, not missing", async () => {
    const report = await scanCoverage();
    const eps = report.arcs[0].episodes;

    expect(eps).toHaveLength(2);
    expect(eps[0].status).toBe("present");
    expect(eps[1].status).toBe("present");
    expect(eps[1].diskFilename).toBe(FILENAME);
    expect(report.totals.missing).toBe(0);
    expect(report.totals.present).toBe(2);
  });

  it("does not match twins across arcs", async () => {
    getAllEpisodes.mockResolvedValue([entry(5), entry(6, { arcPart: 21, arcTitle: "Other", seasonEpisodeId: "s21e06", episodeTitle: "Other 06" })]);

    const report = await scanCoverage();
    const other = report.arcs.find((a) => a.arcPart === 21)!;

    expect(other.episodes[0].status).toBe("missing");
    expect(report.totals.missing).toBe(1);
  });
});
