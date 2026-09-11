import type { ScenePromptInput, VideoSettings } from "./types";

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

/**
 * Deterministic template — turns a scene plan + video settings into the
 * structured prompt from plan section 13, and a flattened text prompt for
 * the video provider. No LLM call: keeping this a pure function is what
 * lets prompts be versioned, diffed, and swapped between providers.
 */
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
