import { describe, it, expect, vi, afterAll } from "vitest";
import http from "http";

// Security headers land on every dashboard response — including the health
// probe, API 404s, and static files — via a single setSecurityHeaders call at
// the top of the request handler. Boots the real startDashboard on an
// ephemeral port with everything else mocked.

vi.mock("../src/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  runAction: vi.fn(),
  runEpisodeAction: vi.fn(),
  runBulkEpisodeAction: vi.fn(),
  runNormalizeNaming: vi.fn(),
  runtime: () => ({}),
  isBusy: () => false,
  busyLabel: () => null,
  BULK_EPISODE_ACTIONS: [],
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

const { startDashboard } = await import("../src/web/server");

let server: http.Server;
let port = 0;

async function boot(): Promise<number> {
  if (port) return port;
  server = startDashboard();
  await new Promise<void>((resolve) => server.on("listening", resolve));
  port = (server.address() as import("net").AddressInfo).port;
  return port;
}

afterAll(() => {
  server?.close();
});

function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return boot().then(
    (p) =>
      new Promise((resolve, reject) => {
        http
          .get({ port: p, path }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
          })
          .on("error", reject);
      })
  );
}

describe("dashboard security headers", () => {
  for (const path of ["/api/health", "/api/nonexistent", "/"]) {
    it(`hardens ${path}`, async () => {
      const r = await get(path);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });
  }
});
