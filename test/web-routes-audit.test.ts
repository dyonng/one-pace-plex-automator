import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "http";

// Route wiring for the download-missing endpoint and the audit trail on
// destructive routes. The router itself is covered by exact-segment matching, so
// what matters here is that the new path reaches runBulkEpisodeAction("upgrade")
// and that a bulk removal logs who asked for it — the mass-removal incident left
// no record of its trigger.

const { runBulkEpisodeAction, runEpisodeAction, runAction, loggerInfo } = vi.hoisted(() => ({
  runBulkEpisodeAction: vi.fn(async () => ({ ok: true, message: "Started 1 episode", succeeded: 1, failed: 0, results: [] })),
  runEpisodeAction: vi.fn(async () => ({ ok: true, message: "Removed S35E11" })),
  runAction: vi.fn(async () => ({ ok: true, message: "done" })),
  loggerInfo: vi.fn(),
}));

vi.mock("../src/logger", () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock("../src/config", () => ({ getConfig: () => ({ DASHBOARD_PORT: 0 }) }));
vi.mock("../src/db", () => ({
  getRecentLogs: vi.fn(() => []),
  listEpisodes: vi.fn(() => []),
  countByStatus: vi.fn(() => ({})),
  getEpisodesByStatus: vi.fn(() => []),
  getEpisodeByCrc32: vi.fn(() => null),
}));
vi.mock("../src/controls", () => ({
  runAction,
  runEpisodeAction,
  runBulkEpisodeAction,
  runNormalizeNaming: vi.fn(),
  runtime: () => ({}),
  isBusy: () => false,
  busyLabel: () => null,
  BULK_EPISODE_ACTIONS: ["retry", "remove", "upgrade"],
}));
vi.mock("../src/coverage", () => ({
  scanCoverage: vi.fn(), getStoredCoverage: vi.fn(() => null), getCoverageScannedAt: vi.fn(() => 0),
}));
vi.mock("../src/metadata", () => ({ getData: vi.fn(), resolveEpisodeByCrc32: vi.fn() }));
vi.mock("../src/metadata-audit", () => ({
  scanMetadataAudit: vi.fn(), getStoredAudit: vi.fn(() => null), getAuditScannedAt: vi.fn(() => 0),
}));
vi.mock("../src/plex", () => ({ resolvePlexConnection: vi.fn() }));
vi.mock("../src/qbittorrent", () => ({ getQbitClient: () => ({}) }));
vi.mock("../src/torrent-search", () => ({ searchTorrents: vi.fn(async () => []) }));
vi.mock("../src/settings", () => ({
  describeSettings: vi.fn(() => []), applySetting: vi.fn(), resetSetting: vi.fn(), getSettingValue: vi.fn(),
}));
vi.mock("../src/health", () => ({ getStoredHealth: vi.fn(() => null), runHealthCheck: vi.fn() }));
vi.mock("../src/discord", () => ({ sendDiscordTest: vi.fn() }));
vi.mock("../src/poster-sets", () => ({ describePosterSets: vi.fn(() => []) }));
vi.mock("../src/naming", () => ({ scanNamingCandidates: vi.fn(() => []) }));
vi.mock("../src/update-check", () => ({ getUpdateAvailable: vi.fn(() => false) }));
vi.mock("../src/fileops", () => ({ getEpisodeFileSize: vi.fn(() => 0) }));
vi.mock("../src/web/auth", () => ({
  checkRequestAuth: vi.fn(() => true),
  getAuthState: vi.fn(() => ({ enabled: false })),
  setPassword: vi.fn(), setAuthEnabled: vi.fn(), isAuthEnabled: vi.fn(() => false),
}));

const { buildRouter } = await import("../src/web/server");

/** Drives the real Router with a fake req/res pair. */
async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const router = buildRouter();
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(
    new (require("stream").Readable)({
      read() {
        for (const c of chunks) this.push(c);
        this.push(null);
      },
    }),
    { method, url, headers: { host: "x", ...headers }, socket: { remoteAddress: "10.0.0.9" } }
  ) as unknown as http.IncomingMessage;

  let status = 0;
  let payload = "";
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    end: (d?: string) => { payload = d ?? ""; return res; },
    on: () => res,
    headersSent: false,
  } as unknown as http.ServerResponse;

  await router.handle(req, res);
  return { status, body: payload ? JSON.parse(payload) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/episodes/download-missing", () => {
  it("routes to the bulk upgrade action", async () => {
    const r = await call("POST", "/api/episodes/download-missing", { crc32s: ["AAAAAAAA"] });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(runBulkEpisodeAction).toHaveBeenCalledWith("upgrade", ["AAAAAAAA"]);
  });

  it("logs the caller and the targets before acting", async () => {
    await call("POST", "/api/episodes/download-missing", { crc32s: ["AAAAAAAA"] }, { "user-agent": "vitest/1" });

    const entry = loggerInfo.mock.calls.find((c) => c[0] === "Download-missing requested");
    expect(entry).toBeTruthy();
    expect(entry![1]).toMatchObject({ count: 1, crc32s: ["AAAAAAAA"] });
    expect(entry![1].client).toContain("10.0.0.9");
    expect(entry![1].client).toContain("vitest/1");
  });

  it("tolerates a missing crc32s field", async () => {
    const r = await call("POST", "/api/episodes/download-missing", {});

    expect(r.status).toBe(200);
    expect(runBulkEpisodeAction).toHaveBeenCalledWith("upgrade", []);
  });
});

describe("bulk route accepts upgrade", () => {
  it("passes upgrade through to the bulk runner", async () => {
    const r = await call("POST", "/api/episodes/bulk/upgrade", { crc32s: ["AAAAAAAA"] });

    expect(r.status).toBe(200);
    expect(runBulkEpisodeAction).toHaveBeenCalledWith("upgrade", ["AAAAAAAA"], { deleteFile: false });
  });

  it("still rejects an unknown bulk action", async () => {
    const r = await call("POST", "/api/episodes/bulk/nonsense", { crc32s: ["AAAAAAAA"] });

    expect(r.status).toBe(404);
  });
});

describe("destructive routes leave an audit trail", () => {
  it("logs a bulk removal with the file-deletion flag and caller", async () => {
    await call(
      "POST",
      "/api/episodes/bulk/remove",
      { crc32s: ["AAAAAAAA", "BBBBBBBB"], deleteFile: true },
      { "user-agent": "curl/8" }
    );

    const entry = loggerInfo.mock.calls.find((c) => c[0] === "Bulk episode action requested");
    expect(entry).toBeTruthy();
    expect(entry![1]).toMatchObject({
      action: "remove",
      count: 2,
      deleteFile: true,
      crc32s: ["AAAAAAAA", "BBBBBBBB"],
    });
    expect(entry![1].client).toContain("curl/8");
  });

  it("logs a single-episode removal with the file-deletion flag", async () => {
    await call("POST", "/api/episodes/aaaaaaaa/remove", { deleteFile: true });

    const entry = loggerInfo.mock.calls.find((c) => c[0] === "Episode remove requested");
    expect(entry).toBeTruthy();
    expect(entry![1]).toMatchObject({ crc32: "AAAAAAAA", deleteFile: true });
    expect(runEpisodeAction).toHaveBeenCalledWith("remove", "AAAAAAAA", expect.objectContaining({ deleteFile: true }));
  });

  it("logs a global action request", async () => {
    await call("POST", "/api/actions/clear-done");

    const entry = loggerInfo.mock.calls.find((c) => c[0] === "Dashboard action requested");
    expect(entry).toBeTruthy();
    expect(entry![1]).toMatchObject({ action: "clear-done" });
  });
});
