import { describe, it, expect } from "vitest";
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { thumbStats, isBlankStats } from "../src/metadata-audit";

const W = 64;
const H = 36;

function jpg(fn: (x: number, y: number) => [number, number, number]): Buffer {
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  return Buffer.from(jpeg.encode({ data, width: W, height: H }, 90).data);
}

function png(fn: (x: number, y: number) => [number, number, number, number]): Buffer {
  const p = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * W + x) * 4;
      p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = a;
    }
  return PNG.sync.write(p);
}

describe("thumbStats / isBlankStats", () => {
  it("flags a solid black JPEG (fade frame) as blank", () => {
    const s = thumbStats(jpg(() => [0, 0, 0]))!;
    expect(s.rgbStddev).toBeLessThan(8);
    expect(isBlankStats(s)).toBe(true);
  });

  it("flags a solid white JPEG (the 'Void' frame) as blank", () => {
    const s = thumbStats(jpg(() => [255, 255, 255]))!;
    expect(isBlankStats(s)).toBe(true);
  });

  it("does NOT flag a busy real frame", () => {
    const s = thumbStats(jpg((x, y) => [(x * 17 + y * 31) % 256, (x * 7) % 200, (y * 13) % 230]))!;
    expect(s.rgbStddev).toBeGreaterThan(8);
    expect(isBlankStats(s)).toBe(false);
  });

  it("flags a fully transparent PNG as blank", () => {
    const s = thumbStats(png(() => [0, 0, 0, 0]))!;
    expect(s.transparentFrac).toBeGreaterThanOrEqual(0.85);
    expect(isBlankStats(s)).toBe(true);
  });

  it("flags a transparent PNG even when it has varying RGB under the alpha", () => {
    // A naive variance check on RGB would be fooled; the alpha channel isn't.
    const s = thumbStats(png((x, y) => [x * 4, y * 7, 128, 0]))!;
    expect(isBlankStats(s)).toBe(true);
  });

  it("does NOT flag an opaque real PNG", () => {
    const s = thumbStats(png((x, y) => [(x * 17 + y * 31) % 256, (x * 7) % 200, (y * 13) % 230, 255]))!;
    expect(isBlankStats(s)).toBe(false);
  });

  it("returns null for undecodable bytes", () => {
    expect(thumbStats(Buffer.from("not an image"))).toBeNull();
  });
});
