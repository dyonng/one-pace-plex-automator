import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk retry/remove from the episodes table. The trap here is the action lock:
// it is a plain boolean, not reentrant, so an implementation that loops over the
// single-episode action would abort on the second episode with "Busy". These
// tests pin the single-acquisition behaviour and the per-episode error isolation.

const {
  getEpisodeByCrc32, updateEpisodeStatus, deleteEpisode,
  addMagnet, deleteTorrent, deleteEpisodeFile, refreshCoverageIfPresent,
} = vi.hoisted(() => ({
  getEpisodeByCrc32: vi.fn(),
  updateEpisodeStatus: vi.fn(),
  deleteEpisode: vi.fn(),
  addMagnet: vi.fn(),
  deleteTorrent: vi.fn(),
  deleteEpisodeFile: vi.fn(),
  refreshCoverageIfPresent: vi.fn(async () => {}),
}));

vi.mock("../src/db", () => ({
  getEpisodeByCrc32,
  updateEpisodeStatus,
  deleteEpisode,
  getKv: vi.fn(() => null),
  upsertEpisode: vi.fn(),
  clearDoneEpisodes: vi.fn(),
}));
vi.mock("../src/qbittorrent", () => ({
  getQbitClient: () => ({ addMagnet, deleteTorrent }),
}));
vi.mock("../src/fileops", () => ({ deleteEpisodeFile }));
vi.mock("../src/coverage", () => ({ refreshCoverageIfPresent }));
// Keep the heavy/unrelated action graph out of the way.
vi.mock("../src/cycle", () => ({ runCycle: vi.fn(), dispatchPending: vi.fn() }));
vi.mock("../src/processor", () => ({ runMetadataSync: vi.fn(), retryFailed: vi.fn() }));
vi.mock("../src/posters", () => ({ syncPosters: vi.fn(), resyncPosters: vi.fn() }));
vi.mock("../src/metadata", () => ({
  refreshMetadata: vi.fn(), clearMetadataCache: vi.fn(),
  resolveEpisodeByCrc32: vi.fn(), extractResolutionFromFilename: vi.fn(() => "1080p"),
}));
vi.mock("../src/plex", () => ({ syncSingleEpisode: vi.fn(), triggerLibraryScan: vi.fn() }));
vi.mock("../src/rss", () => ({ findMagnetByCrc32: vi.fn() }));
vi.mock("../src/naming", () => ({ applyNamingRenames: vi.fn() }));
vi.mock("../src/onepace-sheet", () => ({ clearSheetCache: vi.fn(), prefetchSheet: vi.fn() }));
vi.mock("../src/onepace-descriptions", () => ({ clearDescriptionsCache: vi.fn(), prefetchDescriptions: vi.fn() }));
vi.mock("../src/onepacerr", () => ({ clearOnepacerrCache: vi.fn(), prefetchOnepacerr: vi.fn() }));
vi.mock("../src/metadata-audit", () => ({
  scanMetadataAudit: vi.fn(), reconcilePlexMetadata: vi.fn(),
  markDirtyFromSource: vi.fn(), retryThumbnails: vi.fn(), markPostersChecked: vi.fn(),
}));
vi.mock("../src/settings", () => ({ getAutoReconcile: vi.fn(() => false) }));

const { runBulkEpisodeAction, isBusy } = await import("../src/controls");

const record = (crc32: string, over: Record<string, unknown> = {}) => ({
  crc32,
  arc_num: 1,
  arc_title: "Arlong Park",
  arc_part: 6,
  episode_num: 9,
  resolution: "1080p",
  original_filename: "",
  final_filename: null,
  status: "failed",
  torrent_hash: null,
  magnet_uri: "magnet:?xt=urn:btih:abc",
  error_message: null,
  rss_guid: "",
  changelog: [],
  extended: false,
  published_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  addMagnet.mockResolvedValue("hash-new");
  deleteTorrent.mockResolvedValue(undefined);
  deleteEpisodeFile.mockReturnValue(true);
  refreshCoverageIfPresent.mockResolvedValue(undefined);
});

