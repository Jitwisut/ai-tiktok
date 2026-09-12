import { buildVeoPrompt } from "./prompt-builder";
import type { ScenePromptInput, VideoSettings } from "./types";

/** Veo renders at most 8 seconds per generation. */
export const CLIP_SECONDS = 8;

export const SUPPORTED_TARGET_DURATIONS = [8, 16, 24, 32] as const;
export type TargetDuration = (typeof SUPPORTED_TARGET_DURATIONS)[number];

export interface PlannedClip {
  index: number;
  prompt: string;
  startSecond: number;
}

/**
 * Splits a scene plan across the clips needed to reach targetDuration.
 * Scenes are handed out in order and stretched or repeated as needed, so a
 * plan written for 8 seconds still produces a sensible 24-second video
 * without forcing the user to re-plan scenes for every length.
 */
export function planClips(
  productName: string,
  scenes: ScenePromptInput[],
  settings: VideoSettings,
  targetDuration: number,
): PlannedClip[] {
  const clipCount = Math.max(1, Math.round(targetDuration / CLIP_SECONDS));
  if (scenes.length === 0) return [];

  return Array.from({ length: clipCount }, (_, index) => {
    const first = Math.floor((index * scenes.length) / clipCount);
    const last = Math.max(first, Math.floor(((index + 1) * scenes.length) / clipCount) - 1);
    const slice = scenes.slice(first, last + 1);

    // Rescale the slice to fill this clip so the shot list timings Veo sees
    // are relative to the clip it is actually rendering.
    const sliceTotal = slice.reduce((sum, scene) => sum + scene.duration, 0) || 1;
    const scaled = slice.map((scene) => ({
      ...scene,
      duration: Math.max(1, Math.round((scene.duration / sliceTotal) * CLIP_SECONDS)),
    }));

    const built = buildVeoPrompt(productName, scaled, { ...settings, duration: CLIP_SECONDS });
    const continuation =
      index === 0
        ? ""
        : "\nContinue seamlessly from the provided start frame, same set, same lighting, same product.";

    return {
      index,
      prompt: `${built.text}${continuation}`,
      startSecond: index * CLIP_SECONDS,
    };
  });
}
