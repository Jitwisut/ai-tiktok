import { buildVeoPrompt } from "./prompt-builder";
import type { ScenePromptInput, VideoSettings } from "./types";

/** Veo renders at most 8 seconds per generation. */
export const CLIP_SECONDS = 8;

export const MAX_CLIPS = 4;
export const SUPPORTED_TARGET_DURATIONS = [8, 16, 24, 32] as const;
export type TargetDuration = (typeof SUPPORTED_TARGET_DURATIONS)[number];

export interface PlanVariant {
  index: number;
  total: number;
}

export interface OnScreenText {
  headline?: string;
  cta?: string;
}

export interface PlannedClip {
  index: number;
  prompt: string;
  startSecond: number;
}

export interface PlanClipsInput {
  productName: string;
  scenes: ScenePromptInput[];
  settings: VideoSettings;
  targetDuration: number;
  variant?: PlanVariant;
  text?: OnScreenText;
}

interface ClipGroup {
  scenes: ScenePromptInput[];
  first: number;
}

function clipCountFor(targetDuration: number): number {
  return Math.min(MAX_CLIPS, Math.max(1, Math.ceil(targetDuration / CLIP_SECONDS)));
}

function visualOf(scene: ScenePromptInput): string {
  return (scene.visual?.trim() || scene.description.trim()).replace(/[.。]$/, "");
}

/** Prefer the explicit clip assignment from the storyboard, then support old flat scene plans. */
function groupScenes(scenes: ScenePromptInput[], clipCount: number): ClipGroup[] {
  const hasAssignments = scenes.every((scene) => Number.isInteger(scene.clip));
  if (hasAssignments) {
    const groups = Array.from({ length: clipCount }, () => [] as ScenePromptInput[]);
    const fits = scenes.every((scene) => {
      const clip = scene.clip as number;
      if (clip < 0 || clip >= clipCount) return false;
      groups[clip].push(scene);
      return true;
    });
    if (fits && groups.every((group) => group.length > 0)) {
      return groups.map((group) => ({ scenes: group, first: scenes.indexOf(group[0]) }));
    }
  }

  if (scenes.length >= clipCount) {
    return Array.from({ length: clipCount }, (_, index) => {
      const first = Math.floor((index * scenes.length) / clipCount);
      const last = Math.max(first, Math.floor(((index + 1) * scenes.length) / clipCount) - 1);
      return { scenes: scenes.slice(first, last + 1), first };
    });
  }

  // A short legacy plan may have fewer scenes than clips. Repeat the beat as a
  // continuation rather than pretending it is a new product action.
  return Array.from({ length: clipCount }, (_, index) => {
    const first = Math.min(scenes.length - 1, Math.floor((index * scenes.length) / clipCount));
    return { scenes: [scenes[first]], first };
  });
}

/**
 * Turns one storyboard into self-contained prompts for the separate Veo
 * generations. Exact Thai dialogue/text is intentionally passed to every
 * relevant clip instead of being reconstructed by the video model.
 */
export function planClips(input: PlanClipsInput): PlannedClip[] {
  const { productName, scenes, settings, targetDuration, text, variant } = input;
  if (scenes.length === 0) return [];

  const clipCount = clipCountFor(targetDuration);
  const groups = groupScenes(scenes, clipCount);
  // Shared across parts: a scene repeated as a continuation (or a line the
  // storyboard put in two clips) is spoken only in the first part that has it.
  const spoken = new Set<string>();

  return groups.map((group, index) => {
    const isFirst = index === 0;
    const isLast = index === clipCount - 1;
    const built = buildVeoPrompt(productName, group.scenes, {
      ...settings,
      duration: CLIP_SECONDS,
      onScreenText: isFirst ? text?.headline ?? settings.onScreenText : undefined,
      onScreenCta: isLast ? text?.cta ?? settings.onScreenCta : undefined,
    }, spoken, clipCount > 1);

    const earlier = scenes.slice(0, group.first).map(visualOf).filter(Boolean).join(" / ");
    const story = [
      `[CONTINUITY] This is part ${index + 1} of ${clipCount} of one continuous ${clipCount * CLIP_SECONDS}-second advert.`,
      "Keep the same person, wardrobe, location, product identity, light direction and colour grade across every part.",
      index === 0
        ? "Establish the cast and setting clearly for later parts."
        : `Open on a calm, steady medium shot that continues naturally from the end of part ${index}. Move the story forward with a new action; do not repeat an earlier shot or re-speak earlier lines.${earlier ? ` Earlier actions were: ${earlier}.` : ""}`,
      isLast ? "This is the final part: finish on an appealing, steady product frame." : "End on a clear frame or motion that the next part can continue from.",
    ];

    if (variant && variant.total > 1) {
      story.push(
        `[VARIATION] Version ${variant.index + 1} of ${variant.total}: make the framing, camera angle and performance noticeably different from other versions while keeping the same product facts and message.`,
      );
    }

    return {
      index,
      prompt: `${built.text}\n${story.join(" ")}`,
      startSecond: index * CLIP_SECONDS,
    };
  });
}
