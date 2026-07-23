import { EventEmitter } from "events";
import cron from "node-cron";
import { getConfig } from "./config";
import { getSettingOverride, setSettingOverride, deleteSettingOverride } from "./db";

export type SettingKey =
  | "POLL_CRON"
  | "POLL_ENABLED"
  | "DOWNLOAD_CHECK_SECONDS"
  | "AUTO_DOWNLOAD"
  | "AUTO_POSTERS"
  | "AUTO_RECONCILE"
  | "PREFER_EXTENDED"
  | "PREFER_ARABASTA"
  | "DISCORD_WEBHOOK_URL"
  | "NOTIFY_NEW_EPISODE"
  | "NOTIFY_DOWNLOAD_COMPLETE"
  | "NOTIFY_EPISODE_UPDATED"
  | "NOTIFY_ERROR"
  | "NOTIFY_HEALTH"
  | "RSS_FEED_URL"
  | "POSTER_REPO_RAW_BASE"
  | "ANIMETOSHO_API_KEY"
  | "ANIMETOSHO_BASE_URL"
  | "NYAA_BASE_URL"
  | "GOOGLE_SHEETS_API_KEY";
export type SettingType = "cron" | "int" | "bool" | "url" | "url_or_empty" | "text";
export type SettingCategory = "service" | "preference" | "notification";

// Splits the settings UI: "service" = infrastructure/integration config,
// "notification" = the Discord webhook + which events to send, "preference" =
// how the app behaves and names things for you.
const CATEGORY: Record<SettingKey, SettingCategory> = {
  POLL_ENABLED: "service",
  POLL_CRON: "service",
  DOWNLOAD_CHECK_SECONDS: "service",
  RSS_FEED_URL: "service",
  POSTER_REPO_RAW_BASE: "service",
  ANIMETOSHO_API_KEY: "service",
  ANIMETOSHO_BASE_URL: "service",
  NYAA_BASE_URL: "service",
  GOOGLE_SHEETS_API_KEY: "service",
  DISCORD_WEBHOOK_URL: "notification",
  NOTIFY_NEW_EPISODE: "notification",
  NOTIFY_DOWNLOAD_COMPLETE: "notification",
  NOTIFY_EPISODE_UPDATED: "notification",
  NOTIFY_ERROR: "notification",
  NOTIFY_HEALTH: "notification",
  AUTO_DOWNLOAD: "preference",
  AUTO_POSTERS: "preference",
  AUTO_RECONCILE: "preference",
  PREFER_EXTENDED: "preference",
  PREFER_ARABASTA: "preference",
};

type ValidateResult = { ok: true; value: string } | { ok: false; error: string };

interface SettingDef {
  key: SettingKey;
  label: string;
  type: SettingType;
  envValue: () => string;
  validate: (raw: string) => ValidateResult;
}

// Settings changes are broadcast so live components (scheduler) can re-apply them.
export const settingsBus = new EventEmitter();

function validateCron(raw: string): ValidateResult {
  const v = raw.trim();
  return cron.validate(v) ? { ok: true, value: v } : { ok: false, error: "Invalid cron expression" };
}

