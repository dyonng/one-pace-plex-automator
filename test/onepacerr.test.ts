import { describe, it, expect, vi, beforeEach } from "vitest";

// The OnePacerr API is a gap-filler: it must resolve releases our own sources
// don't know yet, and must never break anything when it's off or unreachable.

const { getUseOnepacerr } = vi.hoisted(() => ({ getUseOnepacerr: vi.fn(() => true) }));
vi.mock("../src/settings", () => ({ getUseOnepacerr }));
vi.mock("../src/config", () => ({
  getConfig: () => ({ ONEPACERR_BASE_URL: "https://onepacerr.test/api/v1" }),
}));

import { lookupOnepacerrByCrc32, lookupOnepacerrMagnet, clearOnepacerrCache } from "../src/onepacerr";

// Mirrors the real payload, including Fan Letter — the release that our dataset
// and the episode guide both still lack.
const PAYLOAD = {
  lastUpdate: "2026-08-16T00:00:00.000Z",
  arcs: [
    {
      arc: 0, saga: "Specials", title: "Specials", description: "Animated specials.",
      episodes: [{
        arc: 0, episode: 1, title: "One Piece Fan Letter", description: "A special.",
        mangaChapters: "One Piece Novel: Straw Hat Stories", animeEpisodes: "One Piece Fan Letter",
        released: "2026-06-28T00:00:00.000Z",
        files: { standard: { CRC32: "59510B34", magnetURI: "magnet:?xt=urn:btih:abc", variant: "standard" } },
      }],
    },
    {
      arc: 5, saga: "East Blue", title: "Baratie", description: "The sea restaurant.",
      episodes: [{
        arc: 5, episode: 1, title: "Enter: Sanji", description: "They need a cook.",
        mangaChapters: "42-44", animeEpisodes: "19-21", released: "2025-08-02T00:00:00.000Z",
        files: {
          standard: { CRC32: "AAAA1111", magnetURI: "magnet:?xt=urn:btih:std" },
          extended: { CRC32: "BBBB2222", magnetURI: "magnet:?xt=urn:btih:ext", variant: "extended" },
        },
      }],
    },
  ],
};

function stubFetch(payload: unknown = PAYLOAD, ok = true) {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => payload }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearOnepacerrCache();
  getUseOnepacerr.mockReturnValue(true);
});

describe("OnePacerr metadata source", () => {
  it("resolves the CRC32 our own sources are missing", async () => {
    stubFetch();
    const rel = await lookupOnepacerrByCrc32("59510B34");
    expect(rel).not.toBeNull();
    expect(rel!.episodeTitle).toBe("One Piece Fan Letter");
    expect(rel!.arcPart).toBe(0);
    expect(rel!.chapters).toBe("One Piece Novel: Straw Hat Stories");
  });

  it("normalizes the ISO timestamp to a plain date for Plex", async () => {
    stubFetch();
    expect((await lookupOnepacerrByCrc32("59510B34"))!.released).toBe("2026-06-28");
  });

  it("indexes every variant and flags the extended cut", async () => {
    stubFetch();
    expect((await lookupOnepacerrByCrc32("AAAA1111"))!.extended).toBe(false);
    expect((await lookupOnepacerrByCrc32("BBBB2222"))!.extended).toBe(true);
  });

  it("is case-insensitive on the CRC32", async () => {
    stubFetch();
    expect(await lookupOnepacerrByCrc32("59510b34")).not.toBeNull();
  });

  it("exposes a magnet for a release the feed may no longer carry", async () => {
    stubFetch();
    expect(await lookupOnepacerrMagnet("59510B34")).toBe("magnet:?xt=urn:btih:abc");
    expect(await lookupOnepacerrMagnet("DEADBEEF")).toBeNull();
  });

  it("caches, so repeated lookups hit the network once", async () => {
    const f = stubFetch();
    await lookupOnepacerrByCrc32("59510B34");
    await lookupOnepacerrByCrc32("AAAA1111");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled — no request at all", async () => {
    getUseOnepacerr.mockReturnValue(false);
    const f = stubFetch();
    expect(await lookupOnepacerrByCrc32("59510B34")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("fails soft when the API is down", async () => {
    stubFetch({}, false);
    expect(await lookupOnepacerrByCrc32("59510B34")).toBeNull();
  });

  it("fails soft on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await lookupOnepacerrByCrc32("59510B34")).toBeNull();
  });
});

// The real payload shape: "archived" is an ARRAY of superseded releases while
// standard/extended/alternate are single objects. Treating every value as one
// object silently drops every historical CRC32, so an older file on disk could
// never be resolved through this source.
describe("archived releases (array-valued variant)", () => {
  const WITH_ARCHIVED = {
    arcs: [{
      arc: 1, saga: "East Blue", title: "Romance Dawn", description: "",
      episodes: [{
        arc: 1, episode: 1, title: "Romance Dawn 1", description: "",
        mangaChapters: "1-7", animeEpisodes: "1-4", released: "2026-08-17T00:00:00.000Z",
        files: {
          standard: { CRC32: "NEW00001", magnetURI: "magnet:new" },
          archived: [
            { CRC32: "OLD00001", magnetURI: "magnet:old1", outdated: true },
            { CRC32: "OLD00002", magnetURI: "magnet:old2", outdated: true },
          ],
        },
      }],
    }],
  };

  it("indexes every archived release, not just the current one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => WITH_ARCHIVED })));
    clearOnepacerrCache();
    expect(await lookupOnepacerrByCrc32("NEW00001")).not.toBeNull();
    expect(await lookupOnepacerrByCrc32("OLD00001")).not.toBeNull();
    expect(await lookupOnepacerrByCrc32("OLD00002")).not.toBeNull();
  });

  it("keeps an archived release's episode identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => WITH_ARCHIVED })));
    clearOnepacerrCache();
    const old = await lookupOnepacerrByCrc32("OLD00002");
    expect(old!.arcPart).toBe(1);
    expect(old!.episodeNum).toBe(1);
    expect(old!.extended).toBe(false); // archived is not an extended cut
  });
});
