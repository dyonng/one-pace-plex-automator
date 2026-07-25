import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the spammy "dataset not loaded yet" health alerts: a
// scheduled Refresh Sources invalidates the metadata cache, and that must NOT
// leave the dataset momentarily unloaded. clearMetadataCache() should only drop
// the ETag (forcing a full re-fetch); the current data stays live until the next
// refresh atomically swaps it in, and a failed refresh keeps the last-good copy.

vi.mock("../src/config", () => ({
  getConfig: () => ({ METADATA_REPO_RAW_BASE: "https://metadata.test" }),
}));

import { refreshMetadata, clearMetadataCache, isMetadataLoaded } from "../src/metadata";

const DATASET = { arcs: { en: [] }, descriptions: { en: [] }, episodes: {} };

function stubFetch(status: number, etag: string | null) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag : null) },
    json: async () => DATASET,
  }));
}

describe("metadata cache invalidation", () => {
  beforeEach(() => {
    clearMetadataCache(); // reset ETag between tests (does not unload data)
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the dataset loaded through a cache invalidation (no unloaded window)", async () => {
    vi.stubGlobal("fetch", stubFetch(200, 'W/"v1"'));
    await refreshMetadata();
    expect(isMetadataLoaded()).toBe(true);

    clearMetadataCache();
    // The whole point: data stays live until the next refresh swaps it.
    expect(isMetadataLoaded()).toBe(true);
  });

  it("sends a conditional request normally, but a full one after invalidation", async () => {
    const f = stubFetch(200, 'W/"v1"');
    vi.stubGlobal("fetch", f);

    await refreshMetadata(); // first load, stores the ETag
    await refreshMetadata(); // should now send If-None-Match
    const conditional = (f.mock.calls[1][1] as { headers: Record<string, string> }).headers;
    expect(conditional["If-None-Match"]).toBe('W/"v1"');

    clearMetadataCache(); // drops the ETag
    await refreshMetadata();
    const full = (f.mock.calls[2][1] as { headers: Record<string, string> }).headers;
    expect(full["If-None-Match"]).toBeUndefined();
  });

  it("keeps serving the last-good dataset when a refresh fails", async () => {
    vi.stubGlobal("fetch", stubFetch(200, 'W/"v1"'));
    await refreshMetadata();
    expect(isMetadataLoaded()).toBe(true);

    clearMetadataCache();
    vi.stubGlobal("fetch", stubFetch(503, null)); // metadata repo is down
    await expect(refreshMetadata()).rejects.toThrow();

    // Must not have nulled the dataset — that was the latent bug.
    expect(isMetadataLoaded()).toBe(true);
  });
});
