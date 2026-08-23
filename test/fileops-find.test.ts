import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findDownloadedFile, scanBatchFiles } from "../src/fileops";

// Regression guard for "Downloaded file not found in /downloads for CRC32 …".
// qBittorrent's layout varies — a loose file, a per-torrent folder, a category
// folder, or a category folder containing a whole-arc batch folder. The old
// search only looked one level deep, so anything nested deeper was invisible and
// a successfully downloaded release failed to import.

let root: string;
const touch = (p: string, name: string) => {
  mkdirSync(p, { recursive: true });
  writeFileSync(path.join(p, name), "x");
};

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "dl-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("findDownloadedFile", () => {
  it("finds a loose file at the top level", () => {
    touch(root, "[One Pace] Arlong Park 01 [1080p][C269DEF5].mkv");
    expect(findDownloadedFile(root, "C269DEF5")).toContain("C269DEF5");
  });

  it("finds a file inside a per-torrent folder", () => {
    touch(path.join(root, "[One Pace][1-7] Romance Dawn [1080p]"),
          "[One Pace] Romance Dawn 01 [1080p][E5F09F49].mkv");
    expect(findDownloadedFile(root, "E5F09F49")).toContain("E5F09F49");
  });

  it("finds a batch episode nested under a category folder", () => {
    // The real failing shape: <downloads>/<category>/<arc folder>/<episode>.mkv
    touch(path.join(root, "one-pace", "[One Pace][1-7] Romance Dawn [1080p]"),
          "[One Pace] Romance Dawn 01 [1080p][E5F09F49].mkv");
    expect(findDownloadedFile(root, "E5F09F49")).toContain("E5F09F49");
  });

  it("finds a single-file download under a category folder", () => {
    touch(path.join(root, "one-pace"), "[One Pace] Arlong Park 01 [1080p][C269DEF5].mkv");
    expect(findDownloadedFile(root, "C269DEF5")).toContain("C269DEF5");
  });

  it("is case-insensitive on the CRC32", () => {
    touch(path.join(root, "sub"), "ep [1080p][abcd1234].mkv");
    expect(findDownloadedFile(root, "ABCD1234")).toBeTruthy();
  });

  it("returns null when it genuinely isn't there", () => {
    touch(root, "unrelated.mkv");
    expect(findDownloadedFile(root, "DEADBEEF")).toBeNull();
    expect(findDownloadedFile(path.join(root, "nope"), "DEADBEEF")).toBeNull();
  });
});

describe("scanBatchFiles", () => {
  it("collects every CRC-tagged episode in a flat batch folder", () => {
    const arc = path.join(root, "Romance Dawn");
    touch(arc, "ep1 [1080p][AAAA0001].mkv");
    touch(arc, "ep2 [1080p][AAAA0002].mkv");
    touch(arc, "notes.txt");
    const found = scanBatchFiles(arc);
    expect(found.map((f) => f.crc32).sort()).toEqual(["AAAA0001", "AAAA0002"]);
  });

  it("also collects episodes split across subfolders", () => {
    const arc = path.join(root, "Marineford");
    touch(path.join(arc, "Season 01"), "ep1 [720p][BBBB0001].mkv");
    touch(path.join(arc, "Season 02"), "ep2 [720p][BBBB0002].mkv");
    expect(scanBatchFiles(arc)).toHaveLength(2);
  });

  it("ignores files with no CRC32 and non-video files", () => {
    const arc = path.join(root, "arc");
    touch(arc, "no-crc-here.mkv");
    touch(arc, "cover [AAAA0003].jpg");
    expect(scanBatchFiles(arc)).toHaveLength(0);
  });
});
