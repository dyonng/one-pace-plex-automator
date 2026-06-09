import { z } from "zod";

const ConfigSchema = z.object({
  RSS_FEED_URL: z.string().url(),
  QBIT_URL: z.string().url().default("http://qbittorrent:8080"),
  QBIT_USERNAME: z.string().default("admin"),
  QBIT_PASSWORD: z.string(),
  QBIT_CATEGORY: z.string().default("one-pace"),
  PLEX_URL: z.string().url().default("http://plex:32400"),
  PLEX_TOKEN: z.string(),
  PLEX_LIBRARY_NAME: z.string().default("TV Shows"),
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  POLL_CRON: z.string().default("*/5 * * * *"),
  // When false, the RSS poll cron is not scheduled — polling is manual-only
  // (dashboard "Poll RSS"). The download-completion check is unaffected.
  POLL_ENABLED: z.coerce.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  DOWNLOAD_CHECK_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  // When true, discovered releases are queued immediately; when false they wait
  // in the dashboard as "available" until the user clicks Download.
  AUTO_DOWNLOAD: z.coerce.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  // Dashboard: enabled when a secret is configured, otherwise the web server does
  // not start (fail-safe — no unauthenticated controls exposed). Prefer
  // DASHBOARD_TOKEN_HASH (scrypt hash, no plaintext at rest); DASHBOARD_TOKEN is a
  // plaintext fallback. Generate a hash with `npm run hash-token -- <password>`.
  DASHBOARD_TOKEN_HASH: z.string().min(1).optional(),
  DASHBOARD_TOKEN: z.string().min(1).optional(),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8282),
  METADATA_REPO_RAW_BASE: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/ladyisatis/one-pace-metadata/v2"
    ),
  // Fan-made season/show posters (SpykerNZ/one-pace-for-plex). Files:
  // poster.png, season-specials-poster.png, seasonNN-poster.png (zero-padded).
  POSTER_REPO_RAW_BASE: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/SpykerNZ/one-pace-for-plex/main/One%20Pace"
    ),
  // Auto-apply a season's poster when a brand-new season first appears.
  AUTO_POSTERS: z.coerce.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  // When true, the extended cut is preferred over the standard cut for episodes
  // that have both. Affects which release is treated as canonical in coverage
  // and which variant the RSS poll downloads.
  PREFER_EXTENDED: z.coerce.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  // When true, the arc 14 title "Alabasta" is rendered as "Arabasta" everywhere
  // (coverage, filenames, Plex). The metadata uses "Alabasta"; this is a spelling
  // preference.
  PREFER_ARABASTA: z.coerce.string().default("true").transform((v) => v.toLowerCase() !== "false"),
  ANIMETOSHO_API_KEY: z.string().default(""),
  ANIMETOSHO_BASE_URL: z.string().url().default("https://feed.animetosho.xyz"),
  NYAA_BASE_URL: z.string().url().default("https://nyaa.si"),
  // The official One Pace episode guide (Google Sheet). Used as an extra source
  // to recover an episode's CRC32 when a release lands before the metadata repo
  // is regenerated. Requires a Google Sheets API key with the Sheets API enabled.
  GOOGLE_SHEETS_API_KEY: z.string().default(""),
  ONEPACE_SHEET_ID: z.string().default("1HQRMJgu_zArp-sLnvFMDzOyjdsht87eFLECxMK858lA"),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${missing}`);
  }
  _config = result.data;
  return _config;
}
