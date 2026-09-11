import type { Publisher, PublishInput, PublishResult } from "./types";

/**
 * Not implemented — Instagram Reels publishing requires a Meta app,
 * a connected Instagram Business account, and long-lived page tokens.
 * Set META_APP_ID once that exists and implement the Graph API call.
 */
export class InstagramPublisher implements Publisher {
  platform = "instagram";

  constructor() {
    if (!process.env.META_APP_ID) {
      throw new Error(
        "InstagramPublisher is not configured — set META_APP_ID and implement the Graph API call",
      );
    }
  }

  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error("InstagramPublisher.publish is not implemented yet");
  }
}
