import Parser from "rss-parser";
import { logger } from "./logger";
import { getSettingValue } from "./settings";

export interface TorrentSearchResult {
  source: "animetosho" | "nyaa";
  title: string;
  magnet: string | null;
  torrentUrl: string | null;
  infoHash: string | null;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  publishedAt: number | null;
  pageUrl: string | null;
  isBatch: boolean;
}

interface AtoItem {
  title?: string;
  link?: string;
  timestamp?: number;
  torrent_url?: string;
  info_hash?: string;
  magnet_uri?: string;
  seeders?: number;
  leechers?: number;
  total_size?: number;
  num_files?: number;
}

interface NyaaItem {
  title?: string;
  link?: string;
  pubDate?: string;
  nyaaSeeders?: string;
  nyaaLeechers?: string;
  nyaaSize?: string;
  nyaaInfoHash?: string;
}

const NYAA_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
];

const nyaaParser = new Parser<Record<string, unknown>, NyaaItem>({
  customFields: {
    item: [
      ["nyaa:seeders", "nyaaSeeders"],
      ["nyaa:leechers", "nyaaLeechers"],
      ["nyaa:size", "nyaaSize"],
      ["nyaa:infoHash", "nyaaInfoHash"],
    ],
  },
});

// AniTosho returns 30000–99999 as "unknown" sentinels for seeder/leecher counts.
function sanitizeCount(n: number | undefined): number | null {
  if (typeof n !== "number" || n < 0 || n >= 30_000) return null;
  return n;
}

async function searchAnimeTosho(query: string): Promise<TorrentSearchResult[]> {
  const base = getSettingValue("ANIMETOSHO_BASE_URL").replace(/\/$/, "");
  const apiKey = getSettingValue("ANIMETOSHO_API_KEY");
  let url = `${base}/json?q=${encodeURIComponent(query)}&only_tor=1`;
  if (apiKey) url += `&api_key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const json: unknown = await resp.json();
  if (!Array.isArray(json)) return [];

  return (json as AtoItem[]).map((item) => ({
    source: "animetosho" as const,
    title: item.title ?? "",
    magnet: item.magnet_uri ?? null,
    torrentUrl: item.torrent_url ?? null,
    infoHash: item.info_hash ?? null,
    size: typeof item.total_size === "number" ? item.total_size : null,
    seeders: sanitizeCount(item.seeders),
    leechers: sanitizeCount(item.leechers),
    publishedAt: typeof item.timestamp === "number" ? item.timestamp * 1000 : null,
    pageUrl: item.link ?? null,
    isBatch: typeof item.num_files === "number" && item.num_files > 1,
  }));
}

function buildNyaaMagnet(infoHash: string, title: string): string {
  const parts = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(title)}`,
    ...NYAA_TRACKERS.map((tr) => `tr=${encodeURIComponent(tr)}`),
  ];
  return `magnet:?${parts.join("&")}`;
}

function parseNyaaSize(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B)$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = {
    gib: 1024 ** 3, mib: 1024 ** 2, kib: 1024,
    gb: 1e9, mb: 1e6, kb: 1e3, b: 1,
  };
  return Math.round(val * (mult[unit] ?? 1));
}

async function searchNyaa(query: string): Promise<TorrentSearchResult[]> {
  const base = getSettingValue("NYAA_BASE_URL").replace(/\/$/, "");
  const url = `${base}/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const feed = await nyaaParser.parseString(await resp.text());
  return (feed.items ?? []).map((item) => {
    const infoHash = item.nyaaInfoHash ?? null;
    const title = item.title ?? "";
    const magnet = infoHash ? buildNyaaMagnet(infoHash, title) : null;
    // guid is the view page permalink; link is the direct .torrent download
    const rawGuid = (item as Record<string, unknown>).guid;
    const pageUrl = typeof rawGuid === "string" ? rawGuid : null;
    return {
      source: "nyaa" as const,
      title,
      magnet,
      torrentUrl: item.link ?? null,
      infoHash,
      size: parseNyaaSize(item.nyaaSize),
      seeders: item.nyaaSeeders ? parseInt(item.nyaaSeeders, 10) : null,
      leechers: item.nyaaLeechers ? parseInt(item.nyaaLeechers, 10) : null,
      publishedAt: item.pubDate ? Date.parse(item.pubDate) : null,
      pageUrl,
      isBatch: false,
    };
  });
}

export async function searchTorrents(query: string): Promise<TorrentSearchResult[]> {
  const [ato, nyaa] = await Promise.allSettled([
    searchAnimeTosho(query),
    searchNyaa(query),
  ]);
  if (ato.status === "rejected") logger.warn("AnimeTosho search failed", { error: String(ato.reason) });
  if (nyaa.status === "rejected") logger.warn("Nyaa search failed", { error: String(nyaa.reason) });
  const results: TorrentSearchResult[] = [
    ...(ato.status === "fulfilled" ? ato.value : []),
    ...(nyaa.status === "fulfilled" ? nyaa.value : []),
  ];
  // Sort by seeders descending; null (unknown) counts as -1
  return results.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
}
