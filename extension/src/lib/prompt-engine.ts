import { platformForStyle, salesContext, type PublishPlatform } from "./commerce.js";
/** Ported from src/lib/prompt-engine/{types,prompt-builder,clip-planner}.ts — pure functions, no server dependency. */

import { getStylePlaybook, assertSpeechFits, stylePerformance, styleCameraMotion, styleUsesOnScreenText, type PresenterMode, type SpeechAmount, type StylePlaybook } from "./style-playbooks.js";

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
  /** Missing on looks planned before presenters could be chosen; read from the person text then. */
  gender?: PresenterGender;
}

/** Gender of a look: the planner's own field, else the English description ("Thai woman …", "a man's hands …"). */
export function castGender(cast: CastLook): PresenterGender | undefined {
  if (cast.gender === "female" || cast.gender === "male") return cast.gender;
  if (/\b(woman|women|female|girl|lady|woman's)\b/i.test(cast.person)) return "female";
  if (/\b(man|men|male|guy|boy|man's)\b/i.test(cast.person)) return "male";
  return undefined;
}

/**
 * Looks for the chosen presenter, in planner order. Older plans may have no
 * look of that gender (or only ungendered hands) — then one is written here,
 * keeping the first plan's setting so the place still fits the storyboard.
 */
function castsFor(all: CastLook[], gender: PresenterGender | undefined, presenter: PresenterMode): CastLook[] {
  if (!gender) return all;
  const matching = all.filter((cast) => castGender(cast) === gender);
  if (matching.length) return matching;
  const setting = all[0]?.setting ?? "a bright, tidy Thai home by a window, soft daylight";
  const person = presenter === "hands"
    ? gender === "female"
      ? "hands only — a Thai woman's hands with short natural nails and plain sleeves"
      : "hands only — a Thai man's hands with short clean nails and plain sleeves"
    : gender === "female"
      ? "Thai woman in her late 20s, natural makeup, black hair, plain casual top"
      : "Thai man in his late 20s, short neat black hair, plain casual T-shirt";
  return [{ person, setting, gender }];
}

/**
 * Used when a scene plan has no camera directions: one simple move per part.
 * No orbits or arcs — when asked to circle a subject the video model tends to
 * spin the person (head turning 360°) instead of moving the camera.
 */
function defaultCameraMotions(presenter: PresenterMode): string[] {
  return presenter === "hands"
    ? [
        "slow gentle push-in towards the hands and the product",
        "steady close-up with a slight tilt down to the product in the hands",
        "gentle slow pull-back that settles on the product",
      ]
    : [
        "slow gentle push-in from a medium shot towards the person and the product",
        "steady medium close-up with a slight tilt down to the product in the hands",
        "gentle slow pull-back to a medium shot that settles on the product",
      ];
}

/**
 * Camera words that make the model rotate the subject or smear the frame.
 * A plan that asks for them gets a steady move instead.
 */
const UNSTABLE_CAMERA = /\b(orbit\w*|arcs?|arcing|circl\w*|360|spin\w*|rotat\w*|whip\w*|swirl\w*|around the (subject|person|product))\b/i;

function safeCameraMotion(motion: string | undefined, presenter: PresenterMode): string | undefined {
  const value = motion?.trim();
  if (!value) return undefined;
  return UNSTABLE_CAMERA.test(value) ? defaultCameraMotions(presenter)[0] : value;
}

/**
 * Anatomy and motion rules repeated in every part. Stated positively as well as
 * in [AVOID]: video models follow "what to do" far better than "what not to do".
 */
/**
 * What makes it read as a seller's own TikTok Shop video rather than a TV
 * advert or an AI render. Camera and light stay with the style.
 */
const REAL_AD_LOOK =
  "[REALISM] Believable materials, natural skin texture when visible, everyday surroundings appropriate to the style, and the product at its true scale. Keep the background uncluttered and the contact point visible; leave the outer edges clear for TikTok UI.";

function motionRules(presenter: PresenterMode): string {
  const framing =
    presenter === "hands"
      ? "Only the hands and forearms appear with the product — no face or head in frame."
      : presenter === "mixed" ? "The person looks at the task naturally; eye contact with the lens only when addressing it. Keep identity and anatomy stable." : "Natural eye contact while addressing the lens; look at the product while using it. Keep identity and anatomy stable.";
  return `[MOTION] Real-world physics at normal speed. One simple, slow, deliberate action at a time. ${framing} Hands grip the product naturally with correct anatomy; contact and movement follow real-world physics.`;
}

/** How much of the shot is filled with speech, per the style's speech amount. */
function pacingRule(speech: SpeechAmount, clipSeconds: number): string {
  return speech === "light"
    ? `Speak the lines softly at about 0.5 seconds and in between the product sounds, finishing by about ${Math.max(2, clipSeconds - 0.5)} seconds; calm pauses between lines are welcome so the natural sounds are heard.`
    : `Speak at a relaxed conversational pace, with breathing pauses and room for the product action. Finish by ${Math.max(2, clipSeconds - 1)} seconds; let the final result be seen without adding words.`;
}

/**
 * The clip's lines as the model should hear them. Numbered lines were spoken
 * as separate slogans with a reset between each, so consecutive lines from
 * the same speaker become one quoted monologue. Long single generations keep
 * per-line timing so each line lands on its beat; in short clips narrow
 * windows made the model rush.
 */
function scriptText(speech: SpeechLine[], clipSeconds: number): string {
  const who = (kind: SpeechLine["kind"]) => (kind === "dialogue" ? "The person on screen says in Thai" : "An off-screen narrator says in Thai");
  if (clipSeconds > 10) {
    return speech
      .map((line, i) => `${speech.length > 1 ? `${i + 1}) ` : ""}[${line.start}-${line.end}s] ${who(line.kind)}: ${quoteExact(line.text)}`)
      .join(" ");
  }
  const blocks: { kind: SpeechLine["kind"]; text: string }[] = [];
  for (const line of speech) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === line.kind) last.text = `${last.text} ${line.text}`;
    else blocks.push({ kind: line.kind, text: line.text });
  }
  return blocks
    .map((block, i) => `${blocks.length > 1 ? `${i + 1}) ` : ""}${who(block.kind)}, as one natural continuous monologue: ${quoteExact(block.text)}`)
    .join(" ");
}

