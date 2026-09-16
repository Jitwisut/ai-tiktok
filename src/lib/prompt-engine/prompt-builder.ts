import { styleVideoDirection } from "./style-playbooks";
import type { ScenePromptInput, VideoSettings } from "./types";

export interface TimedScenePrompt {
  start: number;
  end: number;
  action: string;
  visual?: string;
  cameraMotion?: string;
  dialogue?: string;
  voiceover?: string;
}

export interface VeoPromptStructured {
  style: string;
  aspectRatio: string;
  duration: number;
  camera: string;
  lighting: string;
  language: string;
  product: string;
  onScreenText?: string;
  onScreenCta?: string;
  scenes: TimedScenePrompt[];
}

export interface BuiltVeoPrompt {
  structured: VeoPromptStructured;
  text: string;
}

interface TimedScene {
  start: number;
  end: number;
  scene: ScenePromptInput;
}

/** "9:16 portrait vertical" vs "16:9 landscape horizontal". */
export function describeAspectRatio(aspectRatio: string): string {
  const [width, height] = aspectRatio.split(":").map(Number);
  if (width && height && width > height) return `${aspectRatio} landscape (horizontal)`;
  if (width && height && width === height) return `${aspectRatio} square`;
  return `${aspectRatio} portrait (vertical)`;
}

function quoteExact(value: string): string {
  // JSON.stringify gives standard ASCII double quotes and safely escapes any
  // accidental quote/newline in manually edited legacy content.
  return JSON.stringify(value.trim());
}

function visualOf(scene: ScenePromptInput): string {
  return (scene.visual?.trim() || scene.description.trim()).replace(/[.。]$/, "");
}

/** Rescales a scene plan so the provider sees a coherent timeline for its render length. */
function timeline(scenes: ScenePromptInput[], duration: number): TimedScene[] {
  const total = scenes.reduce((sum, scene) => sum + Math.max(0, scene.duration), 0);
  let running = 0;
  let previousEnd = 0;

  return scenes.map((scene, index) => {
    running += total > 0 ? Math.max(0, scene.duration) : 1;
    const share = running / (total > 0 ? total : scenes.length);
    const end = index === scenes.length - 1 ? duration : Math.round(share * duration * 2) / 2;
    const start = previousEnd;
    previousEnd = end;
    return { start, end, scene };
  });
}

function onScreenTextRule(settings: VideoSettings): string {
  const requested: string[] = [];
  if (settings.onScreenText) requested.push(`at the start show the Thai headline ${quoteExact(settings.onScreenText)}`);
  if (settings.onScreenCta) requested.push(`near the end show the Thai call to action ${quoteExact(settings.onScreenCta)}`);

  const packaging =
    "Keep the product's real packaging, logo and colours from the reference image; dense printed packaging text may remain soft product-photography detail and must not be invented as readable text.";

  if (!requested.length) {
    return `[ON-SCREEN TEXT] None. Add no captions, subtitles, titles, stickers or labels anywhere in the frame. ${packaging}`;
  }

  return [
    `[ON-SCREEN TEXT] ${requested.join(" and ")}.`,
    "The on-screen text language is Thai, regardless of the language used in this prompt or the spoken language.",
    "Copy every requested string character for character exactly as written between the standard double quotation marks, including every Thai vowel and tone mark. Do not translate, transliterate, reorder, shorten, autocorrect or add characters.",
    "Render each requested string as a short static title card in large, sharp, high-contrast Thai sans-serif letters. Hold it still long enough to read; do not put it over a fast camera move.",
    "Show no other on-screen text, English words or garbled characters. If exact Thai spelling cannot be rendered sharply, show no synthetic text instead of incorrect Thai.",
    packaging,
  ].join(" ");
}

function speechInstructions(beats: TimedScene[]): string {
  const lines: string[] = [];
  for (const { start, end, scene } of beats) {
    const dialogue = scene.dialogue?.trim();
    if (dialogue) {
      lines.push(`[${start}-${end}s] The visible person says exactly in Thai: ${quoteExact(dialogue)}`);
    }
    const voiceover = scene.voiceover?.trim();
    if (voiceover) {
      lines.push(`[${start}-${end}s] An off-screen narrator says exactly in Thai: ${quoteExact(voiceover)}`);
    }
  }

  if (!lines.length) {
    return "[AUDIO] No dialogue and no voiceover. Nobody speaks. Use natural ambient sound and low background music only.";
  }

  return [
    `[DIALOGUE / VOICEOVER] ${lines.join(" ")}.`,
    "Every quoted line above is the complete spoken script for this video. Speak it exactly as written with natural Thai pronunciation and conversational pacing. Do not translate, paraphrase, shorten or add any spoken words.",
    "When a dialogue line is used, keep the speaker's face visible and lip-synced while speaking; avoid fast head turns during the line.",
    "Keep background music low under the voice and preserve natural room ambience.",
  ].join(" ");
}

/**
 * Deterministic template that preserves scene visuals, exact spoken Thai, and
 * exact requested on-screen Thai all the way to the video provider.
 */
export function buildVeoPrompt(
  productName: string,
  scenes: ScenePromptInput[],
  settings: VideoSettings,
): BuiltVeoPrompt {
  const beats = timeline(scenes, settings.duration);
  const timedScenes: TimedScenePrompt[] = beats.map(({ start, end, scene }) => ({
    start,
    end,
    action: visualOf(scene),
    visual: scene.visual?.trim() || undefined,
    cameraMotion: scene.cameraMotion?.trim() || undefined,
    dialogue: scene.dialogue?.trim() || undefined,
    voiceover: scene.voiceover?.trim() || undefined,
  }));

  const timelineText = beats
    .map(({ start, end, scene }) => {
      const motion = scene.cameraMotion?.trim() ? ` Camera: ${scene.cameraMotion.trim()}.` : "";
      return `[${start}-${end}s] ${visualOf(scene)}.${motion}`;
    })
    .join(" ");

  const structured: VeoPromptStructured = {
    style: settings.style,
    aspectRatio: settings.aspectRatio,
    duration: settings.duration,
    camera: settings.camera,
    lighting: settings.lighting,
    language: settings.language,
    product: productName,
    onScreenText: settings.onScreenText,
    onScreenCta: settings.onScreenCta,
    scenes: timedScenes,
  };

  const text = [
    `[GOAL] Create exactly one ${settings.duration}-second ${settings.style}-style TikTok affiliate video that fills the full duration from start to finish.`,
    `[FORMAT] ${describeAspectRatio(settings.aspectRatio)} video. Camera: ${settings.camera}. Lighting: ${settings.lighting}.`,
    `[STYLE EXECUTION] ${styleVideoDirection(settings.style)}`,
    `[PRODUCT] Feature exactly one real product: ${productName}. Preserve its shape, colour, material and branding from the product reference; never replace it with a generic or similar item.`,
    `[LANGUAGE] Spoken language: ${settings.language}. Any provided Thai dialogue or voiceover must be spoken exactly in Thai.`,
    `[TIMELINE] ${timelineText}`,
    speechInstructions(beats),
    onScreenTextRule(settings),
    "[CONTINUITY] Keep one consistent person, wardrobe, location, time of day and light direction throughout. Use motivated camera movement and make each beat visibly different without unrelated jump cuts.",
    "[AVOID] Product morphing or colour changes, duplicate products, generic replacement products, impossible interactions, floating objects, deformed hands or extra fingers, face or clothing changes, fake logos, random English text, garbled Thai, unsupported claims shown as visual facts, and any ending before the requested duration.",
  ].join("\n");

  return { structured, text };
}
