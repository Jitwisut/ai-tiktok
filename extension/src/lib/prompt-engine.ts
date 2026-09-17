/** Ported from src/lib/prompt-engine/{types,prompt-builder,clip-planner}.ts — pure functions, no server dependency. */

import { styleUsesOnScreenText, styleVideoDirection } from "./style-playbooks.js";

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
  /** Thai summary; only used for the video model when `visual` is missing (older plans). */
  description: string;
  /** English visual direction written for the video model. */
  visual?: string;
  /** How the camera moves in this scene, continuing from the one before (newer scene plans only). */
  cameraMotion?: string;
  /** The 8-second clip this scene was planned for. */
  clip?: number;
  dialogue?: string;
  voiceover?: string;
}

/** The same person and place, repeated verbatim in every clip so separately rendered parts match. */
export interface CastLook {
  person: string;
  setting: string;
}

/**
 * Used when a scene plan has no camera directions: one simple move per part.
 * No orbits or arcs — when asked to circle a subject the video model tends to
 * spin the person (head turning 360°) instead of moving the camera.
 */
const DEFAULT_CAMERA_MOTIONS = [
  "slow gentle push-in from a medium shot towards the person and the product",
  "steady medium close-up with a slight tilt down to the product in the hands",
  "gentle slow pull-back to a medium shot that settles on the product",
];

/**
 * Camera words that make the model rotate the subject or smear the frame.
 * A plan that asks for them gets a steady move instead.
 */
const UNSTABLE_CAMERA = /\b(orbit\w*|arcs?|arcing|circl\w*|360|spin\w*|rotat\w*|whip\w*|swirl\w*|around the (subject|person|product))\b/i;

function safeCameraMotion(motion: string | undefined): string | undefined {
  const value = motion?.trim();
  if (!value) return undefined;
  return UNSTABLE_CAMERA.test(value) ? "slow steady push-in towards the person and the product" : value;
}

/**
 * Anatomy and motion rules repeated in every part. Stated positively as well as
 * in [AVOID]: video models follow "what to do" far better than "what not to do".
 */
const MOTION_RULES =
  "[MOTION] Real-world physics at normal speed. One simple, slow, deliberate action at a time. The person stays facing the camera (turned no more than about 45° away); the head moves only with small natural nods and tilts and always stays aligned with the shoulders and body. Exactly two arms and two hands with five fingers each; hands grip the product naturally. Face, hair and body keep a stable shape in every frame.";

