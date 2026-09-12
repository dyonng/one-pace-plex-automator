import axios, { AxiosInstance } from "axios";
import { getConfig } from "./config";
import { logger } from "./logger";

export type TorrentState =
  | "downloading"
  | "stalledDL"
  | "uploading"
  | "stalledUP"
  | "pausedDL"
  | "pausedUP"
  | "checkingDL"
  | "checkingUP"
  | "error"
  | "missingFiles"
  | "queuedDL"
  | "queuedUP"
  | "moving"
  | "unknown"
  | "forcedDL"
  | "forcedUP";

export interface TorrentInfo {
  hash: string;
  name: string;
  state: TorrentState;
  progress: number;
  save_path: string;
  content_path: string;
  completion_on: number;
  size: number;
  dlspeed: number; // bytes/s
  eta: number;     // seconds remaining, -1 if unknown
}

/** Axios hides qBittorrent's response body, which is where it explains itself. */
function enrichQbitError(err: unknown, path: string): Error {
  if (!axios.isAxiosError(err) || !err.response) return err as Error;
  const body = typeof err.response.data === "string" ? err.response.data.trim().slice(0, 200) : "";
  return new Error(
    `qBittorrent ${path} failed with ${err.response.status}${body ? `: ${body}` : ""}`
  );
}

/** The SHA-1 infohash carried inline by a v1 magnet, or null. */
function magnetInfoHash(source: string): string | null {
  return source.match(/urn:btih:([a-fA-F0-9]{40})/i)?.[1].toLowerCase() ?? null;
}

class QBittorrentClient {
  private client: AxiosInstance;
  private cookieJar: string | null = null;

  constructor() {
    const { QBIT_URL } = getConfig();
    this.client = axios.create({
      baseURL: `${QBIT_URL}/api/v2`,
      timeout: 15_000,
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.cookieJar) return;
    const { QBIT_USERNAME, QBIT_PASSWORD } = getConfig();

    const resp = await this.client.post(
      "/auth/login",
      new URLSearchParams({ username: QBIT_USERNAME, password: QBIT_PASSWORD }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (resp.data === "Fails.") {
      throw new Error("qBittorrent authentication failed — check credentials");
    }

    const setCookie = resp.headers["set-cookie"];
    this.cookieJar = Array.isArray(setCookie)
      ? setCookie.map((c) => c.split(";")[0]).join("; ")
      : (setCookie ?? "").split(";")[0];
  }

  private async request<T>(method: "get" | "post", path: string, data?: URLSearchParams): Promise<T> {
    await this.ensureAuthenticated();
    try {
      const resp = await this.client.request<T>({
        method,
        url: path,
        data,
        headers: {
          Cookie: this.cookieJar ?? "",
          ...(data ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
      });
      return resp.data;
    } catch (err) {
      // Re-auth on 403 and retry once
      if (axios.isAxiosError(err) && err.response?.status === 403) {
        this.cookieJar = null;
        await this.ensureAuthenticated();
        const resp = await this.client.request<T>({
          method,
          url: path,
          data,
          headers: { Cookie: this.cookieJar ?? "" },
        });
        return resp.data;
      }
      // Axios reports only "Request failed with status code N", which hides the
      // one-line reason qBittorrent puts in the body.
      throw enrichQbitError(err, path);
    }
  }

  /**
   * Adds a download source to qBittorrent and returns its 40-hex info hash.
   * Accepts a magnet URI **or** an http(s) `.torrent` URL (qBit's add endpoint
   * takes either in `urls`). For magnets the hash is read straight from the
   * `urn:btih:` token; otherwise (torrent URL, or a base32/v2 magnet) the hash
   * is resolved by diffing the category's torrent list after the add, since
   * completion detection keys off this hash.
   */
  async addMagnet(source: string): Promise<string> {
    const { QBIT_CATEGORY } = getConfig();

    // Fast path: a v1 magnet carries its SHA-1 infohash inline.
    const inlineHash = magnetInfoHash(source);

    // Otherwise snapshot the current hashes so we can spot the new torrent.
    const before = inlineHash
      ? null
      : new Set((await this.getTorrents()).map((t) => t.hash.toLowerCase()));

    // No savepath — qBittorrent writes to its own configured save dir. Our
    // container reads that same host dir mounted at DOWNLOAD_PATH (/downloads).
    const params = new URLSearchParams({
      urls: source,
      category: QBIT_CATEGORY,
      paused: "false",
    });
    try {
      await this.request<string>("post", "/torrents/add", params);
    } catch (err) {
      // A rejected add is not necessarily a failed add: qBittorrent refuses a
      // torrent it already holds (409 on 5.x). That happens whenever a previous
      // run downloaded the torrent but never got to remove it — an import that
      // errored, or the client going away mid-cycle. The torrent is present and
      // very possibly already complete, so adopt it rather than giving up.
      if (inlineHash && (await this.getTorrent(inlineHash))) {
        logger.info("Torrent already in qBittorrent — adopting the existing one", {
          hash: inlineHash, reason: (err as Error).message,
        });
        return inlineHash;
      }
      throw err;
    }

    if (inlineHash) {
      logger.info("Added magnet to qBittorrent", { hash: inlineHash, category: QBIT_CATEGORY });
      return inlineHash;
    }

    const hash = await this.resolveNewHash(before!);
    if (!hash) {
      logger.warn("Added torrent but could not resolve its info hash; completion detection may fail", {
        source: source.slice(0, 80),
      });
    } else {
      logger.info("Added torrent to qBittorrent", { hash, category: QBIT_CATEGORY });
    }
    return hash;
  }

  /** Polls the category's torrent list for a hash not present in `before`. */
  private async resolveNewHash(before: Set<string>): Promise<string> {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await this.getTorrents();
      const fresh = now.find((t) => !before.has(t.hash.toLowerCase()));
      if (fresh) return fresh.hash.toLowerCase();
    }
    return "";
  }

  /** Cheap reachability probe for health checks — authenticates then reads the app version. */
  async ping(): Promise<string> {
    return this.request<string>("get", "/app/version");
  }

  async getTorrents(hashes?: string[]): Promise<TorrentInfo[]> {
    const params = new URLSearchParams({ category: getConfig().QBIT_CATEGORY });
    if (hashes?.length) params.set("hashes", hashes.join("|"));
    return this.request<TorrentInfo[]>("get", `/torrents/info?${params}`);
  }

  async getTorrent(hash: string): Promise<TorrentInfo | null> {
    const list = await this.getTorrents([hash]);
    return list.find((t) => t.hash === hash.toLowerCase()) ?? null;
  }

  async isComplete(hash: string): Promise<boolean> {
    const torrent = await this.getTorrent(hash);
    if (!torrent) return false;
    const doneStates: TorrentState[] = ["uploading", "stalledUP", "pausedUP", "forcedUP", "checkingUP"];
    return doneStates.includes(torrent.state) || torrent.progress >= 1;
  }

  async deleteTorrent(hash: string, deleteFiles = false): Promise<void> {
    const params = new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) });
    await this.request<string>("post", "/torrents/delete", params);
    logger.info("Deleted torrent from qBittorrent", { hash });
  }
}

let _client: QBittorrentClient | null = null;
export function getQbitClient(): QBittorrentClient {
  _client ??= new QBittorrentClient();
  return _client;
}
