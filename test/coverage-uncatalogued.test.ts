import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards against offering a *downgrade*. A CRC32 mismatch between disk and the
// dataset's canonical release is only an upgrade when the on-disk file is a
// release the catalog knows (it retains historical CRC32s). A CRC32 the catalog
// has never seen came from a release that landed before the dataset regenerated —
// it is NEWER than the canonical one, so presenting "Update" would replace the
// newer file with an older one. That's what happened to One Piece Fan Letter:
// pinned to S00E98, whose catalogued CRC is the older 2024 release.

const { getAllEpisodes, getCatalogedCrc32s, readdirSync, statSync, existsSync } = vi.hoisted(() => ({
  getAllEpisodes: vi.fn(),
  getCatalogedCrc32s: vi.fn(),
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
vi.mock("../src/metadata", () => ({
  getAllEpisodes,
  getCatalogedCrc32s,
  extractCrc32FromFilename: (f: string) => (f.match(/\[([0-9A-Fa-f]{8})\]/)?.[1] ?? null),
}));
vi.mock("../src/rss", () => ({ getRssMagnetMap: async () => new Map() }));
vi.mock("../src/onepace-descriptions", () => ({ lookupEpisodeText: async () => null }));

import { scanCoverage } from "../src/coverage";

// One episode on disk whose CRC differs from the dataset's canonical CRC.
const CANONICAL = "9974A092"; // dataset's Fan Letter (2024)
const ON_DISK = "59510B34";   // the newer release we actually downloaded

function setupDisk() {
  readdirSync.mockImplementation((p: string) =>
    p === "/media"
      ? [{ name: "Season 00", isDirectory: () => true, isFile: () => false }]
      : [{ name: `One Pace - Specials - S00E98 [1080p][${ON_DISK}].mkv`, isDirectory: () => false, isFile: () => true }]
  );
  statSync.mockReturnValue({ size: 1000, isDirectory: () => false, isFile: () => true });
  getAllEpisodes.mockResolvedValue([
    {
      crc32: CANONICAL, arcIndex: 0, arcPart: 0, arcTitle: "Specials", arcSaga: "Specials",
      arcDescription: "", episodeNum: 98, episodeTitle: "One Piece Fan Letter",
      episodeDescription: "", chapters: "", originalEpisodes: "", released: "2024-11-29",
      resolution: "1080p", extended: false, seasonEpisodeId: "s00e98",
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  setupDisk();
});

describe("coverage: uncatalogued on-disk release", () => {
  it("does NOT offer an upgrade when the on-disk CRC32 is unknown to the catalog", async () => {
    getCatalogedCrc32s.mockResolvedValue(new Set([CANONICAL])); // ON_DISK not listed

    const report = await scanCoverage();
    const ep = report.arcs[0].episodes[0];

    expect(ep.status).toBe("present_uncatalogued");
    expect(report.totals.upgradeable).toBe(0);
    expect(report.totals.present).toBe(1);
  });

  it("DOES offer an upgrade when the on-disk CRC32 is a known older release", async () => {
    // The catalog knows both, so the on-disk one is genuinely superseded.
    getCatalogedCrc32s.mockResolvedValue(new Set([CANONICAL, ON_DISK]));

    const report = await scanCoverage();
    const ep = report.arcs[0].episodes[0];

    expect(ep.status).toBe("upgradeable");
    expect(report.totals.upgradeable).toBe(1);
  });

  it("reports an exact CRC32 match as plain present", async () => {
    readdirSync.mockImplementation((p: string) =>
      p === "/media"
        ? [{ name: "Season 00", isDirectory: () => true, isFile: () => false }]
        : [{ name: `One Pace - Specials - S00E98 [1080p][${CANONICAL}].mkv`, isDirectory: () => false, isFile: () => true }]
    );
    getCatalogedCrc32s.mockResolvedValue(new Set([CANONICAL]));

    const report = await scanCoverage();
    expect(report.arcs[0].episodes[0].status).toBe("present");
  });
});
