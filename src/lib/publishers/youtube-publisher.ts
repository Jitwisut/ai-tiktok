import type { Publisher, PublishInput, PublishResult } from "./types";

/**
 * Not implemented — YouTube Shorts publishing requires a Google Cloud
 * project with the YouTube Data API enabled and per-user OAuth consent.
 * Set YOUTUBE_CLIENT_ID once that exists and implement the upload call.
 */
export class YouTubePublisher implements Publisher {
  platform = "youtube";

  constructor() {
    if (!process.env.YOUTUBE_CLIENT_ID) {
      throw new Error(
        "YouTubePublisher is not configured — set YOUTUBE_CLIENT_ID and implement the Data API upload call",
      );
    }
  }

  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error("YouTubePublisher.publish is not implemented yet");
  }
}
