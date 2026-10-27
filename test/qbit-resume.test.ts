import { describe, it, expect, vi, beforeEach } from "vitest";

// qBittorrent 5.x removed /torrents/resume (404 "Endpoint does not exist") in
// favor of /torrents/start. resumeTorrents must fall back, or every pack
// download stays paused forever — which is exactly what happened to the first
// live Post-Enies Lobby pack.

const post = vi.fn();
const request = vi.fn();

vi.mock("axios", () => ({
  default: {
    create: () => ({ post, request }),
    isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

process.env.QBIT_PASSWORD ??= "test";
process.env.RSS_FEED_URL ??= "http://example.com/feed";
process.env.PLEX_TOKEN ??= "test";

import { getQbitClient } from "../src/qbittorrent";

const HASH = "59497fc3d9a6dbcdbaced48eaa9f5ba2047614df";

function fail(status: number) {
  const err = { isAxiosError: true, response: { status, data: "Endpoint does not exist" } };
  return Promise.reject(err);
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ headers: { "set-cookie": ["SID=x"] } });
  request.mockResolvedValue({ data: "" });
});

describe("resumeTorrents", () => {
  it("resumes via /torrents/resume when the endpoint exists", async () => {
    await getQbitClient().resumeTorrents([HASH]);

    const paths = request.mock.calls.map(([{ url }]) => url);
    expect(paths).toContain("/torrents/resume");
    expect(paths).not.toContain("/torrents/start");
  });

  it("falls back to /torrents/start when resume is gone (qBittorrent 5.x)", async () => {
    request.mockImplementation(({ url }: { url: string }) =>
      url === "/torrents/resume" ? fail(404) : Promise.resolve({ data: "" })
    );

    await getQbitClient().resumeTorrents([HASH]);

    const paths = request.mock.calls.map(([{ url }]) => url);
    expect(paths).toContain("/torrents/resume");
    expect(paths).toContain("/torrents/start");
  });

  it("rethows non-404 failures without falling back", async () => {
    request.mockImplementation(() => fail(500));

    await expect(getQbitClient().resumeTorrents([HASH])).rejects.toThrow("failed with 500");
    expect(request.mock.calls.map(([{ url }]) => url)).not.toContain("/torrents/start");
  });
});
