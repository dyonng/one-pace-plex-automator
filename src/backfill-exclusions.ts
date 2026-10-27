import { getKv, setKv } from "./db";

// A backfill queue is a guess: the indexer's title says the torrent carries
// the episode. Sometimes it doesn't — a re-upload keeping a stale title, or a
// pack whose file resolves into a different slot. Without memory, the next
// cycle picks the same best match and downloads gigabytes again, forever.
// So when an import proves a source cannot fill a slot, its infohash is
// recorded here and never offered for that slot again. Permanent is correct:
// a re-release changes the CRC32, which starts a fresh slot history.
const PREFIX = "backfill_excluded:";

export function getBackfillExcludedHashes(crc32: string): Set<string> {
  try {
    const raw = getKv(`${PREFIX}${crc32.toUpperCase()}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function recordBackfillExclusion(crc32: string, torrentHash: string | null): void {
  if (!torrentHash) return;
  const hash = torrentHash.toLowerCase();
  const hashes = getBackfillExcludedHashes(crc32);
  if (hashes.has(hash)) return;
  hashes.add(hash);
  setKv(`${PREFIX}${crc32.toUpperCase()}`, JSON.stringify([...hashes]));
}

/** Identity of a search result for exclusion purposes, whatever form it came in. */
export function candidateSourceHash(
  magnet: string | null,
  infoHash: string | null
): string | null {
  if (infoHash) return infoHash.toLowerCase();
  const m = magnet?.match(/urn:btih:([a-zA-Z0-9]{32,64})/i);
  return m ? m[1].toLowerCase() : null;
}
