import type { Publisher, PublishInput, PublishResult } from "./types";

/**
 * Not implemented — TikTok Content Posting API requires an approved
 * developer app and OAuth per user. Set TIKTOK_CLIENT_KEY once that
 * exists and implement the actual upload call before using this.
 */
export class TikTokPublisher implements Publisher {
  platform = "tiktok";

  constructor() {
    if (!process.env.TIKTOK_CLIENT_KEY) {
      throw new Error(
        "TikTokPublisher is not configured — set TIKTOK_CLIENT_KEY and implement the Content Posting API call",
      );
    }
  }

  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error("TikTokPublisher.publish is not implemented yet");
  }
}
