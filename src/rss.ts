import Parser from "rss-parser";
import { logger } from "./logger";
import { getKv, setKv } from "./db";
import { getSettingValue } from "./settings";
import { extractCrc32FromFilename, lookupCrc32ByTitle, refreshMetadata } from "./metadata";

export interface RssEpisode {
  guid: string;
  title: string;
  magnet: string;
  filename: string;
  crc32: string;
  pubDate: string;
  changelog: string[];
}

type RssItem = {
  guid?: string;
  title?: string;
  link?: string;
  pubDate?: string;
  content?: string;
  magnetURI?: string;
  torrentFileName?: string;
  infoHash?: string;
  enclosure?: { url?: string; type?: string; length?: string };
  [key: string]: unknown;
};

const parser = new Parser<Record<string, unknown>, RssItem>({
  customFields: {
    item: [
      ["torrent:magnetURI", "magnetURI"],
      ["torrent:fileName", "torrentFileName"],
      ["torrent:infoHash", "infoHash"],
    ],
  },
});

export async function fetchNewEpisodes(
  isGuidSeen: (guid: string) => boolean
): Promise<RssEpisode[]> {
  const RSS_FEED_URL = getSettingValue("RSS_FEED_URL");
  logger.info("Polling RSS feed", { url: RSS_FEED_URL });

  const headers: Record<string, string> = {};
  const lastModified = getKv("rss_last_modified");
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  let feed;
  try {
    const resp = await fetch(RSS_FEED_URL, { headers, signal: AbortSignal.timeout(20_000) });

    if (resp.status === 304) {
      logger.debug("RSS feed unchanged (304), skipping");
      return [];
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const newLastModified = resp.headers.get("Last-Modified");
    if (newLastModified) setKv("rss_last_modified", newLastModified);

    feed = await parser.parseString(await resp.text());
  } catch (err) {
    throw new Error(`RSS fetch failed: ${(err as Error).message}`);
  }

  const items = (feed.items ?? []) as RssItem[];

  // If any unseen item exists, a release (or re-release) just landed — refresh
  // metadata before resolving so an updated CRC32 resolves correctly.
  const hasNew = items.some((it) => {
    const g = it.guid ?? it.link ?? it.title ?? "";
    return g && !isGuidSeen(g);
  });
  if (hasNew) {
    try {
      await refreshMetadata();
    } catch (err) {
      logger.warn("Metadata refresh failed, resolving against cached data", {
        error: (err as Error).message,
      });
    }
  }

  const newEpisodes: RssEpisode[] = [];

  for (const item of items) {
    const guid = item.guid ?? item.link ?? item.title ?? "";
    if (!guid || isGuidSeen(guid)) continue;

    const magnet = extractMagnet(item);
    if (!magnet) {
      logger.warn("RSS item has no magnet link, skipping", { title: item.title });
      continue;
    }

    // Prefer filename from torrent:fileName, then dn= param in magnet
    const filename =
      cleanTorrentFilename(item.torrentFileName) ??
      extractFilenameFromMagnet(magnet) ??
      item.title ??
      "";

    let crc32 = filename ? extractCrc32FromFilename(filename) : null;

    // Fallback: look up CRC32 by arc title + episode number from RSS item title
    if (!crc32 && item.title) {
      logger.debug("CRC32 not in filename, attempting title-based lookup", { title: item.title });
      crc32 = await lookupCrc32ByTitle(item.title).catch(() => null);
    }

    if (!crc32) {
      logger.warn("Could not determine CRC32 for RSS item, skipping", {
        title: item.title,
        filename,
      });
      continue;
    }

    newEpisodes.push({
      guid,
      title: item.title ?? "",
      magnet,
      filename,
      crc32,
      pubDate: item.pubDate ?? new Date().toISOString(),
      changelog: extractChangelog(item.content),
    });
  }

  logger.info(`Found ${newEpisodes.length} new episode(s) in RSS feed`);
  return newEpisodes;
}

/**
 * Scans the live RSS feed for an item whose CRC32 matches targetCrc32.
 * Used to retrieve a magnet link for a re-release that predates the app's
 * RSS tracking (i.e. the item was never stored in the episodes table).
 */
export async function findMagnetByCrc32(targetCrc32: string): Promise<{
  magnet: string;
  guid: string;
  filename: string;
  changelog: string[];
} | null> {
  const RSS_FEED_URL = getSettingValue("RSS_FEED_URL");
  let feed;
  try {
    const resp = await fetch(RSS_FEED_URL, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    feed = await parser.parseString(await resp.text());
  } catch (err) {
    throw new Error(`RSS fetch failed: ${(err as Error).message}`);
  }

  const upper = targetCrc32.toUpperCase();
  for (const item of (feed.items ?? []) as RssItem[]) {
    const magnet = extractMagnet(item);
    if (!magnet) continue;
    const filename =
      cleanTorrentFilename(item.torrentFileName) ??
      extractFilenameFromMagnet(magnet) ??
      "";
    const crc32 = filename ? extractCrc32FromFilename(filename) : null;
    if (crc32?.toUpperCase() === upper) {
      return {
        magnet,
        guid: item.guid ?? item.link ?? item.title ?? "",
        filename,
        changelog: extractChangelog(item.content),
      };
    }
  }
  return null;
}

/**
 * Returns the set of CRC32s (uppercase) that currently have a magnet link
 * in the RSS feed. Used by the coverage scan to determine hasMagnet without
 * requiring each CRC32 to already be in the episodes DB.
 */
export async function getRssCrc32Set(): Promise<Set<string>> {
  const RSS_FEED_URL = getSettingValue("RSS_FEED_URL");
  let feed;
  try {
    const resp = await fetch(RSS_FEED_URL, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    feed = await parser.parseString(await resp.text());
  } catch {
    return new Set();
  }

  const crc32s = new Set<string>();
  for (const item of (feed.items ?? []) as RssItem[]) {
    const magnet = extractMagnet(item);
    if (!magnet) continue;
    const filename =
      cleanTorrentFilename(item.torrentFileName) ??
      extractFilenameFromMagnet(magnet) ??
      "";
    const crc32 = filename ? extractCrc32FromFilename(filename) : null;
    if (crc32) crc32s.add(crc32.toUpperCase());
  }
  return crc32s;
}

/**
 * First-run seed: marks every GUID currently in the feed as seen WITHOUT
 * downloading. Prevents a fresh install (empty rss_seen) from mass-downloading
 * and replacing files the user already has on disk. Genuinely new releases that
 * appear after seeding are picked up normally.
 */
export async function seedSeenGuids(markSeen: (guid: string) => void): Promise<number> {
  const RSS_FEED_URL = getSettingValue("RSS_FEED_URL");
  const resp = await fetch(RSS_FEED_URL, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`RSS seed fetch failed: HTTP ${resp.status}`);

  const lastModified = resp.headers.get("Last-Modified");
  if (lastModified) setKv("rss_last_modified", lastModified);

  const feed = await parser.parseString(await resp.text());
  let count = 0;
  for (const item of (feed.items ?? []) as RssItem[]) {
    const guid = item.guid ?? item.link ?? item.title ?? "";
    if (guid) {
      markSeen(guid);
      count++;
    }
  }
  return count;
}

function extractMagnet(item: RssItem): string | null {
  if (item.magnetURI?.startsWith("magnet:")) return item.magnetURI;
  if (item.link?.startsWith("magnet:")) return item.link;
  if (item.enclosure?.url?.startsWith("magnet:")) return item.enclosure.url;
  return null;
}

function extractFilenameFromMagnet(magnet: string): string | null {
  try {
    const url = new URL(magnet);
    const dn = url.searchParams.get("dn");
    if (!dn) return null;
    const decoded = decodeURIComponent(dn);
    return decoded.endsWith(".torrent") ? decoded.slice(0, -".torrent".length) : decoded;
  } catch {
    return null;
  }
}

function cleanTorrentFilename(name: string | undefined): string | null {
  if (!name) return null;
  return name.endsWith(".torrent") ? name.slice(0, -".torrent".length) : name;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * Pulls the changelog bullet list out of the RSS description HTML.
 * Re-releases carry a <details><summary>Changelog</summary><ul><li>…</li></ul></details>
 * block; first-time releases have none, returning [].
 */
export function extractChangelog(html: string | undefined): string[] {
  if (!html) return [];
  const block = html.match(/<summary>\s*Changelog\s*<\/summary>(.*?)<\/details>/is);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>(.*?)<\/li>/gis)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()))
    .filter(Boolean);
}
