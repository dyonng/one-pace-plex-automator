import { describe, it, expect, beforeAll, vi } from "vitest";

// Guards specials (arc part 0) support: the "Specials" arc must flow through
// getAllArcs/getAllEpisodes like any other season so it reaches coverage,
// reconciliation and Full Plex sync. Plex models season 0 as Specials natively.

vi.mock("../src/config", () => ({
  getConfig: () => ({ METADATA_REPO_RAW_BASE: "https://metadata.test" }),
}));
vi.mock("../src/settings", () => ({
  getPreferExtended: () => true,
  getPreferArabasta: () => true,
  getGoogleSheetsApiKey: () => "",
}));
vi.mock("../src/onepace-sheet", () => ({
  listSheetEpisodes: async () => [],
  getArcResolution: async () => null,
  lookupSheetEpisodeByCrc32: async () => null,
}));
vi.mock("../src/onepace-descriptions", () => ({
  lookupEpisodeText: async () => null,
  lookupArcText: async () => null,
}));

import {
  getAllArcs, getAllEpisodes, resolveEpisodeByCrc32, refreshMetadata, resolveAliasedRelease,
} from "../src/metadata";

const DATASET = {
  status: { version: 1 },
  arcs: {
    en: [
      {
        part: 0, saga: "Specials", title: "Specials", shortcode: "SP",
        mkvcode: "specials", description: "Animated specials.",
        episodes: [{ episode: "98", standard: "AAAA0001", extended: "" }],
      },
      {
        part: 1, saga: "East Blue", title: "Romance Dawn", shortcode: "RD",
        mkvcode: "rd", description: "The beginning.",
        episodes: [{ episode: "01", standard: "BBBB0001", extended: "" }],
      },
    ],
  },
  descriptions: {
    en: [
      { arc: 0, episode: 98, title: "One Piece Fan Letter", originaltitle: "", description: "A special." },
      { arc: 1, episode: 1, title: "Romance Dawn", originaltitle: "", description: "Ep one." },
    ],
  },
  episodes: {
    AAAA0001: {
      arc: 0, episode: 98, manga_chapters: "", anime_episodes: "One Piece Fan Letter",
      released: "2024-11-29", duration: 0, extended: false,
      hashes: { crc32: "AAAA0001", blake2s: "" },
    },
    BBBB0001: {
      arc: 1, episode: 1, manga_chapters: "1-7", anime_episodes: "1",
      released: "2013-03-27", duration: 0, extended: false,
      hashes: { crc32: "BBBB0001", blake2s: "" },
    },
  },
};

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => DATASET,
  }));
  await refreshMetadata();
});

describe("specials (arc part 0)", () => {
  it("getAllArcs includes the Specials arc", async () => {
    const arcs = await getAllArcs();
    const specials = arcs.find((a) => a.arcPart === 0);
    expect(specials).toBeDefined();
    expect(specials?.arcTitle).toBe("Specials");
    expect(arcs).toHaveLength(2);
  });

  it("keeps arcIndex aligned with dataset order", async () => {
    const arcs = await getAllArcs();
    expect(arcs.find((a) => a.arcPart === 0)?.arcIndex).toBe(0);
    expect(arcs.find((a) => a.arcPart === 1)?.arcIndex).toBe(1);
  });

  it("getAllEpisodes includes specials as season 00", async () => {
    const eps = await getAllEpisodes();
    const fanLetter = eps.find((e) => e.seasonEpisodeId === "s00e98");
    expect(fanLetter).toBeDefined();
    expect(fanLetter?.arcPart).toBe(0);
    expect(fanLetter?.episodeTitle).toBe("One Piece Fan Letter");
    expect(fanLetter?.released).toBe("2024-11-29");
  });

  it("resolves a specials episode by CRC32", async () => {
    const ep = await resolveEpisodeByCrc32("AAAA0001");
    expect(ep.arcPart).toBe(0);
    expect(ep.episodeNum).toBe(98);
    expect(ep.arcTitle).toBe("Specials");
  });

  it("still includes regular arcs", async () => {
    const eps = await getAllEpisodes();
    expect(eps.some((e) => e.seasonEpisodeId === "s01e01")).toBe(true);
  });
});

describe("resolveAliasedRelease (Fan Letter special case)", () => {
  it("pins a Fan Letter release to the catalogued Specials slot", async () => {
    const a = await resolveAliasedRelease("One Piece Fan Letter 01");
    expect(a).not.toBeNull();
    expect(a?.arcPart).toBe(0);
    expect(a?.epNum).toBe(98); // where the dataset already holds its metadata
    expect(a?.arcTitle).toBe("Specials");
  });

  it("matches regardless of numbering or surrounding words", async () => {
    for (const t of ["One Piece Fan Letter 02", "Fan Letter", "[One Pace] One Piece FanLetter 01"]) {
      expect(await resolveAliasedRelease(t)).not.toBeNull();
    }
  });

  it("picks up an extended marker", async () => {
    expect((await resolveAliasedRelease("One Piece Fan Letter 01 Extended"))?.extended).toBe(true);
    expect((await resolveAliasedRelease("One Piece Fan Letter 01"))?.extended).toBe(false);
  });

  it("leaves normal releases alone", async () => {
    for (const t of ["Baratie 07", "Romance Dawn 01", "Water Seven 12 Extended"]) {
      expect(await resolveAliasedRelease(t)).toBeNull();
    }
  });
});
