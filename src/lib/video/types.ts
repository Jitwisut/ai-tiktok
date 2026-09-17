export interface VideoGenerateInput {
  prompt: string;
  /** What the model should not render; providers without such a field ignore it. */
  negativePrompt?: string;
  aspectRatio: string;
  duration: number;
}

export interface VideoGenerateResult {
  videoUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
}

/**
 * A provider owns its own completion wait internally (polling a remote job,
 * or simulating one) — the caller just awaits the final result. Swapping
 * Mock for Veo/Kling/Runway means implementing this one method.
 */
export interface VideoProvider {
  name: string;
  generate(input: VideoGenerateInput): Promise<VideoGenerateResult>;
}
