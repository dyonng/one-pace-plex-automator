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
      throw err;
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
    const hashMatch = source.match(/urn:btih:([a-fA-F0-9]{40})/i);

    // Otherwise snapshot the current hashes so we can spot the new torrent.
    const before = hashMatch
      ? null
      : new Set((await this.getTorrents()).map((t) => t.hash.toLowerCase()));

    // No savepath — qBittorrent writes to its own configured save dir. Our
    // container reads that same host dir mounted at DOWNLOAD_PATH (/downloads).
    const params = new URLSearchParams({
      urls: source,
      category: QBIT_CATEGORY,
      paused: "false",
    });
    await this.request<string>("post", "/torrents/add", params);

    if (hashMatch) {
      const hash = hashMatch[1].toLowerCase();
      logger.info("Added magnet to qBittorrent", { hash, category: QBIT_CATEGORY });
      return hash;
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
