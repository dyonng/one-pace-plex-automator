import { describe, it, expect } from "vitest";
import { buildShowMetaParams } from "../src/plex";

describe("buildShowMetaParams", () => {
  const meta = { genres: ["Anime", "Action", "Adventure"], contentRating: "TV-14", studio: "Toei Animation", summary: "" };

  it("targets the show (type=2) and locks every field it sets", () => {
    const p = buildShowMetaParams(meta);
    expect(p.type).toBe(2);
    expect(p["contentRating.locked"]).toBe(1);
    expect(p["studio.locked"]).toBe(1);
    expect(p["genre.locked"]).toBe(1);
  });

  it("writes content rating and studio values", () => {
    const p = buildShowMetaParams(meta);
    expect(p["contentRating.value"]).toBe("TV-14");
    expect(p["studio.value"]).toBe("Toei Animation");
  });

  it("emits one indexed genre tag param per genre", () => {
    const p = buildShowMetaParams(meta);
    expect(p["genre[0].tag.tag"]).toBe("Anime");
    expect(p["genre[1].tag.tag"]).toBe("Action");
    expect(p["genre[2].tag.tag"]).toBe("Adventure");
    // no stray fourth genre
    expect(p["genre[3].tag.tag"]).toBeUndefined();
  });

  it("handles an empty genre list without emitting tag params", () => {
    const p = buildShowMetaParams({ genres: [], contentRating: "TV-14", studio: "One Pace", summary: "" });
    expect(p["genre[0].tag.tag"]).toBeUndefined();
    expect(p["genre.locked"]).toBe(1);
    expect(p["studio.value"]).toBe("One Pace");
  });

  it("writes a locked summary when the dataset supplies one", () => {
    const p = buildShowMetaParams({ ...meta, summary: "One Pace recuts the anime." });
    expect(p["summary.value"]).toBe("One Pace recuts the anime.");
    expect(p["summary.locked"]).toBe(1);
  });

  it("omits summary entirely when there is none, rather than blanking Plex's", () => {
    const p = buildShowMetaParams(meta);
    expect(p["summary.value"]).toBeUndefined();
    expect(p["summary.locked"]).toBeUndefined();
  });
});
