import type { VideoGenerateInput, VideoGenerateResult, VideoProvider } from "./types";

/**
 * Not implemented — wiring this up requires a Google Cloud project with
 * Vertex AI / Veo access, which this project doesn't have configured yet.
 * Swap VIDEO_PROVIDER=veo once credentials exist and fill in the API call.
 */
export class VeoProvider implements VideoProvider {
  name = "veo";

  constructor() {
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
      throw new Error(
        "VeoProvider is not configured yet — set GOOGLE_CLOUD_PROJECT and implement the Vertex AI call before using VIDEO_PROVIDER=veo",
      );
    }
  }

  async generate(_input: VideoGenerateInput): Promise<VideoGenerateResult> {
    throw new Error("VeoProvider.generate is not implemented yet");
  }
}
