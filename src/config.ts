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
  POLL_CRON: z.string().default("0 * * * *"),
  SYNC_CRON: z.string().default("0 3 * * *"),
  METADATA_REPO_RAW_BASE: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/ladyisatis/one-pace-metadata/v2"
    ),
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
