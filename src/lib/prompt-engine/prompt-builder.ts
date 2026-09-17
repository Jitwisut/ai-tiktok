import { styleUsesOnScreenText, styleVideoDirection } from "./style-playbooks";
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

/**
 * Speech longer than this per second makes Veo rush, garble or cut the line
 * off. Close to the 45-characters-per-8-seconds budget the script writer gets.
 */
const MAX_SPEECH_CHARS_PER_SECOND = 6.5;

/**
 * Camera words that make Veo rotate the subject (head turning 360°) or smear
 * the frame instead of moving the camera.
 */
const UNSTABLE_CAMERA = /\b(orbit\w*|arcs?|arcing|circl\w*|360|spin\w*|rotat\w*|whip\w*|swirl\w*|around the (subject|person|product))\b/i;

export function safeCameraMotion(motion: string | null | undefined): string | undefined {
  const value = motion?.trim();
  if (!value) return undefined;
  return UNSTABLE_CAMERA.test(value) ? "slow steady push-in towards the person and the product" : value;
}

/** Emoji, quotes and symbols in a spoken line are read out as noise or make the model improvise. */
export function speakableThai(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[^\u0E00-\u0E7FA-Za-z0-9\s!?,.]/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([!?,.])/g, "$1")
    .trim();
}

const MOTION_RULES =
  "[MOTION] Real-world physics at normal speed. One simple, slow, deliberate action at a time. The person stays facing the camera (turned no more than about 45° away); the head moves only with small natural nods and tilts and always stays aligned with the shoulders and body. Exactly two arms and two hands with five fingers each; hands grip the product naturally. Face, hair and body keep a stable shape in every frame.";

/** Also sent as Veo's negativePrompt, which the model weighs separately from the prompt. */
export function veoNegativePrompt(hasText: boolean): string {
  return `${VEO_NEGATIVE_BASE}, ${textAvoidList(hasText)}`;
}

const VEO_NEGATIVE_BASE =
  "head or body spinning or rotating unnaturally, head turning past the shoulders, twisted neck, person turning their back to the camera, limbs bending the wrong way, hands passing through objects, morphing face or body, deformed hands, extra fingers, extra limbs, product changing shape or colour, duplicate products, sudden face, clothing, location or lighting change, fast jittery motion, looping or replaying earlier moments, repeated or stuttered words, speaking a line twice, mumbling, garbled speech, lips moving without speech, watermarks, fake logos";

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

/** No-text rule: the prompt carries quoted Thai speech, which models otherwise draw as subtitles in made-up letters. */
const NO_TEXT_RULE =
  "[ON-SCREEN TEXT] None. The video contains no written words at all — no captions, subtitles, titles, stickers, labels, signs, handwriting or made-up letters in any alphabet. The spoken Thai lines are heard only and are never written on screen.";

const PACKAGING_RULE =
  "The product packaging shows only its real logo and colours as in the product photo; all other small printing stays soft and unreadable, never invented letters.";

/** One short quoted Thai string, copied as-is; everything else stays text-free. */
function quotedTextRule(items: string[], scope: string): string {
  return [
    `[ON-SCREEN TEXT] ${items.join(" ")}`,
    "Copy the Thai inside the double quotation marks character for character — do not translate, re-spell, reorder or add characters.",
    "Draw it as one line of large bold white Thai letters with a dark outline, centred in the upper third of the frame, held perfectly still for about 2 seconds while the camera is steady.",
    "The quoted text is the ONLY writing anywhere in the video: no other captions, subtitles, labels or signs, and the spoken lines are never shown as text.",
    `If it cannot be drawn as correct, readable Thai, show no text at all in this ${scope}.`,
  ].join(" ");
}

/** Text-related items for [AVOID] / negativePrompt. */
export function textAvoidList(hasText: boolean): string {
  return hasText
    ? "any text other than the quoted Thai, subtitles, captions, made-up or alien-looking letters, gibberish characters, misspelled Thai, English words"
    : "any on-screen text, letters, numbers or symbols, subtitles, captions, made-up or alien-looking letters, gibberish characters, English words";
}

/**
 * Text is only requested for styles that need it (styleUsesOnScreenText), as
 * short quoted Thai; everything else is text-free because Veo often draws Thai
 * as made-up letters.
 */
function onScreenTextRule(settings: VideoSettings, multiPart: boolean): string {
  const items: string[] = [];
  if (settings.onScreenText) items.push(`At the start show the Thai text ${quoteExact(settings.onScreenText)}.`);
  if (settings.onScreenCta) items.push(`Near the end show the Thai text ${quoteExact(settings.onScreenCta)}.`);
  if (!items.length) return `${NO_TEXT_RULE} ${PACKAGING_RULE}`;
  return `${quotedTextRule(items, multiPart ? "part" : "video")} ${PACKAGING_RULE}`;
}

