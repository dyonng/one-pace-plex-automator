import axios from "axios";
import { getConfig } from "./config";
import { logger } from "./logger";

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

function buildEmbed(n: DiscordNotification) {
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

export async function sendDiscordNotification(n: DiscordNotification): Promise<void> {
  const { DISCORD_WEBHOOK_URL } = getConfig();
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { embeds: [buildEmbed(n)] }, { timeout: 10_000 });
  } catch (err) {
    logger.warn("Discord notification failed", { error: (err as Error).message });
  }
}
