import { getStylePlaybook, assertSpeechFits, stylePerformance, styleCameraMotion, styleUsesOnScreenText, type PresenterMode, type StylePlaybook } from "./style-playbooks";
import { videoSettingsSchema } from "./types";
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
 * Camera words that make Veo rotate the subject (head turning 360°) or smear
 * the frame instead of moving the camera.
 */
const UNSTABLE_CAMERA = /\b(orbit\w*|arcs?|arcing|circl\w*|360|spin\w*|rotat\w*|whip\w*|swirl\w*|around the (subject|person|product))\b/i;

export function safeCameraMotion(motion: string | null | undefined, presenter: PresenterMode = "mixed"): string | undefined {
  const value = motion?.trim();
  if (!value) return undefined;
  if (!UNSTABLE_CAMERA.test(value)) return value;
  return `slow steady push-in towards ${presenter === "hands" ? "the hands" : "the person"} and the product`;
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

/** Keep realism guidance consistent with the extension prompt engine. */
const REAL_AD_LOOK =
  "[REALISM] Believable materials, natural skin texture when visible, everyday surroundings appropriate to the style, and the product at its true scale. Keep the background uncluttered and the contact point visible; leave the outer edges clear for TikTok UI.";

function motionRules(presenter: PresenterMode): string {
  const framing =
    presenter === "hands"
      ? "Only the hands and forearms appear with the product — no face or head in frame."
      : presenter === "mixed" ? "The person looks at the task naturally; eye contact with the lens only when addressing it. Keep identity and anatomy stable." : "Natural eye contact while addressing the lens; look at the product while using it. Keep identity and anatomy stable.";
  return `[MOTION] Real-world physics at normal speed. One simple, slow, deliberate action at a time. ${framing} Hands grip the product naturally with correct anatomy; contact and movement follow real-world physics.`;
}

/** Also sent as Veo's negativePrompt, which the model weighs separately from the prompt. */
export function veoNegativePrompt(hasText: boolean): string {
  return `${VEO_NEGATIVE_BASE}, ${textAvoidList(hasText)}`;
}

const VEO_NEGATIVE_BASE =
  "deformed anatomy, impossible contact, product redesign or morphing, duplicate copies of the advertised product, unstable camera, sudden identity or lighting changes, replayed actions, repeated words, garbled speech, lip movement without dialogue, watermarks, fake logos";

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
  "[ON-SCREEN TEXT] None. Nothing is written over the video — no captions, subtitles, titles, stickers, signs, handwriting or made-up letters in any alphabet; the only printing in the frame is the product's own logo and label exactly as in the product photo. The spoken Thai lines are heard only and are never written on screen.";

/** Copy the label design from the photo but never its lettering, which comes back as made-up Thai glyphs. */
const PACKAGING_RULE =
  "The product's logo, label layout, colours and printed design look exactly as in the product photo. Never add, rewrite or re-letter any text on the product or packaging, and do not zoom in on small print.";

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
    : "overlaid on-screen text, letters, numbers or symbols, subtitles, captions, made-up or alien-looking letters, gibberish characters, English words";
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
 * One ordered script instead of per-beat timestamps: narrow time windows made
 * Veo rush lines, and gaps between them made it fill the silence by repeating.
 * `spoken` holds lines earlier clips already say, so the joined video says
 * each line once.
 */
function speechInstructions(beats: TimedScene[], duration: number, spoken: Set<string>, multiPart: boolean, playbook: StylePlaybook): string {
  if (playbook.speech === "silent") return `[AUDIO] No dialogue or narration. ${playbook.soundBed}.`;
  const candidates: { onScreen: boolean; text: string }[] = [];
  for (const { scene } of beats) {
    for (const [onScreen, raw] of [[true, scene.dialogue], [false, scene.voiceover]] as const) {
      const text = speakableThai(raw);
      if (!text || spoken.has(text) || candidates.some((line) => line.text === text)) continue;
      // No face in a hands-only style, so even older on-screen dialogue is narrated off screen.
      candidates.push({ onScreen: onScreen && playbook.presenter !== "hands", text });
    }
  }
  // Reject overflow before spending video credits; never silently discard a sentence.
  assertSpeechFits(candidates.map((line) => line.text).join(" "), duration, playbook.speech);
  const lines = candidates;
  lines.forEach((line) => spoken.add(line.text));

  if (!lines.length) {
    return `[AUDIO] No dialogue and no voiceover. Nobody speaks and lips stay closed. ${playbook.soundBed}.`;
  }

  // Consecutive lines from one speaker are one monologue — numbered lines were spoken as separate slogans.
  const blocks: { onScreen: boolean; text: string }[] = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.onScreen === line.onScreen) last.text = `${last.text} ${line.text}`;
    else blocks.push({ ...line });
  }
  const script = blocks
    .map(
      (block, i) =>
        `${blocks.length > 1 ? `${i + 1}) ` : ""}${block.onScreen ? "The person on screen says in Thai" : "An off-screen narrator says in Thai"}, as one natural continuous monologue: ${quoteExact(block.text)}`,
    )
    .join(" ");

  return [
    `[AUDIO] The complete spoken script, in this order: ${script}`,
    "Voice: a native Thai speaker with a clear standard Central Thai (Bangkok) accent and correct Thai tones, pronouncing every syllable fully at a relaxed conversational pace — not rushed, not robotic, not sing-song.",
    multiPart ? "Use the same voice (timbre, pitch and accent) as in the other parts of this advert." : "",
    "Speak the quoted Thai exactly as written, word for word, with the sentences flowing into each other as one connected thought in natural spoken Thai intonation — like telling a friend, not reading a list of slogans. Do not translate, paraphrase, shorten or add words.",
    playbook.speech === "light"
      ? `Speak the lines softly at about 0.5 seconds and in between the product sounds, finishing by about ${Math.max(2, duration - 0.5)} seconds; calm pauses between lines are welcome so the natural sounds are heard.`
      : `Speak at a relaxed conversational pace, with breathing pauses and room for the product action. Finish by ${Math.max(2, duration - 1)} seconds; let the final result be seen without adding words.`,
    `Delivery: ${playbook.delivery}; any energy comes from tone and emphasis, never from speed, so every word stays clear — never shouting and never an over-the-top announcer.`,
    "Say each line ONLY ONCE: no repeating, no second take, no echo, no filler sounds.",
    lines.some((line) => line.onScreen)
      ? "Lips move in sync only while the words are spoken and the mouth rests closed or smiling when silent; keep the face towards the camera and the head steady while talking."
      : "",
    `Sound: ${playbook.soundBed}.`,
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
  // Camera, light, voice and sound follow the style unless the caller set its own camera or light.
  const playbook = getStylePlaybook(settings.style);
  const defaults = videoSettingsSchema.parse({});
  const camera = settings.camera === defaults.camera ? playbook.camera : settings.camera;
  const lighting = settings.lighting === defaults.lighting ? playbook.lighting : settings.lighting;
  const timedScenes: TimedScenePrompt[] = beats.map(({ start, end, scene }) => ({
    start,
    end,
    action: visualOf(scene),
    visual: scene.visual?.trim() || undefined,
    cameraMotion: styleCameraMotion(settings.style, safeCameraMotion(scene.cameraMotion, playbook.presenter)),
    dialogue: playbook.speech === "silent" || playbook.presenter === "hands" ? undefined : scene.dialogue?.trim() || undefined,
    voiceover: playbook.speech === "silent" ? undefined : playbook.presenter === "hands" ? [scene.dialogue?.trim(), scene.voiceover?.trim()].filter(Boolean).join(" ") || undefined : scene.voiceover?.trim() || undefined,
  }));

  const timelineText = beats
    .map(({ start, end, scene }) => {
      const cameraMotion = styleCameraMotion(settings.style, safeCameraMotion(scene.cameraMotion, playbook.presenter));
      const motion = cameraMotion ? ` Camera: ${cameraMotion}.` : "";
      return `[${start}-${end}s] ${visualOf(scene)}.${motion}`;
    })
    .join(" ");

  const structured: VeoPromptStructured = {
    style: settings.style,
    aspectRatio: settings.aspectRatio,
    duration: settings.duration,
    camera,
    lighting,
    language: settings.language,
    product: productName,
    onScreenText: settings.onScreenText,
    onScreenCta: settings.onScreenCta,
    scenes: timedScenes,
  };

  const text = [
    `[GOAL] Create exactly one ${settings.duration}-second ${settings.style}-style TikTok affiliate video that fills the full duration from start to finish.`,
    `[FORMAT] ${describeAspectRatio(settings.aspectRatio)} video. Camera: ${camera}. Lighting: ${lighting}.`,
    `[STYLE EXECUTION] ${playbook.videoDirection}.`,
    REAL_AD_LOOK,
    `[PRODUCT] Feature exactly one real product: ${productName}. It matches the product reference exactly and keeps the same shape, proportions, size, colours, material and label design in every frame; it never morphs and is never replaced by a generic, similar or redesigned item. Show it clearly with its front and logo towards the camera; hands never cover the logo or front label.`,
    `[LANGUAGE] Spoken language: ${settings.language}. Any provided Thai dialogue or voiceover must be spoken exactly in Thai.`,
    `[TIMELINE] ${timelineText}`,
    speechInstructions(beats, settings.duration, spoken, multiPart, playbook),
    motionRules(playbook.presenter),
    `[PERFORMANCE] ${stylePerformance(settings.style)}`,
    onScreenTextRule(settings, multiPart),
    playbook.presenter === "hands"
      ? "[CONTINUITY] One continuous, stable take. Keep the same hands, sleeves, location, time of day and light direction throughout. The camera moves slowly and smoothly; beats flow into each other through the hands' action, with no jump cuts, and the product is never spun around."
      : "[CONTINUITY] One continuous, stable take. Keep one consistent person, wardrobe, location, time of day and light direction throughout. The camera moves slowly and smoothly; beats flow into each other through the person's action, with no jump cuts, and the person never spins or turns around.",
    `[AVOID] ${veoNegativePrompt(hasText)}, generic replacement products, impossible interactions, floating objects, unsupported claims shown as visual facts, and any ending before the requested duration.`,
  ].filter(Boolean).join("\n");

  return { structured, text };
}
