import { describe, it, expect } from "vitest";
import { buildEmbed } from "../src/discord";

describe("buildEmbed", () => {
  it("new_episode: blue, arc/season/episode in description", () => {
    const e = buildEmbed({ type: "new_episode", crc32: "ABCD1234", arcTitle: "Baratie", arcPart: 5, episodeNum: 1 });
    expect(e.title).toBe("New One Pace Episode Detected");
    expect(e.color).toBe(0x3498db);
    expect(e.description).toContain("Baratie");
    expect(e.description).toContain("S05E01");
  });

  it("download_complete: green, includes filename and CRC", () => {
    const e = buildEmbed({
      type: "download_complete",
      crc32: "ABCD1234",
      arcTitle: "Baratie",
      arcPart: 5,
      episodeNum: 1,
      filename: "One Pace - Baratie - S05E01 [1080p][ABCD1234].mkv",
    });
    expect(e.title).toBe("Download Complete");
    expect(e.color).toBe(0x2ecc71);
    const fileField = e.fields.find((f) => f.name === "File");
    expect(fileField?.value).toContain("S05E01");
  });

  it("episode_updated: amber, includes changelog and replaced files", () => {
    const e = buildEmbed({
      type: "episode_updated",
      crc32: "ABCD1234",
      arcTitle: "Baratie",
      arcPart: 5,
      episodeNum: 1,
      filename: "new.mkv",
      changelog: ["Fixed subtitles", "Re-encoded audio"],
      replacedFilenames: ["old.mkv"],
    });
    expect(e.title).toBe("Episode Updated");
    expect(e.color).toBe(0xf39c12);
    const changelog = e.fields.find((f) => f.name === "Changelog");
    expect(changelog?.value).toContain("Fixed subtitles");
    expect(changelog?.value).toContain("• Re-encoded audio");
    expect(e.fields.find((f) => f.name === "Replaced")?.value).toBe("old.mkv");
  });

  it("episode_updated: omits changelog/replaced fields when empty", () => {
    const e = buildEmbed({ type: "episode_updated", crc32: "ABCD1234", arcTitle: "Baratie", arcPart: 5, episodeNum: 1 });
    expect(e.fields.find((f) => f.name === "Changelog")).toBeUndefined();
    expect(e.fields.find((f) => f.name === "Replaced")).toBeUndefined();
  });

  it("error: red, surfaces the error message", () => {
    const e = buildEmbed({ type: "error", crc32: "ABCD1234", error: "boom" });
    expect(e.title).toBe("One Pace Automator Error");
    expect(e.color).toBe(0xe74c3c);
    expect(e.description).toBe("boom");
  });
});
