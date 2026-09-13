/** Ported from src/lib/prompt-engine/{types,prompt-builder,clip-planner}.ts — pure functions, no server dependency. */

export interface VideoSettings {
  duration: number;
  aspectRatio: string;
  style: string;
  camera: string;
  lighting: string;
  language: string;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  duration: 8,
  aspectRatio: "9:16",
  style: "UGC",
  camera: "handheld smartphone",
  lighting: "natural daylight",
  language: "Thai",
};

export interface ScenePromptInput {
  position: number;
  duration: number;
  description: string;
}

export interface VeoPromptStructured {
  style: string;
  aspectRatio: string;
  duration: number;
  camera: string;
  lighting: string;
  language: string;
  product: string;
  scenes: { start: number; end: number; action: string }[];
}

export interface BuiltVeoPrompt {
  structured: VeoPromptStructured;
  text: string;
}

/** Deterministic template — turns a scene plan + video settings into a text prompt for the video provider. */
export function buildVeoPrompt(
  productName: string,
  scenes: ScenePromptInput[],
  settings: VideoSettings,
): BuiltVeoPrompt {
  let cursor = 0;
  const timedScenes = scenes.map((scene) => {
    const start = cursor;
    const end = cursor + scene.duration;
    cursor = end;
    return { start, end, action: scene.description };
  });

  const structured: VeoPromptStructured = {
    style: settings.style,
    aspectRatio: settings.aspectRatio,
    duration: settings.duration,
    camera: settings.camera,
    lighting: settings.lighting,
    language: settings.language,
    product: productName,
    scenes: timedScenes,
  };

  const text = [
    `${settings.style}-style short vertical video (${settings.aspectRatio}), ${settings.duration}s total.`,
    `Camera: ${settings.camera}. Lighting: ${settings.lighting}. Spoken language: ${settings.language}.`,
    `Product featured: ${productName}.`,
    "Shot list:",
    ...timedScenes.map((s) => `[${s.start}-${s.end}s] ${s.action}`),
  ].join("\n");

  return { structured, text };
}

/** Veo renders at most 8 seconds per generation. */
export const CLIP_SECONDS = 8;

export const SUPPORTED_TARGET_DURATIONS = [8, 16, 24, 32] as const;

/** Which run this is when the same content is generated several times in a row. */
export interface PlanVariant {
  index: number;
  total: number;
}
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
  variant?: PlanVariant,
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
    const story =
      clipCount > 1
        ? [
            `This is part ${index + 1} of ${clipCount} of one continuous ${clipCount * CLIP_SECONDS}-second advert.`,
            "Keep identical across parts: the same person, wardrobe, room, product and colour grade.",
            "Change in every part: the action, the camera angle and the framing.",
          ]
        : [`This is one complete ${CLIP_SECONDS}-second advert with a hook, the product and a clear ending.`];

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

    // Repeated runs of the same content would otherwise come back as
    // near-identical videos, which is useless for posting several.
    if (variant && variant.total > 1) {
      story.push(
        `This is version ${variant.index + 1} of ${variant.total} of this advert: make it clearly different from the other versions — a different person, setting, opening action and camera angle — while keeping the same product and message.`,
      );
    }

    return {
      index,
      prompt: `${built.text}\n${story.join(" ")}`,
      startSecond: index * CLIP_SECONDS,
    };
  });
}
