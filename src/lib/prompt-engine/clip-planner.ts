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

    // Each clip is rendered by a separate call that sees only its own prompt,
    // so the story has to be restated every time or the cuts read as
    // unrelated videos. Separating what must stay identical from what must
    // change matters: instructions that only ask for sameness produce three
    // near-copies of the same shot.
    const story = [
      `This is part ${index + 1} of ${clipCount} of one continuous ${clipCount * CLIP_SECONDS}-second advert.`,
      "Keep identical across parts: the same person, wardrobe, room, product and colour grade.",
      "Change in every part: the action, the camera angle and the framing.",
    ];

    if (index > 0) {
      const alreadyShown = scenes
        .slice(0, first)
        .map((scene) => scene.description)
        .join(" / ");
      if (alreadyShown) {
        story.push(`Earlier parts already showed: ${alreadyShown}. Do not repeat any of that.`);
      }
      story.push(
        "Pick up where the previous part left off and move the story forward with the new action above.",
      );
    }

    if (index === clipCount - 1 && clipCount > 1) {
      story.push("This is the final part — end on the product looking appealing.");
    }

    return {
      index,
      prompt: `${built.text}\n${story.join(" ")}`,
      startSecond: index * CLIP_SECONDS,
    };
  });
}
