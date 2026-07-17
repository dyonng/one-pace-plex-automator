import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import * as jpeg from "jpeg-js";
import { MEDIA_PATH } from "./constants";
import { logger } from "./logger";

const execFileP = promisify(execFile);

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov"]);

// Sample this many frames, spread across the middle of the runtime — the edges
// are skipped because that's where intros/outros/fades (blank frames) live.
const SAMPLE_COUNT = 8;
const SAMPLE_START = 0.12;
const SAMPLE_END = 0.88;
// The winning frame must have at least this much pixel spread, else we'd just
// be uploading another blank.
const MIN_ACCEPT_STDDEV = 10;

// ffmpeg missing from the environment (e.g. local dev outside Docker) — detect
// once and stop trying for the rest of the process. Read via the function so
// TS doesn't narrow across the awaits that can mutate it.
let _ffmpegAvailable: boolean | null = null;
const ffmpegKnownMissing = (): boolean => _ffmpegAvailable === false;

/**
 * Finds the on-disk video file for an episode by its S##E## token, using the
 * same padding-agnostic match the rest of the pipeline uses.
 */
export function findLibraryFile(arcPart: number, episodeNum: number): string | null {
  if (!fs.existsSync(MEDIA_PATH)) return null;
  const re = new RegExp(`S0*${arcPart}(?!\\d)E0*${episodeNum}(?!\\d)`, "i");
  for (const dir of fs.readdirSync(MEDIA_PATH, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const seasonDir = path.join(MEDIA_PATH, dir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(seasonDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!VIDEO_EXTS.has(path.extname(f.name).toLowerCase())) continue;
      if (re.test(f.name)) return path.join(seasonDir, f.name);
    }
  }
  return null;
}

async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15_000 }
    );
    const dur = parseFloat(stdout.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") _ffmpegAvailable = false;
    return null;
  }
}

interface FrameScore {
  stddev: number; // max per-channel pixel spread — detail
  mean: number;   // average luminance — brightness
}

function scoreFrame(buf: Buffer): FrameScore | null {
  try {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
    const n = img.width * img.height;
    if (!n) return null;
    const sum = [0, 0, 0];
    const sumSq = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = img.data[i * 4 + c];
        sum[c] += v;
        sumSq[c] += v * v;
      }
    }
    let maxStd = 0;
    for (let c = 0; c < 3; c++) {
      const mean = sum[c] / n;
      maxStd = Math.max(maxStd, Math.sqrt(Math.max(0, sumSq[c] / n - mean * mean)));
    }
    const lum = (sum[0] + sum[1] + sum[2]) / (3 * n);
    return { stddev: maxStd, mean: lum };
  } catch {
    return null;
  }
}

/**
 * Extracts several frames from the episode's video, scores each by detail
 * (pixel spread) with a penalty for near-black/near-white brightness, and
 * returns the best one as JPEG bytes — or null when no usable frame was found
 * (or ffmpeg isn't available). Used as the escalation when Plex's own
 * generation keeps producing blank stills.
 */
export async function generateEpisodeThumb(
  arcPart: number,
  episodeNum: number
): Promise<Buffer | null> {
  if (ffmpegKnownMissing()) return null;

  const file = findLibraryFile(arcPart, episodeNum);
  if (!file) {
    logger.warn("Thumb generator: no library file found", { arcPart, episodeNum });
    return null;
  }

  const dur = await probeDuration(file);
  if (ffmpegKnownMissing()) {
    logger.warn("Thumb generator: ffmpeg/ffprobe not available — skipping generation");
    return null;
  }
  if (!dur) {
    logger.warn("Thumb generator: could not probe duration", { file: path.basename(file) });
    return null;
  }

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opthumb-"));
  try {
    let best: { buf: Buffer; score: number; stddev: number; t: number } | null = null;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const frac = SAMPLE_START + ((SAMPLE_END - SAMPLE_START) * i) / (SAMPLE_COUNT - 1);
      const t = dur * frac;
      const out = path.join(tmp, `f${i}.jpg`);
      try {
        await execFileP(
          "ffmpeg",
          [
            "-y", "-loglevel", "error",
            "-ss", t.toFixed(2),
            "-i", file,
            "-frames:v", "1",
            "-vf", "scale=854:-2",
            "-q:v", "3",
            out,
          ],
          { timeout: 30_000 }
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          _ffmpegAvailable = false;
          logger.warn("Thumb generator: ffmpeg not available — skipping generation");
          return null;
        }
        continue; // this frame failed; try the next timestamp
      }

      const buf = await fs.promises.readFile(out).catch(() => null);
      if (!buf) continue;
      const s = scoreFrame(buf);
      if (!s) continue;

      // Detail is the score; heavily penalize frames that are basically black
      // or white even if they have some texture.
      const brightnessPenalty = s.mean < 25 || s.mean > 230 ? 0.2 : 1;
      const score = s.stddev * brightnessPenalty;
      if (!best || score > best.score) best = { buf, score, stddev: s.stddev, t };
    }

    if (!best || best.stddev < MIN_ACCEPT_STDDEV) {
      logger.warn("Thumb generator: no usable frame found", {
        file: path.basename(file),
        bestStddev: best?.stddev.toFixed(1) ?? "none",
      });
      return null;
    }

    logger.info("Thumb generator: picked frame", {
      file: path.basename(file),
      at: `${Math.round(best.t)}s`,
      stddev: Number(best.stddev.toFixed(1)),
    });
    return best.buf;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
