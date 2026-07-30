import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards the bug where a brand-new season got no poster: the first special
// created Season 0, but Plex's library scan hadn't materialized that season yet
// when ensureSeasonPoster ran, so the ratingKey lookup missed and the function
// returned silently — no art, no log. It must now poll for the season and, if it
// still can't find it, say so.

const { getKv, setKv, getShowAndSeasonKeys, uploadPoster } = vi.hoisted(() => ({
  getKv: vi.fn(() => null),
  setKv: vi.fn(),
  getShowAndSeasonKeys: vi.fn(),
  uploadPoster: vi.fn(async () => {}),
}));

vi.mock("../src/db", () => ({ getKv, setKv }));
vi.mock("../src/settings", () => ({
  getSettingValue: () => "https://posters.test/One%20Pace",
}));
vi.mock("../src/plex", () => ({ getShowAndSeasonKeys, uploadPoster }));

import { ensureSeasonPoster } from "../src/posters";

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

  it("does not upload twice for an already-applied poster", async () => {
    getKv.mockReturnValue(
      JSON.stringify({ "0": { url: "https://posters.test/One%20Pace/season-specials-poster.png" } })
    );
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map([[0, "s0key"]]) });

    await ensureSeasonPoster(0, { delayMs: 0 });

    expect(uploadPoster).not.toHaveBeenCalled();
  });
});
