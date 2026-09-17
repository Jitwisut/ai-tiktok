import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { VideoGenerateInput, VideoGenerateResult, VideoProvider } from "./types";

const DEFAULT_MODEL = "veo-3.1-generate-preview";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const SUPPORTED_DURATIONS = new Set([4, 6, 8]);
const SUPPORTED_ASPECT_RATIOS = new Set(["9:16", "16:9"]);

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function operationErrorMessage(error: Record<string, unknown> | undefined): string {
  if (!error) return "Veo generation failed without an error payload";

  const message = error.message;
  if (typeof message === "string" && message.length > 0) return message;

  try {
    return `Veo generation failed: ${JSON.stringify(error)}`;
  } catch {
    return "Veo generation failed";
  }
}

/**
 * Generates a real MP4 with Veo through the Gemini Developer API, then
 * downloads it into Next.js' public directory so the local app can preview
 * and download the file without depending on Google's temporary video URL.
 */
export class VeoProvider implements VideoProvider {
  name = "veo";

  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("VeoProvider requires GEMINI_API_KEY");
    }

    this.client = new GoogleGenAI({ apiKey });
    this.model = process.env.VIDEO_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: VideoGenerateInput): Promise<VideoGenerateResult> {
    if (!SUPPORTED_ASPECT_RATIOS.has(input.aspectRatio)) {
      throw new Error(
        `Unsupported Veo aspect ratio: ${input.aspectRatio}. Use 9:16 or 16:9.`,
      );
    }

    if (!SUPPORTED_DURATIONS.has(input.duration)) {
      throw new Error(
        `Unsupported Veo duration: ${input.duration}s. Use 4, 6, or 8 seconds.`,
      );
    }

    let operation = await this.client.models.generateVideos({
      model: this.model,
      prompt: input.prompt,
      config: {
        numberOfVideos: 1,
        aspectRatio: input.aspectRatio,
        durationSeconds: input.duration,
        resolution: process.env.VIDEO_RESOLUTION ?? "720p",
        negativePrompt: input.negativePrompt,
      },
    });

    const pollIntervalMs = envNumber("VIDEO_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = envNumber("VIDEO_GENERATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    while (!operation.done) {
      if (Date.now() >= deadline) {
        throw new Error(`Veo generation timed out after ${Math.round(timeoutMs / 1000)}s`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      operation = await this.client.operations.getVideosOperation({ operation });
    }

    if (operation.error) {
      throw new Error(operationErrorMessage(operation.error));
    }

    const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
    if (!generatedVideo) {
      throw new Error("Veo completed but returned no generated video");
    }

    const outputDirectory = path.join(process.cwd(), "public", "generated-videos");
    await mkdir(outputDirectory, { recursive: true });

    const filename = `${randomUUID()}.mp4`;
    const outputPath = path.join(outputDirectory, filename);

    await this.client.files.download({
      file: generatedVideo,
      downloadPath: outputPath,
    });

    return {
      videoUrl: `/generated-videos/${filename}`,
      thumbnailUrl: null,
      duration: input.duration,
    };
  }
}
