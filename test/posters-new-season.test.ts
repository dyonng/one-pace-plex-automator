import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards the bug where a brand-new season got no poster: the first special
// created Season 0, but Plex's library scan hadn't materialized that season yet
// when ensureSeasonPoster ran, so the ratingKey lookup missed and the function
// returned silently — no art, no log. It must now poll for the season and, if it
// still can't find it, say so.

const kv: Record<string, string> = {};
const { getKv, setKv, getShowAndSeasonKeys, listPosterTargets, uploadPoster } = vi.hoisted(() => ({
  getKv: vi.fn(),
  setKv: vi.fn(),
  getShowAndSeasonKeys: vi.fn(),
  listPosterTargets: vi.fn(),
  uploadPoster: vi.fn(async () => {}),
}));

vi.mock("../src/db", () => ({ getKv, setKv }));
vi.mock("../src/settings", () => ({
  getSettingValue: () => "https://posters.test/One%20Pace",
  getPosterSetId: () => "spykernz",
}));
vi.mock("../src/plex", () => ({ getShowAndSeasonKeys, listPosterTargets, uploadPoster }));

import { ensureSeasonPoster, syncPosters } from "../src/posters";
import { POSTER_SETS, posterSetUrl } from "../src/poster-sets";

const BASE = "https://posters.test/One%20Pace";

// 304 only when an If-None-Match is sent, so tests can assert on conditionality.
function conditionalFetch() {
  vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> }) => {
    fetched.push(url);
    return init?.headers?.["If-None-Match"]
      ? { ok: false, status: 304, headers: { get: () => null }, arrayBuffer: async () => IMG }
      : { ok: true, status: 200, headers: { get: () => '"new"' }, arrayBuffer: async () => IMG };
  });
}

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fetched: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(kv)) delete kv[k];
  getKv.mockImplementation((k: string) => kv[k] ?? null);
  setKv.mockImplementation((k: string, v: string) => { kv[k] = v; });
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
    // The stuck state: an earlier upload stored an ETag, so the conditional GET
    // 304s and the target is skipped forever — while Plex shows no art.
    kv["posters_applied"] = JSON.stringify({
      "0|spykernz": { url: "https://posters.test/One%20Pace/season-specials-poster.png", etag: '"old"' },
    });
    kv["posters_selected"] = JSON.stringify({ "0": "spykernz" });
    listPosterTargets.mockResolvedValue([{ key: "0", ratingKey: "s0key", hasPoster: false }]);
    conditionalFetch();

    const r = await syncPosters();

    expect(uploadPoster).toHaveBeenCalledWith("s0key", IMG);
    // Every set's art is offered so Plex's picker lists them all.
    expect(r.applied).toBe(POSTER_SETS.length);
  });

  it("skips everything once all sets are applied and Plex has the art", async () => {
    const applied: Record<string, unknown> = {};
    for (const set of POSTER_SETS) {
      applied[`0|${set.id}`] = { url: posterSetUrl(set, "0", BASE), etag: '"old"' };
    }
    kv["posters_applied"] = JSON.stringify(applied);
    kv["posters_selected"] = JSON.stringify({ "0": "spykernz" });
    listPosterTargets.mockResolvedValue([{ key: "0", ratingKey: "s0key", hasPoster: true }]);
    conditionalFetch();

    const r = await syncPosters();

    expect(uploadPoster).not.toHaveBeenCalled();
    expect(r.skipped).toBe(POSTER_SETS.length);
  });

  it("re-uploads the preferred set when the selection needs to change", async () => {
    // All art already uploaded, but Plex is showing a different set — the
    // preferred one must be pushed again so it becomes the selected poster.
    const applied: Record<string, unknown> = {};
    for (const set of POSTER_SETS) {
      applied[`0|${set.id}`] = { url: posterSetUrl(set, "0", BASE), etag: '"old"' };
    }
    kv["posters_applied"] = JSON.stringify(applied);
    kv["posters_selected"] = JSON.stringify({ "0": "official" }); // not the preferred set
    listPosterTargets.mockResolvedValue([{ key: "0", ratingKey: "s0key", hasPoster: true }]);
    conditionalFetch();

    const r = await syncPosters();

    expect(uploadPoster).toHaveBeenCalledTimes(1); // just the preferred one
    expect(r.applied).toBe(1);
  });

  it("does not re-apply a season already done with the current set", async () => {
    kv["posters_applied"] = JSON.stringify({
      "0|spykernz": { url: "https://posters.test/One%20Pace/season-specials-poster.png" },
    });
    kv["posters_selected"] = JSON.stringify({ "0": "spykernz" });
    getShowAndSeasonKeys.mockResolvedValue({ showKey: "1", seasonMap: new Map([[0, "s0key"]]) });

    await ensureSeasonPoster(0, { delayMs: 0 });

    expect(uploadPoster).not.toHaveBeenCalled();
  });
});
