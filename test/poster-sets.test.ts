import { describe, it, expect } from "vitest";
import {
  POSTER_SETS, getPosterSet, posterSetUrl, normalizePosterSetId, describePosterSets,
} from "../src/poster-sets";

const BASE = "https://posters.test/One%20Pace";
const set = (id: string) => POSTER_SETS.find((s) => s.id === id)!;

describe("poster set registry", () => {
  it("keeps SpykerNZ paths on the configured base so an override still works", () => {
    expect(posterSetUrl(set("spykernz"), "show", BASE)).toBe(`${BASE}/poster.png`);
    expect(posterSetUrl(set("spykernz-alt"), "show", BASE)).toBe(`${BASE}/poster-2.png`);
    expect(posterSetUrl(set("spykernz"), "7", BASE)).toBe(`${BASE}/season07-poster.png`);
    expect(posterSetUrl(set("spykernz"), "0", BASE)).toBe(`${BASE}/season-specials-poster.png`);
  });

  it("pins OnePacerr sets to their own repo with SeasonNN.png naming", () => {
    const u = posterSetUrl(set("piratezekk"), "7", BASE)!;
    expect(u).toContain("/eltharynd/OnePacerr/");
    expect(u).toContain("/posters/piratezekk/Season07.png");
    // Season00 is that set's specials art.
    expect(posterSetUrl(set("piratezekk"), "0", BASE)).toContain("Season00.png");
  });

  it("returns null for a set with no show poster", () => {
    // mizzoufan523 ships seasons only — callers must skip, not error.
    expect(posterSetUrl(set("mizzoufan523"), "show", BASE)).toBeNull();
    expect(posterSetUrl(set("mizzoufan523"), "3", BASE)).toContain("Season03.png");
  });

  it("rejects nonsense targets", () => {
    expect(posterSetUrl(set("spykernz"), "-1", BASE)).toBeNull();
    expect(posterSetUrl(set("spykernz"), "abc", BASE)).toBeNull();
  });

  it("migrates the legacy 1/2 show-design values", () => {
    expect(normalizePosterSetId("1")).toBe("spykernz");
    expect(normalizePosterSetId("2")).toBe("spykernz-alt");
    expect(normalizePosterSetId("official")).toBe("official");
    expect(normalizePosterSetId("nonsense")).toBe("spykernz"); // falls back to default
    expect(normalizePosterSetId("")).toBe("spykernz");
  });

  it("getPosterSet falls back rather than throwing", () => {
    expect(getPosterSet("official").id).toBe("official");
    expect(getPosterSet("nope").id).toBe("spykernz");
  });

  it("every set previews as something, even without a show poster", () => {
    const views = describePosterSets(BASE);
    expect(views).toHaveLength(POSTER_SETS.length);
    for (const v of views) expect(v.previewUrl).toBeTruthy();
    // The set with no show poster falls back to its season 1 art.
    expect(views.find((v) => v.id === "mizzoufan523")!.previewUrl).toContain("Season01.png");
  });
});
