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
  /** How the camera moves in this scene, continuing from the one before (newer scene plans only). */
  cameraMotion?: string;
}

/** Used when a scene plan has no camera directions: one continuous handheld move per part. */
const DEFAULT_CAMERA_MOTIONS = [
  "slow handheld push-in from a medium shot towards the person and the product",
  "smooth handheld arc around the subject that reveals the product from a new side",
  "gentle handheld pull-back to a medium shot that settles on the product",
];

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
    `Video quality: sharp focus, natural motion, no distorted hands or faces, no watermark or logo other than the product itself.`,
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
/** Short Thai overlay text written by the script step; either may be missing on older content. */
export interface OnScreenText {
  headline?: string;
  cta?: string;
}

/**
 * Veo writes whatever text it likes onto the frame — English titles, or
 * letters that only look Thai. Giving it the exact short Thai strings to show,
 * and forbidding anything else, is the most reliable way to get readable Thai.
 */
function onScreenTextRule(index: number, clipCount: number, text: OnScreenText | undefined): string {
  const lines: string[] = [];
  const isFirst = index === 0;
  const isLast = index === clipCount - 1;
  if (isFirst && text?.headline) lines.push(`at the start show the Thai headline 「${text.headline}」`);
  if (isLast && text?.cta) lines.push(`${lines.length ? "and " : ""}near the end show the Thai call to action 「${text.cta}」`);

  const shown = lines.length
    ? `On-screen text: ${lines.join(" ")}. Copy these Thai strings character for character, exactly as written between the 「」 marks, with every vowel and tone mark in the right place — do not translate, transliterate, reorder or add characters. Render it as a short static title card: large bold Thai sans-serif block letters, one line, centred, held still (no motion blur, no fast pan across it) against a plain high-contrast background for at least half the shot's length, so the letterforms stay sharp. Show no other on-screen text anywhere else in the frame.`
    : "On-screen text: none, unless it is in correct Thai.";
  return [
    shown,
    "Every caption, title, sign or label added to the video must be written in Thai script (ภาษาไทย) only — never English words, Latin letters, or made-up or garbled characters that merely look like Thai.",
    lines.length
      ? "If you cannot render this exact Thai text sharply and correctly, show no on-screen text at all for this part rather than distorted, misspelled, blurry or reordered Thai characters — incorrect Thai text is worse than no text."
      : "",
    "The product's own packaging keeps its real design, colours and logo exactly as in the product photo. Do not attempt to render small or dense printed text on the packaging as sharp legible Thai — keep any large, simple text on the packaging as it appears in the photo, and let the rest read as natural product-photography detail rather than invented legible characters.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function planClips(
  productName: string,
  scenes: ScenePromptInput[],
  settings: VideoSettings,
  targetDuration: number,
  variant?: PlanVariant,
  text?: OnScreenText,
  styleOverride?: string,
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

    const built = buildVeoPrompt(productName, scaled, {
      ...settings,
      duration: CLIP_SECONDS,
      style: styleOverride || settings.style,
    });

    // Each clip is rendered by a separate call that sees only its own prompt,
    // so the joins only look seamless when every part says, in the same
    // structure, what happens next, what must carry over from the part
    // before, and how the camera keeps moving. Asking only for sameness
    // produces near-copies of the same shot, so the action is spelled out first.
    const isFirst = index === 0;
    const isLast = index === clipCount - 1;
    const actions = slice.map((scene) => scene.description.trim().replace(/[.。]$/, "")).join(", then ");
    const motions = slice.map((scene) => scene.cameraMotion?.trim()).filter(Boolean).join(", then ");
    const motion = motions || DEFAULT_CAMERA_MOTIONS[Math.min(index, DEFAULT_CAMERA_MOTIONS.length - 1)];
    const look = `${settings.lighting}, the same colour grade and a ${settings.style} ${settings.camera} look`;

    const story: string[] = [];
    if (clipCount > 1) {
      story.push(`This is part ${index + 1} of ${clipCount} of ONE continuous ${clipCount * CLIP_SECONDS}-second advert that will be joined into a single video.`);

      const alreadyShown = scenes
        .slice(0, first)
        .map((scene) => scene.description)
        .join(" / ");
      story.push(
        `[Action/Change] ${isFirst ? "Open the advert with" : "Next,"} ${actions}.` +
          (alreadyShown ? ` Earlier parts already showed: ${alreadyShown} — move the story forward, do not repeat those actions.` : "") +
          (isLast ? " This is the final part: end on the product looking appealing." : " End this part mid-motion on a clear, steady frame that the next part can continue from."),
      );

      story.push(
        isFirst
          ? `[Continuity Reinforcement] Establish the look every later part must keep: the same person (face, hair, body), wardrobe, location, product, ${look}.`
          : `[Continuity Reinforcement] Continue seamlessly from the final frame of part ${index}: identical person (face, hair, body), wardrobe, location, product placement, ${look}, and the same time of day and light direction. No jump cut, no new outfit, no new room.`,
      );

      story.push(
        isFirst
          ? `[Camera Motion] ${motion}; keep the movement smooth so it can carry on in the next part.`
          : `[Camera Motion] Pick up the camera movement exactly where part ${index} ended — same direction, speed and height — then ${motion}. No sudden cut or reframe at the start.`,
      );
    } else {
      story.push(`This is one complete ${CLIP_SECONDS}-second advert with a hook, the product and a clear ending.`);
      story.push(`[Action/Change] ${actions}.`);
      story.push(`[Camera Motion] ${motion}.`);
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
      prompt: `${built.text}\n${story.join("\n")}\n${onScreenTextRule(index, clipCount, text)}`,
      startSecond: index * CLIP_SECONDS,
    };
  });
}