function validateInt(min: number, max: number) {
  return (raw: string): ValidateResult => {
    const n = Number(raw);
    if (!Number.isInteger(n)) return { ok: false, error: "Must be a whole number" };
    if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}` };
    return { ok: true, value: String(n) };
  };
}

function validateUrl(raw: string): ValidateResult {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Must be http(s)" };
    return { ok: true, value: raw.trim() };
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
}

function validateDiscordWebhook(raw: string): ValidateResult {
  if (raw.trim() === "") return { ok: true, value: "" }; // empty = notifications off
  const base = validateUrl(raw);
  if (!base.ok) return base;
  const u = new URL(base.value);
  if (u.protocol !== "https:") return { ok: false, error: "Discord webhooks must use https" };
  // Expect a real webhook path: .../webhooks/{id}/{token} (host kept flexible to
  // allow official discord.com/discordapp.com hosts and webhook proxies).
  if (!/\/webhooks\/\d+\/[\w-]+/.test(u.pathname)) {
    return { ok: false, error: "Not a Discord webhook URL (expected .../webhooks/{id}/{token})" };
  }
  return { ok: true, value: base.value };
}

function validateText(raw: string): ValidateResult {
  return { ok: true, value: raw.trim() };
}

function validateBool(raw: string): ValidateResult {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "false") return { ok: true, value: v };
  return { ok: false, error: "Must be true or false" };
}

const DEFS: Record<SettingKey, SettingDef> = {
  POLL_ENABLED: {
    key: "POLL_ENABLED",
    label: "Scheduled refresh (off = manual Refresh Sources only)",
    type: "bool",
    envValue: () => String(getConfig().POLL_ENABLED),
    validate: validateBool,
  },
  POLL_CRON: {
    key: "POLL_CRON",
    label: "Refresh Sources schedule (cron)",
    type: "cron",
    envValue: () => getConfig().POLL_CRON,
    validate: validateCron,
  },
  DOWNLOAD_CHECK_SECONDS: {
    key: "DOWNLOAD_CHECK_SECONDS",
    label: "Download check interval (seconds)",
    type: "int",
    envValue: () => String(getConfig().DOWNLOAD_CHECK_SECONDS),
    validate: validateInt(5, 3600),
  },
  AUTO_DOWNLOAD: {
    key: "AUTO_DOWNLOAD",
    label: "Auto-download new releases",
    type: "bool",
    envValue: () => String(getConfig().AUTO_DOWNLOAD),
    validate: validateBool,
  },
  AUTO_POSTERS: {
    key: "AUTO_POSTERS",
    label: "Auto-apply posters to new seasons",
    type: "bool",
    envValue: () => String(getConfig().AUTO_POSTERS),
    validate: validateBool,
  },
  AUTO_RECONCILE: {
    key: "AUTO_RECONCILE",
    label: "Auto-sync Plex metadata & thumbnails on source changes",
    type: "bool",
    envValue: () => String(getConfig().AUTO_RECONCILE),
    validate: validateBool,
  },
  PREFER_EXTENDED: {
    key: "PREFER_EXTENDED",
    label: "Prefer extended cuts over standard",
    type: "bool",
    envValue: () => String(getConfig().PREFER_EXTENDED),
    validate: validateBool,
  },
  PREFER_ARABASTA: {
    key: "PREFER_ARABASTA",
    label: "Prefer 'Arabasta' over 'Alabasta'",
    type: "bool",
    envValue: () => String(getConfig().PREFER_ARABASTA),
    validate: validateBool,
  },
  DISCORD_WEBHOOK_URL: {
    key: "DISCORD_WEBHOOK_URL",
    label: "Discord webhook URL (blank = off)",
    type: "url_or_empty",
    envValue: () => getConfig().DISCORD_WEBHOOK_URL ?? "",
    validate: validateDiscordWebhook,
  },
  NOTIFY_NEW_EPISODE: {
    key: "NOTIFY_NEW_EPISODE",
    label: "Notify: new episode detected",
    type: "bool",
    envValue: () => String(getConfig().NOTIFY_NEW_EPISODE),
    validate: validateBool,
  },
  NOTIFY_DOWNLOAD_COMPLETE: {
    key: "NOTIFY_DOWNLOAD_COMPLETE",
    label: "Notify: episode downloaded & imported",
    type: "bool",
    envValue: () => String(getConfig().NOTIFY_DOWNLOAD_COMPLETE),
    validate: validateBool,
  },
  NOTIFY_EPISODE_UPDATED: {
    key: "NOTIFY_EPISODE_UPDATED",
    label: "Notify: episode updated (re-release)",
    type: "bool",
    envValue: () => String(getConfig().NOTIFY_EPISODE_UPDATED),
    validate: validateBool,
  },
  NOTIFY_ERROR: {
    key: "NOTIFY_ERROR",
    label: "Notify: processing errors",
    type: "bool",
    envValue: () => String(getConfig().NOTIFY_ERROR),
    validate: validateBool,
  },
  NOTIFY_HEALTH: {
    key: "NOTIFY_HEALTH",
    label: "Notify: health alerts (service/disk problems)",
    type: "bool",
    envValue: () => String(getConfig().NOTIFY_HEALTH),
    validate: validateBool,
  },
  RSS_FEED_URL: {
    key: "RSS_FEED_URL",
    label: "RSS feed URL",
    type: "url",
    envValue: () => getConfig().RSS_FEED_URL,
    validate: validateUrl,
  },
  POSTER_REPO_RAW_BASE: {
    key: "POSTER_REPO_RAW_BASE",
    label: "Poster repo raw base URL",
    type: "url",
    envValue: () => getConfig().POSTER_REPO_RAW_BASE,
    validate: validateUrl,
  },
  ANIMETOSHO_API_KEY: {
    key: "ANIMETOSHO_API_KEY",
    label: "AnimeTosho API key (optional — increases rate limits)",
    type: "text",
    envValue: () => getConfig().ANIMETOSHO_API_KEY,
    validate: validateText,
  },
  ANIMETOSHO_BASE_URL: {
    key: "ANIMETOSHO_BASE_URL",
    label: "AnimeTosho base URL",
    type: "url",
    envValue: () => getConfig().ANIMETOSHO_BASE_URL,
    validate: validateUrl,
  },
  NYAA_BASE_URL: {
    key: "NYAA_BASE_URL",
    label: "Nyaa base URL",
    type: "url",
    envValue: () => getConfig().NYAA_BASE_URL,
    validate: validateUrl,
  },
  GOOGLE_SHEETS_API_KEY: {
    key: "GOOGLE_SHEETS_API_KEY",
    label: "Google Sheets API key (optional — reads the One Pace episode guide)",
    type: "text",
    envValue: () => getConfig().GOOGLE_SHEETS_API_KEY,
    validate: validateText,
  },
};

/** Effective value: DB override > env > default. Always a string. */
export function getSettingValue(key: SettingKey): string {
  const override = getSettingOverride(key);
  return override ?? DEFS[key].envValue();
}

export function getDownloadCheckMs(): number {
  return Number(getSettingValue("DOWNLOAD_CHECK_SECONDS")) * 1000;
}

export function getAutoDownload(): boolean {
  return getSettingValue("AUTO_DOWNLOAD") === "true";
}

export function getPollEnabled(): boolean {
  return getSettingValue("POLL_ENABLED") === "true";
}

export function getAutoPosters(): boolean {
  return getSettingValue("AUTO_POSTERS") === "true";
}

export function getAutoReconcile(): boolean {
  return getSettingValue("AUTO_RECONCILE") === "true";
}

export function getPreferExtended(): boolean {
  return getSettingValue("PREFER_EXTENDED") === "true";
}

export function getPreferArabasta(): boolean {
  return getSettingValue("PREFER_ARABASTA") === "true";
}

export function getGoogleSheetsApiKey(): string {
  return getSettingValue("GOOGLE_SHEETS_API_KEY");
}

export interface SettingView {
  key: SettingKey;
  label: string;
  type: SettingType;
  category: SettingCategory;
  value: string;
  envValue: string;
  overridden: boolean;
}

export function describeSettings(): SettingView[] {
  return (Object.keys(DEFS) as SettingKey[]).map((key) => {
    const override = getSettingOverride(key);
    const envValue = DEFS[key].envValue();
    return {
      key,
      label: DEFS[key].label,
      type: DEFS[key].type,
      category: CATEGORY[key],
      value: override ?? envValue,
      envValue,
      overridden: override !== null,
    };
  });
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

export function applySetting(key: string, raw: string): ApplyResult {
  const def = DEFS[key as SettingKey];
  if (!def) return { ok: false, message: `Unknown setting: ${key}` };

  const result = def.validate(raw);
  if (!result.ok) return { ok: false, message: result.error };

  setSettingOverride(def.key, result.value);
  settingsBus.emit("changed", { key: def.key, value: result.value });
  return { ok: true, message: `${def.label} updated` };
}

export function resetSetting(key: string): ApplyResult {
  const def = DEFS[key as SettingKey];
  if (!def) return { ok: false, message: `Unknown setting: ${key}` };

  deleteSettingOverride(def.key);
  settingsBus.emit("changed", { key: def.key, value: def.envValue() });
  return { ok: true, message: `${def.label} reset to env default` };
}
