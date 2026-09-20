import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk upgrade is what powers "download the missing episodes": a missing episode
// has no pipeline row, and upgrade is the only action that resolves a magnet
// without one. Two things must hold — it works for CRC32s with no record, and it
// still takes the lock exactly once for the whole batch.

const {
  getEpisodeByCrc32, updateEpisodeStatus, upsertEpisode, getKv,
  addMagnet, refreshCoverageIfPresent, findMagnetByCrc32, resolveEpisodeByCrc32,
} = vi.hoisted(() => ({
  getEpisodeByCrc32: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  upsertEpisode: vi.fn(),
  getKv: vi.fn(() => null),
  addMagnet: vi.fn(),
  refreshCoverageIfPresent: vi.fn(async () => {}),
  findMagnetByCrc32: vi.fn(),
  resolveEpisodeByCrc32: vi.fn(),
}));

vi.mock("../src/db", () => ({
  getEpisodeByCrc32,
  updateEpisodeStatus,
  upsertEpisode,
  getKv,
  deleteEpisode: vi.fn(),
  clearDoneEpisodes: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ addMagnet, deleteTorrent: vi.fn() }),
}));
vi.mock("../src/fileops", () => ({ deleteEpisodeFile: vi.fn() }));
vi.mock("../src/coverage", () => ({ refreshCoverageIfPresent }));
vi.mock("../src/cycle", () => ({ runCycle: vi.fn(), dispatchPending: vi.fn() }));
vi.mock("../src/processor", () => ({ runMetadataSync: vi.fn(), retryFailed: vi.fn() }));
vi.mock("../src/posters", () => ({ syncPosters: vi.fn(), resyncPosters: vi.fn() }));
vi.mock("../src/metadata", () => ({
  refreshMetadata: vi.fn(), clearMetadataCache: vi.fn(),
  resolveEpisodeByCrc32, extractResolutionFromFilename: vi.fn(() => "1080p"),
}));
vi.mock("../src/plex", () => ({ syncSingleEpisode: vi.fn(), triggerLibraryScan: vi.fn() }));
vi.mock("../src/rss", () => ({ findMagnetByCrc32 }));
vi.mock("../src/naming", () => ({ applyNamingRenames: vi.fn() }));
vi.mock("../src/onepace-sheet", () => ({ clearSheetCache: vi.fn(), prefetchSheet: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ clearDescriptionsCache: vi.fn(), prefetchDescriptions: vi.fn() }));
vi.mock("../src/onepacerr", () => ({ clearOnepacrrCache: vi.fn(), prefetchOnepacerr: vi.fn() }));
vi.mock("../src/metadata-audit", () => ({
  scanMetadataAudit: vi.fn(), reconcilePlexMetadata: vi.fn(),
  markDirtyFromSource: vi.fn(), retryThumbnails: vi.fn(), markPostersChecked: vi.fn(),
}));
vi.mock("../src/settings", () => ({ getAutoReconcile: vi.fn(() => false) }));

const { runBulkEpisodeAction, isBusy } = await import("../src/controls");

// Stands in for the episodes table: upgrade creates a row for an episode that has
// none, then re-reads it, so the mock has to behave like a store rather than
// always returning undefined.
let stored: Map<string, Record<string, unknown>>;

const rssItem = (crc32: string) => ({
  magnet: `magnet:?xt=urn:btih:${crc32.toLowerCase()}`,
  guid: `guid-${crc32}`,
  filename: `One Pace - Wano - S35E11 [1080p][${crc32}].mkv`,
  changelog: [],
});

const meta = (crc32: string) => ({
  crc32, arcIndex: 0, arcTitle: "Wano", arcPart: 35, episodeNum: 11,
  episodeTitle: "Episode 11", episodeDescription: "", chapters: "",
  originalEpisodes: "", released: "2024-01-01", resolution: "1080p",
  extended: false, seasonEpisodeId: "s35e11",
});

beforeEach(() => {
  vi.clearAllMocks();
  stored = new Map();
  getKv.mockReturnValue(null);
  addMagnet.mockResolvedValue("hash-new");
  refreshCoverageIfPresent.mockResolvedValue(undefined);
  resolveEpisodeByCrc32.mockImplementation((c: string) => Promise.resolve(meta(c)));
  getEpisodeByCrc32.mockImplementation((c: string) => stored.get(c));
  upsertEpisode.mockImplementation((r: Record<string, unknown>) => {
    stored.set(r.crc32 as string, { ...r, status: "available" });
  });
  updateEpisodeStatus.mockImplementation((c: string, status: string) => {
    const cur = stored.get(c);
    if (cur) stored.set(c, { ...cur, status });
  });
});

/** Episodes with no pipeline row, i.e. genuinely missing from disk. */
function allMissing() {
  stored.clear();
}

describe("bulk upgrade (download missing)", () => {
  it("starts a download for an episode with no pipeline row at all", async () => {
    allMissing();
    findMagnetByCrc32.mockResolvedValue(rssItem("AAAAAAAA"));

    const r = await runBulkEpisodeAction("upgrade", ["aaaaaaaa"]);

    expect(r.ok).toBe(true);
    expect(r.succeeded).toBe(1);
    // The record is created so the processor can track the download.
    expect(upsertEpisode).toHaveBeenCalledTimes(1);
    expect(addMagnet).toHaveBeenCalledWith("magnet:?xt=urn:btih:aaaaaaaa");
    expect(updateEpisodeStatus).toHaveBeenCalledWith("AAAAAAAA", "downloading", expect.anything());
  });

  it("reports 'not in feed' instead of failing the whole batch", async () => {
    allMissing();
    findMagnetByCrc32.mockResolvedValue(null);

    const r = await runBulkEpisodeAction("upgrade", ["aaaaaaaa"]);

    expect(r.ok).toBe(false);
    expect(r.results[0].message).toBe("No magnet found — episode not in RSS feed");
  });

  it("mixes downloadable and not-in-feed episodes in one batch", async () => {
    allMissing();
    findMagnetByCrc32.mockImplementation((c: string) =>
      Promise.resolve(c === "AAAAAAAA" ? rssItem("AAAAAAAA") : null)
    );

    const r = await runBulkEpisodeAction("upgrade", ["aaaaaaaa", "bbbbbbbb"]);

    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.message).toContain("1 of 2");
  });

  it("takes the lock once for the batch, not once per episode", async () => {
    allMissing();
    findMagnetByCrc32.mockImplementation((c: string) => Promise.resolve(rssItem(c)));

    const r = await runBulkEpisodeAction("upgrade", ["aaaaaaaa", "bbbbbbbb", "cccccccc"]);

    expect(r.succeeded).toBe(3);
    expect(addMagnet).toHaveBeenCalledTimes(3);
    // Re-entering the non-reentrant lock would have thrown "Busy" on episode two.
    expect(isBusy()).toBe(false);
  });

  it("refreshes coverage once for the batch", async () => {
    allMissing();
    findMagnetByCrc32.mockImplementation((c: string) => Promise.resolve(rssItem(c)));

    await runBulkEpisodeAction("upgrade", ["aaaaaaaa", "bbbbbbbb"]);

    expect(refreshCoverageIfPresent).toHaveBeenCalledTimes(1);
  });

  it("labels the batch as upgrades", async () => {
    allMissing();
    findMagnetByCrc32.mockImplementation((c: string) => Promise.resolve(rssItem(c)));

    const r = await runBulkEpisodeAction("upgrade", ["aaaaaaaa", "bbbbbbbb"]);

    expect(r.message).toBe("Started 2 episodes");
  });
});
