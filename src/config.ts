import { z } from "zod";

const ConfigSchema = z.object({
  RSS_FEED_URL: z.string().url(),
  QBIT_URL: z.string().url().default("http://qbittorrent:8080"),
  QBIT_USERNAME: z.string().default("admin"),
  QBIT_PASSWORD: z.string(),
  QBIT_CATEGORY: z.string().default("one-pace"),
  QBIT_DOWNLOAD_PATH: z.string().default("/downloads/one-pace"),
  PLEX_URL: z.string().url().default("http://plex:32400"),
  PLEX_TOKEN: z.string(),
  PLEX_LIBRARY_SECTION_ID: z.string(),
  PLEX_SERIES_RATING_KEY: z.string().optional(),
  MEDIA_PATH: z.string(),
  SERIES_FOLDER_NAME: z.string().default("One Pace"),
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  POLL_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),
  METADATA_REPO_RAW_BASE: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/ladyisatis/one-pace-metadata/v2"
    ),
  DATA_DIR: z.string().default("/data"),
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