/**
 * Keeps lines within the character budget. The last line (usually the CTA)
 * is always kept; lines before it are dropped from the end when over budget.
 */
function fitSpeech<T extends { text: string }>(lines: T[], budget: number): T[] {
  const length = (line: T) => Array.from(line.text).length;
  if (lines.length <= 1) return lines;
  const last = lines[lines.length - 1];
  let used = length(last);
  const kept: T[] = [];
  for (const line of lines.slice(0, -1)) {
    if (kept.length > 0 && used + length(line) > budget) break;
    used += length(line);
    kept.push(line);
  }
  return [...kept, last];
}

/**
 * One ordered script instead of per-beat timestamps: narrow time windows made
 * Veo rush lines, and gaps between them made it fill the silence by repeating.
 * `spoken` holds lines earlier clips already say, so the joined video says
 * each line once.
 */
function speechInstructions(beats: TimedScene[], duration: number, spoken: Set<string>, multiPart: boolean): string {
  const candidates: { onScreen: boolean; text: string }[] = [];
  for (const { scene } of beats) {
    for (const [onScreen, raw] of [[true, scene.dialogue], [false, scene.voiceover]] as const) {
      const text = speakableThai(raw);
      if (!text || spoken.has(text) || candidates.some((line) => line.text === text)) continue;
      candidates.push({ onScreen, text });
    }
  }
  const lines = fitSpeech(candidates, MAX_SPEECH_CHARS_PER_SECOND * duration);
  lines.forEach((line) => spoken.add(line.text));

  if (!lines.length) {
    return "[AUDIO] No dialogue and no voiceover. Nobody speaks and lips stay closed. Use natural ambient sound and low background music only.";
  }

  const script = lines
    .map(
      (line, i) =>
        `${lines.length > 1 ? `${i + 1}) ` : ""}${line.onScreen ? "The person on screen says in Thai" : "An off-screen narrator says in Thai"}: ${quoteExact(line.text)}`,
    )
    .join(" ");

  return [
    `[AUDIO] The complete spoken script, in this order: ${script}`,
    "Voice: a native Thai speaker with a clear standard Central Thai (Bangkok) accent and correct Thai tones, pronouncing every syllable fully at a relaxed conversational pace — not rushed, not robotic, not sing-song.",
    multiPart ? "Use the same voice (timbre, pitch and accent) as in the other parts of this advert." : "",
    "Speak the quoted Thai exactly as written, word for word, and say each line ONLY ONCE. Do not translate, paraphrase, shorten or add words.",
    `Start speaking at about 0.5 seconds and finish the last word by about ${Math.max(2, duration - 1.5)} seconds. After the last line the voice stops completely: no repeating, no second take, no echo, no filler sounds — the rest is silence with natural ambience while the action continues.`,
    lines.some((line) => line.onScreen)
      ? "Lips move in sync only while the words are spoken and the mouth rests closed or smiling when silent; keep the face towards the camera and the head steady while talking."
      : "",
    "Keep background music low under the voice and preserve natural room ambience.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Deterministic template that preserves scene visuals, exact spoken Thai, and
 * exact requested on-screen Thai all the way to the video provider.
 */
export function buildVeoPrompt(
  productName: string,
  scenes: ScenePromptInput[],
  settings: VideoSettings,
  /** Lines already spoken by earlier parts of the same advert; updated in place. */
  spoken: Set<string> = new Set(),
  multiPart = false,
): BuiltVeoPrompt {
  if (!styleUsesOnScreenText(settings.style)) {
    settings = { ...settings, onScreenText: undefined, onScreenCta: undefined };
  }
  const hasText = Boolean(settings.onScreenText || settings.onScreenCta);
  const beats = timeline(scenes, settings.duration);
  const timedScenes: TimedScenePrompt[] = beats.map(({ start, end, scene }) => ({
    start,
    end,
    action: visualOf(scene),
    visual: scene.visual?.trim() || undefined,
    cameraMotion: safeCameraMotion(scene.cameraMotion),
    dialogue: scene.dialogue?.trim() || undefined,
    voiceover: scene.voiceover?.trim() || undefined,
  }));

  const timelineText = beats
    .map(({ start, end, scene }) => {
      const cameraMotion = safeCameraMotion(scene.cameraMotion);
      const motion = cameraMotion ? ` Camera: ${cameraMotion}.` : "";
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
    speechInstructions(beats, settings.duration, spoken, multiPart),
    MOTION_RULES,
    onScreenTextRule(settings, multiPart),
    "[CONTINUITY] One continuous, stable take. Keep one consistent person, wardrobe, location, time of day and light direction throughout. The camera moves slowly and smoothly; beats flow into each other through the person's action, with no jump cuts, and the person never spins or turns around.",
    `[AVOID] ${veoNegativePrompt(hasText)}, generic replacement products, impossible interactions, floating objects, unsupported claims shown as visual facts, and any ending before the requested duration.`,
  ].join("\n");

  return { structured, text };
}
