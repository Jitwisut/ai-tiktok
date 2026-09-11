import type { VideoProvider } from "./types";
import { MockVideoProvider } from "./mock-provider";
import { VeoProvider } from "./veo-provider";

export type { VideoProvider, VideoGenerateInput, VideoGenerateResult } from "./types";

export function getVideoProvider(): VideoProvider {
  const provider = process.env.VIDEO_PROVIDER ?? "mock";

  switch (provider) {
    case "veo":
      return new VeoProvider();
    case "mock":
      return new MockVideoProvider();
    default:
      throw new Error(`Unknown VIDEO_PROVIDER: ${provider}`);
  }
}
