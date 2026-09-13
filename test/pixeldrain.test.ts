import { describe, it, expect } from "vitest";
import { parsePixeldrainId, limitsAllow, partPathFor, type PixeldrainLimits } from "../src/pixeldrain";
import { extractPixeldrainId } from "../src/rss";

// One Pace publishes most recent releases three ways — magnet, .torrent and a
// Pixeldrain direct link — but only the first two are proper feed fields. The
// direct link has to be read out of the description markup.

const limits = (over: Partial<PixeldrainLimits> = {}): PixeldrainLimits => ({
  serverOverload: false, speedLimit: 0,
  transferLimit: 6_000_000_000, transferUsed: 0,
  downloadLimit: 10_000, downloadUsed: 0, ...over,
});

const GB = 1024 ** 3;

describe("extractPixeldrainId", () => {
  it("pulls the id out of a real feed description", () => {
    const html = `<ul>
      <li><a href="https://nyaa.si/download/2160005.torrent">Torrent</a></li>
      <li><a href="https://pixeldrain.net/u/73EVynVY">Pixeldrain</a></li>
    </ul>`;
    expect(extractPixeldrainId(html)).toBe("73EVynVY");
  });

  it("handles HTML-escaped markup, which is how it arrives in the feed", () => {
    expect(extractPixeldrainId('&lt;a href=&quot;https://pixeldrain.net/u/1JJVE3Cu&quot;&gt;'))
      .toBe("1JJVE3Cu");
  });

  it("returns null for the ~58% of items that offer no direct link", () => {
    expect(extractPixeldrainId('<li><a href="https://nyaa.si/download/1.torrent">Torrent</a></li>')).toBeNull();
    expect(extractPixeldrainId(undefined)).toBeNull();
  });
});

describe("parsePixeldrainId", () => {
  it("accepts share URLs, API URLs and bare ids", () => {
    expect(parsePixeldrainId("https://pixeldrain.net/u/73EVynVY")).toBe("73EVynVY");
    expect(parsePixeldrainId("https://pixeldrain.com/u/73EVynVY")).toBe("73EVynVY");
    expect(parsePixeldrainId("https://pixeldrain.net/api/file/73EVynVY")).toBe("73EVynVY");
    expect(parsePixeldrainId("73EVynVY")).toBe("73EVynVY");
  });

  it("rejects anything that isn't an id", () => {
    expect(parsePixeldrainId("https://nyaa.si/view/2160005")).toBeNull();
    expect(parsePixeldrainId("")).toBeNull();
    expect(parsePixeldrainId(null)).toBeNull();
  });
});

describe("limitsAllow", () => {
  it("permits a normal 1GB episode against a fresh allowance", () => {
    expect(limitsAllow(limits(), GB)).toEqual({ ok: true });
  });

  it("treats an unadvertised transfer limit as no limit", () => {
    // One Pace's files bill to their own paid bandwidth and report 0 here;
    // reading that as "exhausted" would disable the feature entirely.
    expect(limitsAllow(limits({ transferLimit: 0 }), 50 * GB)).toEqual({ ok: true });
  });

  it("defers to the torrent once the allowance can't cover the file", () => {
    const v = limitsAllow(limits({ transferUsed: 5_800_000_000 }), GB);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("allowance too low");
  });

  it("keeps headroom rather than starting a transfer that would die at the limit", () => {
    // 1.2GB left, 1GB file: it would *just* fit, but a partial transfer that
    // dies at the ceiling wastes more than deferring does.
    const v = limitsAllow(limits({ transferUsed: 6_000_000_000 - 1_288_490_188 }), GB);
    expect(v.ok).toBe(false);
  });

  it("defers when throttled, overloaded, or out of downloads", () => {
    expect(limitsAllow(limits({ speedLimit: 1_000_000 }), GB).ok).toBe(false);
    expect(limitsAllow(limits({ serverOverload: true }), GB).ok).toBe(false);
    expect(limitsAllow(limits({ downloadUsed: 10_000 }), GB).ok).toBe(false);
  });
});

describe("partPathFor", () => {
  it("keeps partials beside the destination so a resume can find them", () => {
    expect(partPathFor("/downloads/x.mkv")).toBe("/downloads/x.mkv.part");
  });
});