describe("runBulkEpisodeAction", () => {
  it("retries every selected episode under a single lock acquisition", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) => record(c));

    const r = await runBulkEpisodeAction("retry", ["aaaa", "bbbb", "cccc"]);

    expect(r.ok).toBe(true);
    expect(r.succeeded).toBe(3);
    expect(r.failed).toBe(0);
    // Would have thrown "Busy: ..." on the second episode if the lock were re-entered.
    expect(addMagnet).toHaveBeenCalledTimes(3);
    expect(updateEpisodeStatus).toHaveBeenCalledTimes(3);
    // Released afterwards, so the next action is not blocked.
    expect(isBusy()).toBe(false);
  });

  it("keeps going when one episode fails and reports the split", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) => record(c));
    addMagnet.mockImplementation((m: string) => {
      if (m.includes("bad")) throw new Error("qBittorrent refused the torrent");
      return Promise.resolve("hash-new");
    });
    getEpisodeByCrc32.mockImplementation((c: string) =>
      record(c, { magnet_uri: c === "BBBB" ? "magnet:bad" : "magnet:good" })
    );

    const r = await runBulkEpisodeAction("retry", ["aaaa", "bbbb", "cccc"]);

    expect(r.ok).toBe(false);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.message).toContain("2 of 3");
    // The failure is attributed to the right row.
    expect(r.results.find((x) => x.crc32 === "BBBB")).toEqual({
      crc32: "BBBB", ok: false, message: "qBittorrent refused the torrent",
    });
  });

  it("releases the lock even when every episode fails", async () => {
    getEpisodeByCrc32.mockReturnValue(record("aaaa"));
    addMagnet.mockRejectedValue(new Error("down"));

    const r = await runBulkEpisodeAction("retry", ["aaaa"]);

    expect(r.ok).toBe(false);
    expect(isBusy()).toBe(false);
  });

  it("dedupes and upper-cases the CRC32 list", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) => record(c));

    await runBulkEpisodeAction("retry", ["aaaa", "AAAA", "aaaa"]);

    expect(addMagnet).toHaveBeenCalledTimes(1);
    expect(getEpisodeByCrc32).toHaveBeenCalledWith("AAAA");
  });

  it("reports episodes that vanished rather than throwing", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) => (c === "GONE" ? undefined : record(c)));

    const r = await runBulkEpisodeAction("retry", ["keep", "gone"]);

    expect(r.succeeded).toBe(1);
    expect(r.results.find((x) => x.crc32 === "GONE")?.message).toBe("Not found");
  });

  it("refuses an empty selection without touching the lock", async () => {
    const r = await runBulkEpisodeAction("retry", []);

    expect(r.ok).toBe(false);
    expect(r.message).toBe("No episodes selected");
    expect(addMagnet).not.toHaveBeenCalled();
  });

  it("skips episodes that are already downloading", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) =>
      record(c, { status: c === "BBBB" ? "downloading" : "failed" })
    );

    const r = await runBulkEpisodeAction("retry", ["aaaa", "bbbb"]);

    expect(r.succeeded).toBe(1);
    expect(r.results.find((x) => x.crc32 === "BBBB")?.message).toBe("Already downloading");
    expect(addMagnet).toHaveBeenCalledTimes(1);
  });

  it("removes episodes and cancels their in-flight torrents", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) =>
      record(c, { status: "downloading", torrent_hash: `hash-${c}` })
    );

    const r = await runBulkEpisodeAction("remove", ["aaaa", "bbbb"]);

    expect(r.ok).toBe(true);
    expect(deleteEpisode).toHaveBeenCalledTimes(2);
    expect(deleteTorrent).toHaveBeenCalledTimes(2);
    // Files are kept unless explicitly asked for.
    expect(deleteEpisodeFile).not.toHaveBeenCalled();
  });

  it("deletes files only when asked, and only when there is one", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) =>
      record(c, { status: "done", final_filename: c === "AAAA" ? "file.mkv" : null })
    );

    const r = await runBulkEpisodeAction("remove", ["aaaa", "bbbb"], { deleteFile: true });

    expect(r.ok).toBe(true);
    expect(deleteEpisodeFile).toHaveBeenCalledTimes(1);
    expect(deleteEpisodeFile).toHaveBeenCalledWith("Arlong Park", 6, "file.mkv");
  });

  it("refreshes coverage once for the batch, not once per episode", async () => {
    getEpisodeByCrc32.mockImplementation((c: string) => record(c));

    await runBulkEpisodeAction("retry", ["aaaa", "bbbb", "cccc"]);

    expect(refreshCoverageIfPresent).toHaveBeenCalledTimes(1);
  });

  it("does not refresh coverage when nothing succeeded", async () => {
    getEpisodeByCrc32.mockReturnValue(undefined);

    await runBulkEpisodeAction("retry", ["aaaa"]);

    expect(refreshCoverageIfPresent).not.toHaveBeenCalled();
  });
});
