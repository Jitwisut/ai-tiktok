import type { VideoGenerateInput, VideoGenerateResult, VideoProvider } from "./types";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function placeholderThumbnail(aspectRatio: string): string {
  const [w, h] = aspectRatio === "16:9" ? [320, 180] : aspectRatio === "1:1" ? [320, 320] : [180, 320];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="50%" fill="#9ca3af" font-family="sans-serif" font-size="14" text-anchor="middle">Mock video</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Simulates provider latency and returns a placeholder — no real video file. */
export class MockVideoProvider implements VideoProvider {
  name = "mock";

  async generate(input: VideoGenerateInput): Promise<VideoGenerateResult> {
    const delayMs = Number(process.env.MOCK_VIDEO_DELAY_MS ?? 4000);
    await delay(delayMs);

    if (process.env.MOCK_VIDEO_FORCE_FAIL === "true") {
      throw new Error("Mock provider forced failure (MOCK_VIDEO_FORCE_FAIL=true)");
    }

    return {
      videoUrl: null,
      thumbnailUrl: placeholderThumbnail(input.aspectRatio),
      duration: input.duration,
    };
  }
}
