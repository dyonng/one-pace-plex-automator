import { describe, it, expect } from "vitest";
import { sortEpisodes, toggleSort, DEFAULT_SORT, type SortableEpisode } from "../frontend/src/lib/sort";

// Sorting is pure, so it is tested directly rather than through the component.

function ep(over: Partial<SortableEpisode> & { crc32: string }): SortableEpisode {
  return {
    arc_part: 1,
    episode_num: 1,
    arc_title: "Romance Dawn",
    status: "done",
    resolution: "1080p",
    final_filename: null,
    original_filename: null,
    file_size: null,
    updated_at: 0,
    ...over,
  };
}

const crcs = (rows: SortableEpisode[]) => rows.map((r) => r.crc32);

describe("sortEpisodes", () => {
  it("orders S/E by arc then episode, not as text", () => {
    const rows = [
      ep({ crc32: "c", arc_part: 10, episode_num: 1 }),
      ep({ crc32: "a", arc_part: 2, episode_num: 10 }),
      ep({ crc32: "b", arc_part: 2, episode_num: 9 }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "se", dir: "asc" }))).toEqual(["b", "a", "c"]);
  });

  it("orders resolution numerically, so 1080p outranks 720p", () => {
    const rows = [
      ep({ crc32: "low", resolution: "480p" }),
      ep({ crc32: "high", resolution: "1080p" }),
      ep({ crc32: "mid", resolution: "720p" }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "resolution", dir: "desc" }))).toEqual([
      "high",
      "mid",
      "low",
    ]);
    expect(crcs(sortEpisodes(rows, { key: "resolution", dir: "asc" }))).toEqual([
      "low",
      "mid",
      "high",
    ]);
  });

  it("orders status by pipeline progression, not alphabetically", () => {
    const rows = [
      ep({ crc32: "f", status: "failed" }),
      ep({ crc32: "d", status: "downloading" }),
      ep({ crc32: "a", status: "available" }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "status", dir: "asc" }))).toEqual(["a", "d", "f"]);
  });

  it("sorts unknown statuses after every known one", () => {
    const rows = [
      ep({ crc32: "weird", status: "exploded" }),
      ep({ crc32: "known", status: "available" }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "status", dir: "asc" }))).toEqual(["known", "weird"]);
  });

  it("keeps rows with no value at the bottom in both directions", () => {
    const rows = [
      ep({ crc32: "none", file_size: null }),
      ep({ crc32: "small", file_size: 10 }),
      ep({ crc32: "big", file_size: 100 }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "size", dir: "desc" }))).toEqual([
      "big",
      "small",
      "none",
    ]);
    // Ascending must not float the missing value to the top.
    expect(crcs(sortEpisodes(rows, { key: "size", dir: "asc" }))).toEqual([
      "small",
      "big",
      "none",
    ]);
  });

  it("falls back to the original filename when no final name exists", () => {
    const rows = [
      ep({ crc32: "z", original_filename: "b.mkv" }),
      ep({ crc32: "a", final_filename: "a.mkv" }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "file", dir: "asc" }))).toEqual(["a", "z"]);
  });

  it("orders arcs case-insensitively and breaks ties by S/E", () => {
    const rows = [
      ep({ crc32: "e1", arc_title: "wano", arc_part: 2, episode_num: 1 }),
      ep({ crc32: "e2", arc_title: "Wano", arc_part: 2, episode_num: 2 }),
    ];
    // Same arc, so the S/E tie-break decides: E1 before E2.
    expect(crcs(sortEpisodes(rows, { key: "arc", dir: "asc" }))).toEqual(["e1", "e2"]);
  });

  it("orders arcs by name regardless of letter case", () => {
    const rows = [
      ep({ crc32: "wano", arc_title: "wano", arc_part: 1, episode_num: 1 }),
      ep({ crc32: "arlong", arc_title: "Arlong Park", arc_part: 2, episode_num: 1 }),
    ];
    expect(crcs(sortEpisodes(rows, { key: "arc", dir: "asc" }))).toEqual(["arlong", "wano"]);
  });

  it("does not mutate the input array", () => {
    const rows = [ep({ crc32: "b", updated_at: 1 }), ep({ crc32: "a", updated_at: 2 })];
    sortEpisodes(rows, { key: "updated", dir: "desc" });
    expect(crcs(rows)).toEqual(["b", "a"]);
  });

  it("sorts newest first by default", () => {
    const rows = [ep({ crc32: "old", updated_at: 1 }), ep({ crc32: "new", updated_at: 9 })];
    expect(crcs(sortEpisodes(rows, DEFAULT_SORT))).toEqual(["new", "old"]);
  });
});

describe("toggleSort", () => {
  it("flips direction when the same column is clicked again", () => {
    expect(toggleSort({ key: "arc", dir: "asc" }, "arc")).toEqual({ key: "arc", dir: "desc" });
    expect(toggleSort({ key: "arc", dir: "desc" }, "arc")).toEqual({ key: "arc", dir: "asc" });
  });

  it("starts a new column at its natural direction", () => {
    // Time and size read best newest/largest first; text reads A–Z.
    expect(toggleSort({ key: "arc", dir: "asc" }, "updated")).toEqual({ key: "updated", dir: "desc" });
    expect(toggleSort({ key: "updated", dir: "desc" }, "arc")).toEqual({ key: "arc", dir: "asc" });
    expect(toggleSort({ key: "arc", dir: "asc" }, "size")).toEqual({ key: "size", dir: "desc" });
  });
});
