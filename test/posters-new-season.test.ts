import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards the bug where a brand-new season got no poster: the first special
// created Season 0, but Plex's library scan hadn't materialized that season yet
// when ensureSeasonPoster ran, so the ratingKey lookup missed and the function
// returned silently — no art, no log. It must now poll for the season and, if it
// still can't find it, say so.

const { getKv, setKv, getShowAndSeasonKeys, listPosterTargets, uploadPoster } = vi.hoisted(() => ({
  getKv: vi.fn(() => null),
  setKv: vi.fn(),
  getShowAndSeasonKeys: vi.fn(),
  listPosterTargets: vi.fn(),
  uploadPoster: vi.fn(async () => {}),
}));

vi.mock("../src/db", () => ({ getKv, setKv }));
vi.mock("../src/settings", () => ({
  getSettingValue: () => "https://posters.test/One%20Pace",
  getShowPosterVariant: () => 1,
}));
vi.mock("../src/plex", () => ({ getShowAndSeasonKeys, listPosterTargets, uploadPoster }));

import { ensureSeasonPoster, syncPosters, posterUrl } from "../src/posters";

const BASE = "https://posters.test/One%20Pace";

// The poster repo ships two designs for the *series* poster; seasons have one
// each. The variant is a user preference, so it must only affect the show.
describe("posterUrl show variant", () => {
  it("defaults to poster.png", () => {
    expect(posterUrl(BASE, "show")).toBe(`${BASE}/poster.png`);
    expect(posterUrl(BASE, "show", 1)).toBe(`${BASE}/poster.png`);
  });

  it("uses poster-2.png for variant 2", () => {
    expect(posterUrl(BASE, "show", 2)).toBe(`${BASE}/poster-2.png`);
  });

  it("never changes season posters", () => {
    for (const v of [1, 2]) {
      expect(posterUrl(BASE, "0", v)).toBe(`${BASE}/season-specials-poster.png`);
      expect(posterUrl(BASE, "7", v)).toBe(`${BASE}/season07-poster.png`);
      expect(posterUrl(BASE, "21", v)).toBe(`${BASE}/season21-poster.png`);
    }
  });

  it("tolerates a trailing slash on the base", () => {
    expect(posterUrl(`${BASE}/`, "show", 2)).toBe(`${BASE}/poster-2.png`);
  });
});

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fetched: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  fetched.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => '"etag-1"' },
      arrayBuffer: async () => IMG,
    };
  });
});

describe("ensureSeasonPoster for a season Plex just created", () => {
  it("retries until the season appears, then uploads", async () => {
    // Empty on the first look (scan still running), present on the second.
    getShowAndSeasonKeys
      .mockResolvedValueOnce({ showKey: "1", seasonMap: new Map() })
      .mockResolvedValueOnce({ showKey: "1", seasonMap: new Map([[0, "s0key"]]) });

    await ensureSeasonPoster(0, { delayMs: 0 });

    expect(getShowAndSeasonKeys).toHaveBeenCalledTimes(2);
    expect(uploadPoster).toHaveBeenCalledWith("s0key", IMG);
  });

  it("uses the specials poster URL for season 0", async () => {
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map([[0, "s0key"]]) });
    await ensureSeasonPoster(0, { delayMs: 0 });
    expect(fetched[0]).toBe("https://posters.test/One%20Pace/season-specials-poster.png");
  });

  it("uses the zero-padded URL for a normal season", async () => {
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map([[7, "s7key"]]) });
    await ensureSeasonPoster(7, { delayMs: 0 });
    expect(fetched[0]).toBe("https://posters.test/One%20Pace/season07-poster.png");
  });

  it("gives up after the attempt budget without uploading", async () => {
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map() });

    await ensureSeasonPoster(0, { attempts: 3, delayMs: 0 });

    expect(getShowAndSeasonKeys).toHaveBeenCalledTimes(3);
    expect(uploadPoster).not.toHaveBeenCalled();
  });

  it("re-uploads when we recorded a poster but Plex has none", async () => {
    // The exact stuck state: an earlier upload stored an ETag, so the conditional
    // GET 304s and the target is skipped forever — while Plex shows no art.
    getKv.mockReturnValue(
      JSON.stringify({
        "0": { url: "https://posters.test/One%20Pace/season-specials-poster.png", etag: '"old"' },
      })
    );
    listPosterTargets.mockResolvedValue([{ key: "0", ratingKey: "s0key", hasPoster: false }]);
    // 304 only if an If-None-Match header is sent; assert we don't send one.
    vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> }) => {
      fetched.push(url);
      const conditional = Boolean(init?.headers?.["If-None-Match"]);
      return conditional
        ? { ok: false, status: 304, headers: { get: () => null }, arrayBuffer: async () => IMG }
        : { ok: true, status: 200, headers: { get: () => '"new"' }, arrayBuffer: async () => IMG };
    });

    const r = await syncPosters();

    expect(uploadPoster).toHaveBeenCalledWith("s0key", IMG);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it("still skips via ETag when Plex does have the poster", async () => {
    getKv.mockReturnValue(
      JSON.stringify({
        "0": { url: "https://posters.test/One%20Pace/season-specials-poster.png", etag: '"old"' },
      })
    );
    listPosterTargets.mockResolvedValue([{ key: "0", ratingKey: "s0key", hasPoster: true }]);
    vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> }) => {
      fetched.push(url);
      return init?.headers?.["If-None-Match"]
        ? { ok: false, status: 304, headers: { get: () => null }, arrayBuffer: async () => IMG }
        : { ok: true, status: 200, headers: { get: () => '"new"' }, arrayBuffer: async () => IMG };
    });

    const r = await syncPosters();

    expect(uploadPoster).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("does not upload twice for an already-applied poster", async () => {
    getKv.mockReturnValue(
      JSON.stringify({ "0": { url: "https://posters.test/One%20Pace/season-specials-poster.png" } })
    );
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map([[0, "s0key"]]) });

    await ensureSeasonPoster(0, { delayMs: 0 });

    expect(uploadPoster).not.toHaveBeenCalled();
  });
});
