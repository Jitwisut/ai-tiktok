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

/** Used when a scene plan has no camera directions: one continuous handheld move per part. */
const DEFAULT_CAMERA_MOTIONS = [
  "slow handheld push-in from a medium shot towards the person and the product",
  "smooth handheld arc around the subject that reveals the product from a new side",
  "gentle handheld pull-back to a medium shot that settles on the product",
];

/** Flow and AI Studio render 8 seconds per generation. */
export const CLIP_SECONDS = 8;

/** A video is joined from at most this many clips. */
export const MAX_CLIPS = 3;

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

/** The lengths a site can make: one, two or three joined clips — or on Gemini, one generation of each length. */
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
 * Speech longer than this in one clip makes the model rush or cut the line
 * off; when a re-plan squeezes several clips' worth of lines into one, later
 * lines are dropped instead.
 */
const MAX_SPEECH_CHARS_PER_SECOND = 10;

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

/** "9:16 portrait vertical" vs "16:9 landscape horizontal" — never a ratio that contradicts its orientation word. */
export function describeAspectRatio(aspectRatio: string): string {
  const [w, h] = aspectRatio.split(":").map(Number);
  if (w && h && w > h) return `${aspectRatio} landscape (horizontal)`;
  if (w && h && w === h) return `${aspectRatio} square`;
  return `${aspectRatio} portrait (vertical)`;
}

/**
 * Veo writes whatever text it likes onto the frame — English titles, or
 * letters that only look Thai. Giving it the exact short Thai strings to show,
 * and forbidding anything else, is the most reliable way to get readable Thai.
 */
function onScreenTextRule(index: number, clipCount: number, text: OnScreenText | undefined, clipSeconds: number): string {
  const lines: string[] = [];
  const isFirst = index === 0;
  const isLast = index === clipCount - 1;
  if (isFirst && text?.headline) lines.push(`at the start show the Thai headline 「${text.headline}」`);
  if (isLast && text?.cta) lines.push(`${lines.length ? "and " : ""}near the end show the Thai call to action 「${text.cta}」`);

  const packaging =
    "The product's own packaging keeps its real design, colours and logo exactly as in the product photo; render small or dense printed packaging text as soft natural product-photography detail rather than invented legible characters.";

  if (!lines.length) {
    return `[ON-SCREEN TEXT] None. Add no captions, subtitles, titles, stickers or labels anywhere in the frame. ${packaging}`;
  }
  return [
    `[ON-SCREEN TEXT] ${lines.join(" ")}.`,
    "Copy these Thai strings character for character, exactly as written between the 「」 marks, with every vowel and tone mark in the right place — do not translate, transliterate, reorder or add characters.",
    `Render it as a short static title card: large bold Thai sans-serif block letters, one line, centred, held still (no motion blur, no fast pan across it) against a plain high-contrast background ${clipSeconds > 10 ? "for about 2-3 seconds each" : "for at least half the shot's length"}, so the letterforms stay sharp.`,
    "Show no other on-screen text anywhere else in the frame, and never English words or garbled characters that merely look like Thai.",
    `If you cannot render this exact Thai text sharply and correctly, show no on-screen text at all for this ${clipCount === 1 ? "video" : "part"} — incorrect Thai text is worse than no text.`,
    packaging,
  ].join(" ");
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

/** Spoken lines for one clip, in order, trimmed to what fits in the clip. */
function speechLines(beats: ReturnType<typeof timeline>, clipSeconds: number): string[] {
  const budget = MAX_SPEECH_CHARS_PER_SECOND * clipSeconds;
  const lines: string[] = [];
  let used = 0;
  for (const { start, end, scene } of beats) {
    for (const [kind, raw] of [["dialogue", scene.dialogue], ["voiceover", scene.voiceover]] as const) {
      const line = raw?.trim();
      if (!line) continue;
      const length = Array.from(line).length;
      if (lines.length > 0 && used + length > budget) return lines;
      used += length;
      lines.push(
        kind === "dialogue"
          ? `[${start}-${end}s] The person on screen says in Thai: "${line}"`
          : `[${start}-${end}s] Off-screen narrator voiceover in Thai: "${line}"`,
      );
    }
  }
  return lines;
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
  const { productName, scenes, settings, targetDuration, variant, text } = input;
  const clipSeconds = input.clipSeconds ?? CLIP_SECONDS;
  const clipCount = clipCountFor(targetDuration, clipSeconds);
  if (scenes.length === 0) return [];

  const style = input.style || settings.style;
  const look = `${settings.lighting}, one consistent colour grade, ${style}-style ${settings.camera} footage`;
  const casts = (input.castOptions ?? []).filter((c) => c.person?.trim() && c.setting?.trim());
  const cast = casts.length ? casts[(variant?.index ?? 0) % casts.length] : undefined;
  const groups = groupScenes(scenes, clipCount);

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
    const speech = group.continuation && group.continuation.part > 1 ? [] : speechLines(beats, clipSeconds);
    sections.push(
      speech.length
        ? [
            `[AUDIO] ${speech.join(" ")}`,
            "Speak exactly these Thai lines with natural Thai pronunciation and a relaxed conversational pace — do not translate, paraphrase or add any other spoken words.",
            speech.some((line) => line.includes("person on screen"))
              ? "The speaker's face is visible and lip-synced while talking; no fast head turns during the line."
              : "",
            "Soft background music kept low under the voice, natural room ambience.",
          ]
            .filter(Boolean)
            .join(" ")
        : "[AUDIO] No speech or voiceover — nobody talks. Natural ambient sound and light upbeat background music only.",
    );

    const motions = group.scenes.map((scene) => scene.cameraMotion?.trim()).filter(Boolean).join(", then ");
    const motion =
      motions || (longTake ? DEFAULT_CAMERA_MOTIONS.join(", then ") : DEFAULT_CAMERA_MOTIONS[Math.min(index, DEFAULT_CAMERA_MOTIONS.length - 1)]);
    sections.push(
      longTake
        ? `[CAMERA] ${motion}. Smooth, motivated camera moves; a clean cut between beats is fine, but no jarring jump cuts, and the person, product, location and lighting look identical in every shot.`
        : isFirst || clipCount === 1
        ? `[CAMERA] One continuous take with no cuts: ${motion}.`
        : `[CAMERA] Pick up the camera exactly where part ${index} ended — same position, direction, speed and height, no cut or reframe at the start — then ${motion}. One continuous take.`,
    );

    // Repeated runs of the same content would otherwise come back as near-identical videos.
    if (variant && variant.total > 1) {
      sections.push(
        cast && casts.length > 1
          ? `[VARIATION] Version ${variant.index + 1} of ${variant.total}: use a noticeably different camera angle and framing from the other versions while following the timeline above.`
          : `[VARIATION] Version ${variant.index + 1} of ${variant.total}: make it clearly different from the other versions — a different person, setting and camera angle — while keeping the same product and message.`,
      );
    }

    sections.push(onScreenTextRule(index, clipCount, text, clipSeconds));
    sections.push(
      "[AVOID] Product changing shape or colour, duplicate products, deformed hands or extra fingers, sudden face, clothing, location or lighting change" +
        (isFirst ? "" : ", a jump cut at the start") +
        (clipCount === 1 ? `, ending before ${clipSeconds} seconds, looping or replaying the opening` : "") +
        ", fake logos, watermarks, random English text.",
    );

    return {
      index,
      prompt: sections.join("\n"),
      startSecond: index * clipSeconds,
    };
  });
}
