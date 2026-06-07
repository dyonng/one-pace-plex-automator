import { EventEmitter } from "events";
import cron from "node-cron";
import { getConfig } from "./config";
import { getSettingOverride, setSettingOverride, deleteSettingOverride } from "./db";

export type SettingKey =
  | "POLL_CRON"
  | "DOWNLOAD_CHECK_SECONDS"
  | "AUTO_DOWNLOAD"
  | "DISCORD_WEBHOOK_URL"
  | "RSS_FEED_URL";
export type SettingType = "cron" | "int" | "bool" | "url" | "url_or_empty";

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

function validateUrlOrEmpty(raw: string): ValidateResult {
  if (raw.trim() === "") return { ok: true, value: "" };
  return validateUrl(raw);
}

function validateBool(raw: string): ValidateResult {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "false") return { ok: true, value: v };
  return { ok: false, error: "Must be true or false" };
}

const DEFS: Record<SettingKey, SettingDef> = {
  POLL_CRON: {
    key: "POLL_CRON",
    label: "RSS poll schedule (cron)",
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
  DISCORD_WEBHOOK_URL: {
    key: "DISCORD_WEBHOOK_URL",
    label: "Discord webhook URL (blank = off)",
    type: "url_or_empty",
    envValue: () => getConfig().DISCORD_WEBHOOK_URL ?? "",
    validate: validateUrlOrEmpty,
  },
  RSS_FEED_URL: {
    key: "RSS_FEED_URL",
    label: "RSS feed URL",
    type: "url",
    envValue: () => getConfig().RSS_FEED_URL,
    validate: validateUrl,
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

export interface SettingView {
  key: SettingKey;
  label: string;
  type: SettingType;
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
