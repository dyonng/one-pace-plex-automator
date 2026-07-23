import axios from "axios";
import { logger } from "./logger";
import { getSettingValue, type SettingKey } from "./settings";

export interface DiscordNotification {
  type: "new_episode" | "download_complete" | "episode_updated" | "error";
  crc32: string;
  arcTitle?: string;
  arcPart?: number;
  episodeNum?: number;
  episodeTitle?: string;
  filename?: string;
  replacedFilenames?: string[];
  changelog?: string[];
  error?: string;
}

export function buildEmbed(n: DiscordNotification) {
  const season = n.arcPart != null ? `S${String(n.arcPart).padStart(2, "0")}` : "";
  const ep = n.episodeNum != null ? `E${String(n.episodeNum).padStart(2, "0")}` : "";

  if (n.type === "new_episode") {
    return {
      title: `New One Pace Episode Detected`,
      description: `**${n.arcTitle ?? "Unknown Arc"}** ${season}${ep}${n.episodeTitle ? ` — ${n.episodeTitle}` : ""}`,
      color: 0x3498db,
      fields: [{ name: "CRC32", value: n.crc32, inline: true }],
      timestamp: new Date().toISOString(),
    };
  }

  if (n.type === "download_complete") {
    return {
      title: `Download Complete`,
      description: `**${n.arcTitle ?? "Unknown Arc"}** ${season}${ep}${n.episodeTitle ? ` — ${n.episodeTitle}` : ""}`,
      color: 0x2ecc71,
      fields: [
        { name: "File", value: n.filename ?? n.crc32, inline: false },
        { name: "CRC32", value: n.crc32, inline: true },
      ],
      timestamp: new Date().toISOString(),
    };
  }

  if (n.type === "episode_updated") {
    const fields = [
      { name: "New File", value: n.filename ?? n.crc32, inline: false },
      { name: "CRC32", value: n.crc32, inline: true },
    ];
    if (n.changelog?.length) {
      fields.push({ name: "Changelog", value: n.changelog.map((c) => `• ${c}`).join("\n"), inline: false });
    }
    if (n.replacedFilenames?.length) {
      fields.push({ name: "Replaced", value: n.replacedFilenames.join("\n"), inline: false });
    }
    return {
      title: `Episode Updated`,
      description: `**${n.arcTitle ?? "Unknown Arc"}** ${season}${ep}${n.episodeTitle ? ` — ${n.episodeTitle}` : ""}`,
      color: 0xf39c12,
      fields,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    title: `One Pace Automator Error`,
    description: n.error ?? "An unknown error occurred",
    color: 0xe74c3c,
    fields: [{ name: "CRC32", value: n.crc32, inline: true }],
    timestamp: new Date().toISOString(),
  };
}

// Which per-type toggle gates each notification. All default on; a disabled
// toggle drops that event before any HTTP call.
const TYPE_SETTING: Record<DiscordNotification["type"], SettingKey> = {
  new_episode: "NOTIFY_NEW_EPISODE",
  download_complete: "NOTIFY_DOWNLOAD_COMPLETE",
  episode_updated: "NOTIFY_EPISODE_UPDATED",
  error: "NOTIFY_ERROR",
};

export async function sendDiscordNotification(n: DiscordNotification): Promise<void> {
  const DISCORD_WEBHOOK_URL = getSettingValue("DISCORD_WEBHOOK_URL");
  if (!DISCORD_WEBHOOK_URL) return;
  if (getSettingValue(TYPE_SETTING[n.type]) !== "true") return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { embeds: [buildEmbed(n)] }, { timeout: 10_000 });
  } catch (err) {
    logger.warn("Discord notification failed", { error: (err as Error).message });
  }
}

// Health alerts carry no CRC32, so they get their own payload/embed rather than
// riding on DiscordNotification. Status "ok" means "recovered".
export interface HealthAlert {
  status: "ok" | "warn" | "error";
  lines: string[]; // failing checks/disks; empty on recovery
}

export function buildHealthEmbed(a: HealthAlert) {
  if (a.status === "ok") {
    return {
      title: "✅ Health Recovered",
      description: "All systems are back to normal.",
      color: 0x2ecc71,
      timestamp: new Date().toISOString(),
    };
  }
  const isError = a.status === "error";
  return {
    title: isError ? "🔴 Health Alert — Error" : "🟡 Health Alert — Warning",
    description: a.lines.length ? a.lines.map((l) => `• ${l}`).join("\n") : "A health check is failing.",
    color: isError ? 0xe74c3c : 0xf39c12,
    timestamp: new Date().toISOString(),
  };
}

export async function sendDiscordHealthAlert(a: HealthAlert): Promise<void> {
  const DISCORD_WEBHOOK_URL = getSettingValue("DISCORD_WEBHOOK_URL");
  if (!DISCORD_WEBHOOK_URL) return;
  if (getSettingValue("NOTIFY_HEALTH") !== "true") return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { embeds: [buildHealthEmbed(a)] }, { timeout: 10_000 });
  } catch (err) {
    logger.warn("Discord health alert failed", { error: (err as Error).message });
  }
}

/**
 * Posts a test embed to the configured webhook. Unlike `sendDiscordNotification`,
 * this surfaces the outcome so the dashboard can show success/failure.
 */
export async function sendDiscordTest(): Promise<{ ok: boolean; message: string }> {
  const url = getSettingValue("DISCORD_WEBHOOK_URL");
  if (!url) return { ok: false, message: "No Discord webhook configured" };

  try {
    await axios.post(
      url,
      {
        embeds: [
          {
            title: "One Pace Automator — Test",
            description: "✅ Your Discord webhook is working.",
            color: 0x2ecc71,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      { timeout: 10_000 }
    );
    return { ok: true, message: "Test message sent to Discord" };
  } catch (err) {
    const e = err as { response?: { status?: number }; message?: string };
    const detail = e.response?.status ? `HTTP ${e.response.status}` : (e.message ?? "request failed");
    logger.warn("Discord test failed", { error: detail });
    return { ok: false, message: `Discord test failed: ${detail}` };
  }
}
