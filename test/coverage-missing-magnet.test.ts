import { describe, it, expect, vi, beforeEach } from "vitest";

// A "missing" episode is the one case where the magnet is the whole story: it is
// the only thing that makes the episode downloadable. Computing hasMagnet only
// for "upgradeable" made every missing row report false regardless of what the
// feed held, so the dashboard showed missing episodes as unavailable and offered
// no way to fetch them — even when a link existed.

const { getAllEpisodes, getCatalogedCrc32s, getRssMagnetMap, readdirSync, statSync, existsSync } =
  vi.hoisted(() => ({
    getAllEpisodes: vi.fn(),
    getCatalogedCrc32s: vi.fn(),
    getRssMagnetMap: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    existsSync: vi.fn(() => true),
  }));

vi.mock("fs", () => ({
  default: { existsSync, readdirSync, statSync },
  existsSync, readdirSync, statSync,
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
vi.mock("../src/rss", () => ({ getRssMagnetMap }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null }));

import { scanCoverage } from "../src/coverage";

const CANONICAL = "AAAAAAAA";

// Empty media dir: nothing is on disk, so the episode is "missing".
function emptyDisk() {
  readdirSync.mockImplementation(() => []);
  statSync.mockReturnValue({ size: 1000, isDirectory: () => false, isFile: () => true });
}

function oneEpisode() {
  getAllEpisodes.mockResolvedValue([
    {
      crc32: CANONICAL, arcIndex: 0, arcPart: 35, arcTitle: "Wano", arcSaga: "Wano",
      arcDescription: "", episodeNum: 11, episodeTitle: "Episode 11",
      episodeDescription: "", chapters: "", originalEpisodes: "", released: "2024-11-29",
      resolution: "1080p", extended: false, seasonEpisodeId: "s35e11",
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  emptyDisk();
  oneEpisode();
  getCatalogedCrc32s.mockResolvedValue(new Set([CANONICAL]));
});

describe("coverage: magnet availability for missing episodes", () => {
  it("reports hasMagnet when the feed holds a link for a missing episode", async () => {
    getRssMagnetMap.mockResolvedValue(
      new Map([[CANONICAL, { magnet: "magnet:?xt=urn:btih:deadbeef", guid: "g1", filename: `x [${CANONICAL}].mkv`, changelog: [] }]])
    );

    const ep = (await scanCoverage()).arcs[0].episodes[0];

    expect(ep.status).toBe("missing");
    expect(ep.hasMagnet).toBe(true);
  });

  it("reports hasMagnet false when the feed has no link, so the UI can ask for a search", async () => {
    getRssMagnetMap.mockResolvedValue(new Map());

    const ep = (await scanCoverage()).arcs[0].episodes[0];

    expect(ep.status).toBe("missing");
    expect(ep.hasMagnet).toBe(false);
  });

  it("still reports hasMagnet false for a missing episode whose link is only a stale DB row", async () => {
    // getEpisodeByCrc32 is mocked to null, so there is no stored magnet either.
    getRssMagnetMap.mockResolvedValue(new Map());

    const report = await scanCoverage();

    expect(report.totals.missing).toBe(1);
    expect(report.arcs[0].episodes[0].hasMagnet).toBe(false);
  });
});
