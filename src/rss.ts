import Parser from "rss-parser";
import { getConfig } from "./config";
import { logger } from "./logger";
import { getKv, setKv } from "./db";
import { extractCrc32FromFilename, lookupCrc32ByTitle } from "./metadata";

export interface RssEpisode {
  guid: string;
  title: string;
  magnet: string;
  filename: string;
  crc32: string;
  pubDate: string;
}

type RssItem = {
  guid?: string;
  title?: string;
  link?: string;
  pubDate?: string;
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
  const { RSS_FEED_URL } = getConfig();
  logger.info("Polling RSS feed", { url: RSS_FEED_URL });

  const headers: Record<string, string> = {};
  const lastModified = getKv("rss_last_modified");
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  let feed;
  try {
    const resp = await fetch(RSS_FEED_URL, { headers });

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

  const newEpisodes: RssEpisode[] = [];

  for (const item of (feed.items ?? []) as RssItem[]) {
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
    });
  }

  logger.info(`Found ${newEpisodes.length} new episode(s) in RSS feed`);
  return newEpisodes;
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
