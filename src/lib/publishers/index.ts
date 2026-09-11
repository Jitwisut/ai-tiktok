import type { Publisher } from "./types";
import { MockPublisher } from "./mock-publisher";
import { TikTokPublisher } from "./tiktok-publisher";
import { InstagramPublisher } from "./instagram-publisher";
import { YouTubePublisher } from "./youtube-publisher";

export type { Publisher, PublishInput, PublishResult } from "./types";

export const SUPPORTED_PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Falls back to MockPublisher per-platform when that platform's credentials aren't configured. */
export function getPublisher(platform: string): Publisher {
  switch (platform) {
    case "tiktok":
      return process.env.TIKTOK_CLIENT_KEY ? new TikTokPublisher() : new MockPublisher("tiktok");
    case "instagram":
      return process.env.META_APP_ID ? new InstagramPublisher() : new MockPublisher("instagram");
    case "youtube":
      return process.env.YOUTUBE_CLIENT_ID
        ? new YouTubePublisher()
        : new MockPublisher("youtube");
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}
