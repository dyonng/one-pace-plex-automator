import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockNewer, mockResolve, mockFindExisting } = vi.hoisted(() => ({
  mockNewer: vi.fn(),
  mockResolve: vi.fn(),
  mockFindExisting: vi.fn(),
}));

vi.mock("../src/processor", () => ({
  newerFileAlreadyOnDisk: mockNewer,
}));
vi.mock("../src/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/metadata")>()),
  resolveEpisodeByCrc32: mockResolve,
  resolveArcByTitle: vi.fn(async () => null),
}));
vi.mock("../src/fileops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fileops")>()),
  findExistingEpisodeFile: mockFindExisting,
}));

import { prepareBatchDownload, type SelectionClient } from "../src/batch-fileselect";

function fakeClient(files: Array<{ index: number; name: string }>): SelectionClient & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  return {
    calls,
    addMagnet: vi.fn(async () => {
      calls.addMagnet = [true];
      return "hash123";
    }),
    getTorrentFiles: vi.fn(async () =>
      files.map((f) => ({ index: f.index, name: f.name, size: 100, progress: 0, priority: 1 }))
    ),
    setFilePriorities: vi.fn(async (hash: string, ids: number[], priority: 0 | 1) => {
      calls.setFilePriorities = [hash, ids, priority];
    }),
    pauseTorrents: vi.fn(async () => {}),
    resumeTorrents: vi.fn(async () => {
      calls.resumeTorrents = [true];
    }),
  };
}

const FILES = [
  { index: 0, name: "[One Pace][96-97] Loguetown 01 [1080p][7191C79A].mkv" },
  { index: 1, name: "[One Pace][98-99] Loguetown 02 [1080p][1EFBB55B].mkv" },
  { index: 2, name: "[One Pace][100] Loguetown 03 [1080p][BE8D8724].mkv" },
  { index: 3, name: "poster.jpg" },
];

function metaFor(crc: string) {
  const eps: Record<string, number> = { "7191C79A": 1, "1EFBB55B": 2, "BE8D8724": 3 };
  return {
    crc32: crc, arcIndex: 7, arcTitle: "Loguetown", arcSaga: "",
    arcPart: 8, arcDescription: "", episodeNum: eps[crc], episodeTitle: `Ep ${eps[crc]}`,
    episodeDescription: "", chapters: "", originalEpisodes: "", released: "",
    resolution: "1080p", extended: true, seasonEpisodeId: `s08e0${eps[crc]}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockImplementation(async (crc: string) => metaFor(crc));
});

describe("prepareBatchDownload", () => {
  it("adds paused, skips satisfied files, resumes", async () => {
    mockFindExisting.mockImplementation((title: string, _part: number, ep: number) => {
      if (ep === 1) return { filename: "One Pace - Loguetown - S08E01 [1080p][7191C79A].mkv", crc32: "7191C79A" };
      if (ep === 2) return { filename: "One Pace - Loguetown - S08E02 [480p][8E970FD4].mkv", crc32: "8E970FD4" };
      return null;
    });
    mockNewer.mockImplementation(async (_t: string, _p: number, ep: number) =>
      ep === 1 ? "keeper.mkv" : null
    );
    const client = fakeClient(FILES);

    const hash = await prepareBatchDownload("magnet:?xt=1", { client });

    expect(hash).toBe("hash123");
    expect(client.addMagnet).toHaveBeenCalledWith("magnet:?xt=1", { paused: true });
    expect(client.calls.setFilePriorities).toEqual(["hash123", [0], 0]);
    expect(client.calls.resumeTorrents).toEqual([true]);
  });

  it("keeps files whose slot is empty or an upgrade", async () => {
    mockFindExisting.mockReturnValue(null);
    mockNewer.mockResolvedValue(null);
    const client = fakeClient(FILES.slice(0, 2));

    await prepareBatchDownload("magnet:?xt=1", { client });

    expect(client.setFilePriorities).not.toHaveBeenCalled();
    expect(client.calls.resumeTorrents).toEqual([true]);
  });

  it("keeps unparseable filenames rather than risking the episode", async () => {
    mockFindExisting.mockReturnValue(null);
    const client = fakeClient([{ index: 0, name: "some random video.mkv" }]);

    await prepareBatchDownload("magnet:?xt=1", { client });

    expect(client.setFilePriorities).not.toHaveBeenCalled();
  });

  it("resumes without selecting when metadata never resolves", async () => {
    const client = fakeClient([]);
    (client.getTorrentFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const hash = await prepareBatchDownload("magnet:?xt=1", { client, metadataTimeoutMs: 0 });

    expect(hash).toBe("hash123");
    expect(client.setFilePriorities).not.toHaveBeenCalled();
    expect(client.calls.resumeTorrents).toEqual([true]);
  });

  it("resumes even when selection throws", async () => {
    mockFindExisting.mockImplementation(() => {
      throw new Error("disk gone");
    });
    const client = fakeClient(FILES.slice(0, 2));

    const hash = await prepareBatchDownload("magnet:?xt=1", { client });

    expect(hash).toBe("hash123");
    expect(client.calls.resumeTorrents).toEqual([true]);
  });
});