/** Rules that stop the model rushing, mangling or repeating Thai speech. */
function voiceRules(clipSeconds: number, clipCount: number, onScreen: boolean): string {
  return [
    "Voice: a native Thai speaker with a clear standard Central Thai (Bangkok) accent and correct Thai tones, pronouncing every syllable fully at a relaxed conversational pace — not rushed, not robotic, not sing-song.",
    clipCount > 1 ? "Use the same voice (timbre, pitch and accent) as in the other parts of this advert." : "",
    "Speak the quoted Thai exactly as written, word for word, and say each line ONLY ONCE.",
    `Start speaking at about 0.5 seconds and finish the last word by about ${Math.max(2, clipSeconds - 1.5)} seconds. After the last line the voice stops completely: no repeating, no second take, no echo, no filler sounds, no extra or English words — the rest is silence with natural ambience while the action continues.`,
    onScreen
      ? "Lips move in sync only while the words are spoken and the mouth rests closed or smiling when silent; keep the face towards the camera and the head steady while talking."
      : "",
    "Soft background music kept low under the voice, natural room ambience.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Flow and AI Studio render 8 seconds per generation. */
export const CLIP_SECONDS = 8;

/** A video is joined from at most this many clips. */
export const MAX_CLIPS = 4;

export type GenerationSite = "aistudio" | "flow" | "gemini";

/**
 * Gemini's video tool renders the whole advert in one generation when the
 * prompt asks for its length, so it is never split into joined parts.
 */
export const GEMINI_DURATIONS = [10, 20];

/**
 * Seconds one generation renders on each site. Flow and AI Studio always make
 * 8-second clips; on Gemini one generation is the whole video, so it is the
 * requested length (snapped to a length Gemini makes).
 */
export function clipSecondsForSite(site: string | undefined, targetDuration?: number): number {
  if (site !== "gemini") return CLIP_SECONDS;
  const wanted = targetDuration || GEMINI_DURATIONS[0];
  return GEMINI_DURATIONS.reduce((best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best));
}

/** The lengths a site can make: one to four joined clips — or on Gemini, one generation of each length. */
export function durationOptions(site: string | undefined): number[] {
  if (site === "gemini") return [...GEMINI_DURATIONS];
  return Array.from({ length: MAX_CLIPS }, (_, i) => (i + 1) * CLIP_SECONDS);
}

/** The closest length the site can make — e.g. an older 30-second Gemini setting becomes 20. */
export function snapDuration(site: string | undefined, targetDuration: number): number {
  const options = durationOptions(site);
  return options.reduce((best, v) => (Math.abs(v - targetDuration) < Math.abs(best - targetDuration) ? v : best));
}

export function clipCountFor(targetDuration: number, clipSeconds: number): number {
  return Math.min(MAX_CLIPS, Math.max(1, Math.round(targetDuration / clipSeconds)));
}

/**
 * Speech longer than this in one clip makes the model rush, garble or cut the
 * line off; when a re-plan squeezes several clips' worth of lines into one,
 * later lines are dropped instead. Kept close to the 45-characters-per-8-seconds
 * budget the script writer is given (analysis-prompts.ts), with a little slack.
 */
const MAX_SPEECH_CHARS_PER_SECOND = 6.5;

/**
 * Emoji, quotes and symbols in a spoken line are read out as noise or make the
 * model improvise; keep only what a speaker can say.
 */
export function speakableThai(text: string | undefined): string {
  return (text ?? "")
    .replace(/[^\u0E00-\u0E7FA-Za-z0-9\s!?,.]/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([!?,.])/g, "$1")
    .trim();
}

/** Which run this is when the same content is generated several times in a row. */
export interface PlanVariant {
  index: number;
  total: number;
}

export interface PlannedClip {
  index: number;
  prompt: string;
  startSecond: number;
}

/** Short Thai overlay text written by the script step; either may be missing on older content. */
export interface OnScreenText {
  headline?: string;
  cta?: string;
}

function quoteExact(value: string): string {
  return JSON.stringify(value.trim());
}

/** "9:16 portrait vertical" vs "16:9 landscape horizontal" — never a ratio that contradicts its orientation word. */
export function describeAspectRatio(aspectRatio: string): string {
  const [w, h] = aspectRatio.split(":").map(Number);
  if (w && h && w > h) return `${aspectRatio} landscape (horizontal)`;
  if (w && h && w === h) return `${aspectRatio} square`;
  return `${aspectRatio} portrait (vertical)`;
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
 * Veo writes whatever text it likes onto the frame — English titles, or
 * letters that only look Thai. Text is only requested for styles that need it
 * (see styleUsesOnScreenText), as short quoted Thai; everything else is text-free.
 */
function onScreenTextRule(index: number, clipCount: number, text: OnScreenText | undefined): { rule: string; hasText: boolean } {
  const items: string[] = [];
  if (index === 0 && text?.headline) items.push(`At the start show the Thai text ${quoteExact(text.headline)}.`);
  if (index === clipCount - 1 && text?.cta) items.push(`Near the end show the Thai text ${quoteExact(text.cta)}.`);
  if (!items.length) return { rule: `${NO_TEXT_RULE} ${PACKAGING_RULE}`, hasText: false };
  return { rule: `${quotedTextRule(items, clipCount === 1 ? "video" : "part")} ${PACKAGING_RULE}`, hasText: true };
}

interface ClipGroup {
  scenes: ScenePromptInput[];
  /** Set when one scene is spread over several clips because the plan has fewer scenes than clips. */
  continuation?: { part: number; of: number };
  /** Index into the flat scene list of the first scene in this group. */
  first: number;
}

/**
 * Newer plans say which clip each scene belongs to; use that when it matches
 * the clip count. Otherwise (older plans, or the user picked a different
 * length later) share the scenes out in order — and when there are fewer
 * scenes than clips, spread a scene over consecutive clips as a continuation
 * instead of handing the same action to two clips as if it were new.
 */
function groupScenes(scenes: ScenePromptInput[], clipCount: number): ClipGroup[] {
  const planned = scenes.every((s) => Number.isInteger(s.clip));
  if (planned) {
    const byClip = Array.from({ length: clipCount }, () => [] as ScenePromptInput[]);
    let fits = true;
    for (const scene of scenes) {
      if (scene.clip! < 0 || scene.clip! >= clipCount) fits = false;
      else byClip[scene.clip!].push(scene);
    }
    if (fits && byClip.every((group) => group.length > 0)) {
      return byClip.map((group) => ({ scenes: group, first: scenes.indexOf(group[0]) }));
    }
  }

  if (scenes.length >= clipCount) {
    return Array.from({ length: clipCount }, (_, index) => {
      const first = Math.floor((index * scenes.length) / clipCount);
      const last = Math.floor(((index + 1) * scenes.length) / clipCount) - 1;
      return { scenes: scenes.slice(first, last + 1), first };
    });
  }

  const owners = Array.from({ length: clipCount }, (_, index) => Math.floor((index * scenes.length) / clipCount));
  return owners.map((sceneIndex, index) => {
    const span = owners.filter((owner) => owner === sceneIndex).length;
    const part = owners.slice(0, index + 1).filter((owner) => owner === sceneIndex).length;
    return {
      scenes: [scenes[sceneIndex]],
      first: sceneIndex,
      continuation: span > 1 ? { part, of: span } : undefined,
    };
  });
}

/**
 * Rescales scene lengths to fill one clip. Rounding the running boundaries
 * (to half seconds) rather than each duration keeps the last beat ending at
 * exactly clipSeconds — per-scene rounding could list "[6-9s]" in an 8s clip.
 */
function timeline(scenes: ScenePromptInput[], clipSeconds: number): { start: number; end: number; scene: ScenePromptInput }[] {
  const total = scenes.reduce((sum, scene) => sum + Math.max(0, scene.duration), 0);
  let running = 0;
  let previousEnd = 0;
  return scenes.map((scene, i) => {
    running += total > 0 ? Math.max(0, scene.duration) : 1;
    const share = running / (total > 0 ? total : scenes.length);
    const end = i === scenes.length - 1 ? clipSeconds : Math.round(share * clipSeconds * 2) / 2;
    const start = previousEnd;
    previousEnd = end;
    return { start, end, scene };
  });
}

function visualOf(scene: ScenePromptInput): string {
  return (scene.visual?.trim() || scene.description.trim()).replace(/[.。]$/, "");
}

interface SpeechLine {
  kind: "dialogue" | "voiceover";
  text: string;
  start: number;
  end: number;
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
 * Spoken lines for one clip, in order, trimmed to what fits in the clip.
 * `spoken` holds lines earlier clips already say, so a line the plan put in
 * two clips is heard once rather than twice in the joined video.
 */
function speechLines(beats: ReturnType<typeof timeline>, clipSeconds: number, spoken: Set<string>): SpeechLine[] {
  const lines: SpeechLine[] = [];
  for (const { start, end, scene } of beats) {
    for (const [kind, raw] of [["dialogue", scene.dialogue], ["voiceover", scene.voiceover]] as const) {
      const text = speakableThai(raw);
      if (!text || spoken.has(text) || lines.some((line) => line.text === text)) continue;
      lines.push({ kind, text, start, end });
    }
  }
  return fitSpeech(lines, MAX_SPEECH_CHARS_PER_SECOND * clipSeconds);
}

export interface PlanClipsInput {
  productName: string;
  scenes: ScenePromptInput[];
  settings: VideoSettings;
  targetDuration: number;
  /** Seconds the generation site renders per clip (clipSecondsForSite). */
  clipSeconds?: number;
  variant?: PlanVariant;
  text?: OnScreenText;
  /** The content's style (UGC, Demo, …); falls back to settings.style. */
  style?: string;
  /** Looks planned with the storyboard; the variant picks which one this run uses. */
  castOptions?: CastLook[];
}

/**
 * Turns a scene plan into one self-contained prompt per clip (8 seconds on
 * Flow/AI Studio; on Gemini a single clip is the whole video). Each
 * clip is rendered by a separate call that sees only its own prompt, so every
 * part repeats what must stay identical (cast, setting, look), states what
 * happens now, and says how it joins the part before.
 */
export function planClips(input: PlanClipsInput): PlannedClip[] {
  const { productName, scenes, settings, targetDuration, variant } = input;
  const clipSeconds = input.clipSeconds ?? CLIP_SECONDS;
  const clipCount = clipCountFor(targetDuration, clipSeconds);
  if (scenes.length === 0) return [];

  const style = input.style || settings.style;
  const text = styleUsesOnScreenText(style) ? input.text : undefined;
  const look = `${settings.lighting}, one consistent colour grade, ${style}-style ${settings.camera} footage`;
  const casts = (input.castOptions ?? []).filter((c) => c.person?.trim() && c.setting?.trim());
  const cast = casts.length ? casts[(variant?.index ?? 0) % casts.length] : undefined;
  const groups = groupScenes(scenes, clipCount);
  const spoken = new Set<string>();

  return groups.map((group, index) => {
    const isFirst = index === 0;
    const isLast = index === clipCount - 1;
    // A whole advert rendered in one generation that is longer than a single shot (Gemini's 20 seconds).
    const longTake = clipCount === 1 && clipSeconds > 10;
    const beats = timeline(group.scenes, clipSeconds);
    const sections: string[] = [];

    sections.push(
      clipCount > 1
        ? `[GOAL] Create exactly one ${clipSeconds}-second video segment: part ${index + 1} of ${clipCount} of ONE continuous ${clipCount * clipSeconds}-second ${style}-style TikTok advert that will be joined into a single video.`
        : `[GOAL] Create ONE complete ${clipSeconds}-second ${style}-style TikTok advert as a single video that runs the full ${clipSeconds} seconds from start to finish — not a shorter clip, not split into parts. An attention-grabbing hook in the first 2 seconds, then the product in use, then a clear ending on the product.`,
    );
    sections.push(
      `[FORMAT] ${describeAspectRatio(settings.aspectRatio)} video. ${look}. Sharp focus, natural motion, realistic hands and faces.`,
    );
    sections.push(`[PRODUCT] ${productName}. The same single product throughout, never replaced by a generic or similar item.`);
    sections.push(`[STYLE EXECUTION] ${styleVideoDirection(style)}`);

    if (cast) {
      sections.push(`[CAST] ${cast.person}. Exactly this person and wardrobe in every part — same face, hair, body and clothes.`);
      sections.push(`[SETTING] ${cast.setting}. Same location, time of day and light direction in every part.`);
    } else if (longTake) {
      sections.push("[CAST & SETTING] One person, one wardrobe and one location for the whole video — face, hair, clothes, time of day and light direction never change.");
    } else if (clipCount > 1) {
      sections.push(
        isFirst
          ? "[CAST & SETTING] Establish one person, wardrobe and location that every later part must keep."
          : `[CAST & SETTING] Identical person (face, hair, body), wardrobe, location, time of day and light direction as part ${index}.`,
      );
    }

    // What happened before, so this part moves the story on instead of re-shooting it.
    const alreadyShown = scenes.slice(0, group.first).map(visualOf).join(" / ");
    const story: string[] = [];
    if (alreadyShown) story.push(`Earlier parts already showed: ${alreadyShown}. Do not repeat those actions.`);
    if (group.continuation) {
      const { part, of } = group.continuation;
      story.push(
        part === 1
          ? `This beat carries on over the next ${of - 1} part(s): show only its opening stage here.`
          : `Part ${index} already showed the start of this beat; this is stage ${part} of ${of} — show the next moment (a new detail, step or result), not the same shot again.`,
      );
    }
    if (clipCount > 1 && story.length) sections.push(`[STORY SO FAR] ${story.join(" ")}`);

    sections.push(
      `[TIMELINE] ${clipCount === 1 ? `Follow these beats in order, filling all ${clipSeconds} seconds: ` : ""}${beats.map(({ start, end, scene }) => `[${start}-${end}s] ${visualOf(scene)}.`).join(" ")}` +
        (clipCount === 1 || isLast ? " End on the product looking appealing." : " End mid-motion on a clear, steady frame that the next part can continue from."),
    );

    // A continuation clip does not re-speak the lines its first stage already said.
    const speech = group.continuation && group.continuation.part > 1 ? [] : speechLines(beats, clipSeconds, spoken);
    speech.forEach((line) => spoken.add(line.text));
    const onScreenSpeaker = speech.some((line) => line.kind === "dialogue");
    sections.push(
      speech.length
        ? [
            `[AUDIO] The complete spoken script for this ${clipCount === 1 ? "video" : "part"}, in this order:`,
            speech
              .map((line, i) =>
                // Long single generations keep per-line timing so each line lands on its beat; in 8-second clips narrow windows made the model rush.
                `${speech.length > 1 ? `${i + 1}) ` : ""}${clipSeconds > 10 ? `[${line.start}-${line.end}s] ` : ""}${line.kind === "dialogue" ? "The person on screen says in Thai" : "An off-screen narrator says in Thai"}: ${quoteExact(line.text)}`,
              )
              .join(" "),
            voiceRules(clipSeconds, clipCount, onScreenSpeaker),
          ].join(" ")
        : "[AUDIO] No speech or voiceover — nobody talks and lips stay closed. Natural ambient sound and light upbeat background music only.",
    );

    sections.push(MOTION_RULES);

    const motions = group.scenes.map((scene) => safeCameraMotion(scene.cameraMotion)).filter(Boolean).join(", then ");
    const motion =
      motions || (longTake ? DEFAULT_CAMERA_MOTIONS.join(", then ") : DEFAULT_CAMERA_MOTIONS[Math.min(index, DEFAULT_CAMERA_MOTIONS.length - 1)]);
    sections.push(
      longTake
        ? `[CAMERA] ${motion}. Slow, stable, motivated camera moves on a steady handheld or gimbal; a clean cut between beats is fine, but no jarring jump cuts, and the person, product, location and lighting look identical in every shot.`
        : isFirst || clipCount === 1
        ? `[CAMERA] One continuous, stable take with no cuts: ${motion}. The camera moves slowly; the person does not spin or turn around.`
        : `[CAMERA] Open on a calm, steady medium shot of the same person and product, continuing naturally from the end of part ${index}, then ${motion}. One continuous, stable take; the person does not spin or turn around.`,
    );

    // Repeated runs of the same content would otherwise come back as near-identical videos.
    if (variant && variant.total > 1) {
      sections.push(
        cast && casts.length > 1
          ? `[VARIATION] Version ${variant.index + 1} of ${variant.total}: use a noticeably different camera angle and framing from the other versions while following the timeline above.`
          : `[VARIATION] Version ${variant.index + 1} of ${variant.total}: make it clearly different from the other versions — a different person, setting and camera angle — while keeping the same product and message.`,
      );
    }

    const onScreen = onScreenTextRule(index, clipCount, text);
    sections.push(onScreen.rule);
    sections.push(
      "[AVOID] Head or body spinning or rotating unnaturally, head turning past the shoulders, twisted neck, the person turning their back to the camera, limbs bending the wrong way, hands passing through objects, morphing face or body, product changing shape or colour, duplicate products, deformed hands or extra fingers, sudden face, clothing, location or lighting change" +
        (isFirst ? "" : ", a jump cut at the start") +
        (clipCount === 1 ? `, ending before ${clipSeconds} seconds` : "") +
        ", looping or replaying earlier moments, repeated or stuttered words, speaking a line twice, mumbling or garbled Thai speech, lips moving without speech, fake logos, watermarks, " + textAvoidList(onScreen.hasText) + ".",
    );

    return {
      index,
      prompt: sections.join("\n"),
      startSecond: index * clipSeconds,
    };
  });
}