/** Separately rendered parts otherwise each sound like a fresh video: a new greeting, a new pitch, a goodbye. */
function talkFlow(index: number, clipCount: number): string {
  if (clipCount === 1) return "";
  const parts = [
    index > 0
      ? `The talk is already under way: this part picks up the same story mid-flow from part ${index} — no greeting, no re-introducing the product, just the next sentences.`
      : "",
    index < clipCount - 1 ? "Do not wrap up or say goodbye — the talk continues in the next part." : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** Rules that stop the model rushing, mangling or repeating Thai speech; tone and sound come from the style. */
function voiceRules(clipSeconds: number, clipCount: number, onScreen: boolean, playbook: StylePlaybook, gender?: PresenterGender): string {
  return [
    `Voice: ${gender === "female" ? "a native Thai woman — the presenter's own voice —" : gender === "male" ? "a native Thai man — the presenter's own voice —" : "a native Thai speaker"} with a clear standard Central Thai (Bangkok) accent and correct Thai tones, pronouncing every syllable fully at a relaxed conversational pace — not rushed, not robotic, not sing-song.`,
    clipCount > 1 ? "Use the same voice (timbre, pitch and accent) as in the other parts of this advert." : "",
    "Speak the quoted Thai exactly as written, word for word, with the sentences flowing into each other as one connected thought in natural spoken Thai intonation — like telling a friend, not reading a list of slogans.",
    // Garbled Thai is mostly wrong tones, clipped final consonants and brand names read in English.
    pacingRule(playbook.speech, clipSeconds),
    `Delivery: ${playbook.delivery}; any energy comes from tone and emphasis, never from speed, so every word stays clear — never shouting and never an over-the-top announcer.`,
    "Say each line ONLY ONCE: no repeating, no second take, no echo, no filler sounds, no extra or English words.",
    onScreen
      ? "Lips move in sync only while the words are spoken and the mouth rests closed or smiling when silent; keep the face towards the camera and the head steady while talking."
      : "",
    `Sound: ${playbook.soundBed}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Flow and AI Studio render 8 seconds per generation. */
export const CLIP_SECONDS = 8;

/** A video is joined from at most this many clips. */
export const MAX_CLIPS = 4;

export type GenerationSite = "aistudio" | "flow" | "gemini" | "meta";

/**
 * Gemini's video tool renders the whole advert in one generation when the
 * prompt asks for its length, so it is never split into joined parts.
 */
export const GEMINI_DURATIONS = [10, 20];

/**
 * Meta AI renders 10 seconds per scene whatever length the prompt asks for —
 * measured on a finished reply (two clips, 10.0s each, 720x1280), and Meta
 * says the same in chat. Asking for 8 got 10 anyway, so the plan is written
 * in 10-second parts and the joined lengths follow from that.
 */
export const META_CLIP_SECONDS = 10;

/**
 * Seconds one generation renders on each site. Flow and AI Studio always make
 * 8-second clips; on Gemini one generation is the whole video, so it is the
 * requested length (snapped to a length Gemini makes). Meta AI makes every
 * scene of the advert from a single prompt and renders each one as a
 * 10-second clip, which the parts are then joined from.
 */
export function clipSecondsForSite(site: string | undefined, targetDuration?: number): number {
  if (site === "meta") return META_CLIP_SECONDS;
  if (site !== "gemini") return CLIP_SECONDS;
  const wanted = targetDuration || GEMINI_DURATIONS[0];
  return GEMINI_DURATIONS.reduce((best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best));
}

/** The lengths a site can make: one to four joined clips — or on Gemini, one generation of each length. */
export function durationOptions(site: string | undefined): number[] {
  if (site === "gemini") return [...GEMINI_DURATIONS];
  const clipSeconds = site === "meta" ? META_CLIP_SECONDS : CLIP_SECONDS;
  return Array.from({ length: MAX_CLIPS }, (_, i) => (i + 1) * clipSeconds);
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

export type PresenterGender = "female" | "male";

/** Thai question words: a woman ends a question with คะ, a statement with ค่ะ. */
const THAI_QUESTION = /(ไหม(?!้)|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|อะไร|ยังไง|อย่างไร|ทำไม|ที่ไหน|ไหน|เท่าไหร่|เท่าไร|กี่|ใคร|เมื่อไหร่)/;

/**
 * Scripts are written before the presenter is chosen, so the polite particle
 * is matched to the speaker here. Only particles change — never pronouns
 * (ผม also means hair) — and only at a word boundary, so คะแนน survives.
 */
export function politeParticles(text: string, gender: PresenterGender): string {
  const boundary = "(?=[\\s!?,.]|$)";
  if (gender === "male") {
    return text.replace(new RegExp(`(?:ค่ะ|คะ)${boundary}`, "g"), "ครับ");
  }
  return text
    .replace(new RegExp(`ครับผม${boundary}`, "g"), "ครับ")
    .replace(new RegExp(`ครับ${boundary}`, "g"), (_match, offset: number, whole: string) => {
      if (whole.slice(Math.max(0, offset - 2), offset) === "นะ") return "คะ";
      const clause = whole.slice(0, offset).split(/[\s!?,.]/).pop() ?? "";
      const asked = whole[offset + 4] === "?" || THAI_QUESTION.test(clause);
      return asked ? "คะ" : "ค่ะ";
    });
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
  "[ON-SCREEN TEXT] None. Nothing is written over the video — no captions, subtitles, titles, stickers, signs, handwriting or made-up letters in any alphabet; the only printing in the frame is the product's own logo and label exactly as in the product photo. The spoken Thai lines are heard only and are never written on screen.";

/**
 * The label must look like the photo, but asking for its lettering invites
 * made-up Thai glyphs — so copy the design, never re-letter it, and stay out
 * of small-print close-ups.
 */
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
 * Spoken lines for one clip, in order; reject overflow without dropping sentences.
 * `spoken` holds lines earlier clips already say, so a line the plan put in
 * two clips is heard once rather than twice in the joined video.
 */
function speechLines(
  beats: ReturnType<typeof timeline>,
  clipSeconds: number,
  spoken: Set<string>,
  playbook: StylePlaybook,
  gender?: PresenterGender,
): SpeechLine[] {
  if (playbook.speech === "silent") return [];
  const lines: SpeechLine[] = [];
  for (const { start, end, scene } of beats) {
    for (const [kind, raw] of [["dialogue", scene.dialogue], ["voiceover", scene.voiceover]] as const) {
      const plain = speakableThai(raw);
      const text = gender ? politeParticles(plain, gender) : plain;
      if (!text || spoken.has(text) || lines.some((line) => line.text === text)) continue;
      lines.push({ kind, text, start, end });
    }
  }
  // No face in a hands-only style, so even older on-screen dialogue is narrated off screen.
  if (playbook.presenter === "hands") lines.forEach((line) => (line.kind = "voiceover"));
  // Reject overflow before spending video credits; never silently discard a sentence.
  assertSpeechFits(lines.map((line) => line.text).join(" "), clipSeconds, playbook.speech);
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
  /** Who presents this video; picks a look of that gender and matches voice and ครับ/ค่ะ to it. */
  presenter?: PresenterGender;
  /** English description of the product as it looks in its photo (missing on older scene plans). */
  productLook?: string;
  platform?: PublishPlatform;
}

/**
 * Repeated in every part so the product stays the same even when the photo
 * could not be attached, or a later part only sees the part before it.
 */
function productRule(productName: string, productLook: string | undefined): string {
  const look = productLook?.trim().replace(/[.。]$/, "");
  return [
    `[PRODUCT] ${productName}.`,
    look ? `Exact appearance, identical in every frame: ${look}.` : "",
    "Exactly one unit of this same product throughout. It keeps the same shape, proportions, size, colours, material and label design in every frame, never morphs or changes, and is never replaced by a generic, similar or redesigned item.",
    "Show it clearly in good light with its front and logo towards the camera; hands never cover the logo or the front label.",
  ]
    .filter(Boolean)
    .join(" ");
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
  const platform = platformForStyle(style, input.platform);
  const destination = platform === "shopee" ? "Shopee Video" : "TikTok";
  const text = styleUsesOnScreenText(style) ? input.text : undefined;
  // Camera, light, voice and sound come from the style, so a POV or ASMR advert is not shot like a talking-head UGC one.
  const playbook = getStylePlaybook(style);
  const look = `${playbook.lighting}, one consistent colour grade, ${style}-style footage shot with a ${playbook.camera}`;
  const hands = playbook.presenter === "hands";
  const planned = (input.castOptions ?? []).filter((c) => c.person?.trim() && c.setting?.trim());
  const casts = castsFor(planned, input.presenter, playbook.presenter);
  const cast = casts.length ? casts[(variant?.index ?? 0) % casts.length] : undefined;
  const gender = input.presenter ?? (cast ? castGender(cast) : undefined);
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
        ? `[GOAL] Create exactly one ${clipSeconds}-second video segment: part ${index + 1} of ${clipCount} of ONE continuous ${clipCount * clipSeconds}-second ${style}-style ${destination} advert that will be joined into a single video.`
        : `[GOAL] Create ONE complete ${clipSeconds}-second ${style}-style ${destination} advert as a single video that runs the full ${clipSeconds} seconds from start to finish — not a shorter clip, not split into parts. An attention-grabbing hook in the first 2 seconds, then the product in use, then a clear ending on the product.`,
    );
    sections.push(
      `[FORMAT] ${describeAspectRatio(settings.aspectRatio)} video. ${look}. Sharp focus, natural motion, realistic hands and faces.`,
    );
    sections.push(productRule(productName, input.productLook));
    sections.push(`[STYLE EXECUTION] ${playbook.videoDirection}.`);
    sections.push(REAL_AD_LOOK.replace("TikTok UI", `${destination} UI`));
    if (platform === "shopee") sections.push(`[SALES CONTEXT] ${salesContext(style)}. Show a confident seller and a real, simple product demonstration. No fabricated discounts, factory-origin claims, fake livestream overlays, viewer counters, watermarks or TikTok branding.`);

    if (cast) {
      sections.push(
        hands
          ? `[CAST] ${cast.person}. Only these hands are seen — the same hands, nails and sleeves in every part, and never a face.`
          : `[CAST] ${cast.person}. Exactly this person and wardrobe in every part — same face, hair, body and clothes.`,
      );
      sections.push(`[SETTING] ${cast.setting}. Same location, time of day and light direction in every part.`);
    } else if (longTake) {
      sections.push(
        hands
          ? "[CAST & SETTING] One pair of hands, one set of sleeves and one location for the whole video — hands, sleeves, time of day and light direction never change."
          : "[CAST & SETTING] One person, one wardrobe and one location for the whole video — face, hair, clothes, time of day and light direction never change.",
      );
    } else if (clipCount > 1) {
      sections.push(
        isFirst
          ? `[CAST & SETTING] Establish ${hands ? "one pair of hands, sleeves" : "one person, wardrobe"} and location that every later part must keep.`
          : `[CAST & SETTING] Identical ${hands ? "hands, nails, sleeves" : "person (face, hair, body), wardrobe"}, location, time of day and light direction as part ${index}.`,
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
    const speech = group.continuation && group.continuation.part > 1 ? [] : speechLines(beats, clipSeconds, spoken, playbook, gender);
    speech.forEach((line) => spoken.add(line.text));
    const onScreenSpeaker = speech.some((line) => line.kind === "dialogue");
    sections.push(
      speech.length
        ? [
            `[AUDIO] The complete spoken script for this ${clipCount === 1 ? "video" : "part"}, in this order:`,
            scriptText(speech, clipSeconds),
            talkFlow(index, clipCount),
            voiceRules(clipSeconds, clipCount, onScreenSpeaker, playbook, gender),
          ].join(" ")
        : `[AUDIO] No dialogue or narration. ${playbook.soundBed}.`,
    );

    sections.push(motionRules(playbook.presenter));
    sections.push(`[PERFORMANCE] ${stylePerformance(style)}`);

    const motions = group.scenes.map((scene) => safeCameraMotion(scene.cameraMotion, playbook.presenter)).find(Boolean);
    const subject = playbook.presenter === "hands" ? "the hands and the product" : "the same person and product";
    const noSpin = playbook.presenter === "hands" ? "the product is not spun around" : "the person does not spin or turn around";
    const motion = styleCameraMotion(style, motions);
    sections.push(
      longTake
        ? `[CAMERA] ${motion}. Slow, stable, motivated camera moves; a clean cut between beats is fine, but no jarring jump cuts, and ${playbook.presenter === "hands" ? "the hands" : "the person"}, product, location and lighting look identical in every shot.`
        : isFirst || clipCount === 1
        ? `[CAMERA] One continuous, stable take with no cuts: ${motion}. The camera moves slowly; ${noSpin}.`
        : `[CAMERA] Open on a calm, steady shot of ${subject}, continuing naturally from the end of part ${index}, then ${motion}. One continuous, stable take; ${noSpin}.`,
    );

    // Repeated runs of the same content would otherwise come back as near-identical videos.
    if (variant && variant.total > 1) {
      sections.push(
        // A fixed [CAST] line already names the person, so only the framing can change.
        cast
          ? `[VARIATION] Version ${variant.index + 1} of ${variant.total}: use a noticeably different camera angle and framing from the other versions while following the timeline above.`
          : `[VARIATION] Version ${variant.index + 1} of ${variant.total}: make it clearly different from the other versions — ${hands ? "different hands styling" : "a different person"}, setting and camera angle — while keeping the same product and message.`,
      );
    }

    const onScreen = onScreenTextRule(index, clipCount, text);
    sections.push(onScreen.rule);
    sections.push(
      "[AVOID] Deformed anatomy, impossible contact, product redesign or morphing, duplicate copies of the advertised product, unstable camera, sudden identity or lighting changes, replayed actions, repeated words, garbled speech, lip movement without dialogue, watermarks, " + textAvoidList(onScreen.hasText) + ".",
    );

    return {
      index,
      prompt: sections.join("\n"),
      startSecond: index * clipSeconds,
    };
  });
}
