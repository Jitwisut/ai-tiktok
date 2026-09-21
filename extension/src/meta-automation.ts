// NOTE: shares one TypeScript global scope with the other extension scripts
// (Chrome loads them as classic scripts), so every top-level name here is
// prefixed with "meta" to stay unique.
//
// Drives the video generation in Meta AI's chat (meta.ai / www.meta.ai).
//
// What makes this site different from Gemini and Flow: one prompt can ask for
// several scenes and Meta answers with all of them in the same reply. So this
// file does NOT loop "submit → wait for one clip → submit again" the way
// gemini-automation.ts does — it joins every clip of the job into a single
// numbered prompt, sends it once, and then collects the videos that come back.
//
// Getting the files back is straightforward, once measured on a real reply:
// each generated clip is a <video> whose src is a plain https file on
// scontent.xx.fbcdn.net, laid out in scene order — so the players themselves
// say which file is which scene. (Meta's Vibes feed streams through
// MediaSource with an unfetchable blob: src instead; the Resource Timing
// fallback below covers a reply that ever renders that way.) Those files are
// CORS-readable only WITHOUT credentials — `credentials: "include"` fails —
// which is why metaUploadClip omits them.
interface MetaClip {
  index: number;
  prompt: string;
}

interface MetaVideoJob {
  videoId: string;
  clips: MetaClip[];
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

/** Seconds Meta renders per scene — measured on a finished reply (10.0s, 720x1280). Mirrors META_CLIP_SECONDS in prompt-engine.ts, which this classic script cannot import. */
const META_CLIP_SECONDS = 10;

const META_MAX_WAIT_MS = 15 * 60 * 1000;
const META_POLL_MS = 3000;
/**
 * Polls in a row with nothing new — no extra video, no extra text — before a
 * reply that already produced some videos is taken as finished.
 *
 * Mostly belt and braces: a measured two-scene run kept its stop button up
 * for the whole render (~160 seconds, still "generating" at every check until
 * both videos were on screen), so metaIsGenerating covers the silence on its
 * own and this counter only advances once Meta looks finished. It stays
 * generous anyway — cutting it short would save scene 1 and throw away a
 * scene 2 that was still rendering.
 */
const META_IDLE_POLLS_BEFORE_DONE = 40;
/** Seconds of quiet before a reply that produced no video at all is read as a refusal. */
const META_IDLE_POLLS_BEFORE_FAIL = 8;
const META_UPLOAD_TIMEOUT_MS = 120_000;

let metaJobRunning = false;
let metaCancelled = false;

/* ---------- panel / progress ---------- */

function metaShowBanner(text: string, color: string) {
  aiPanelStatus(text, color === "#111827" ? "#e5e7eb" : color);

  const id = "ai-affiliate-meta-banner";
  document.getElementById(id)?.remove();
  const banner = document.createElement("div");
  banner.id = id;
  banner.textContent = text;
  Object.assign(banner.style, {
    position: "fixed",
    top: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    padding: "10px 16px",
    borderRadius: "8px",
    background: color,
    color: "#fff",
    fontFamily: "sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    maxWidth: "80vw",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(banner);
}

/** `error` travels with a failure so autopilot can tell a quota lock from a one-off failure. */
function metaReportProgress(videoId: string, current: number, total: number, state: string, error?: string) {
  try {
    chrome.storage.local.set({ jobProgress: { videoId, current, total, state, error, at: Date.now() } }).catch(() => {});
  } catch {
    // context already gone
  }
}

async function metaWaitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (metaCancelled) return undefined;
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

const metaSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- page elements ---------- */

/**
 * The prompt box. Signed in, Meta AI's composer is a Lexical rich-text
 * editor — a contenteditable div — and the page ALSO carries a dead
 * <textarea placeholder="Ask Meta AI..."> that it renders before hydration.
 * That textarea takes text happily and sends nothing, so the editor is
 * looked for first and the prehydration input is excluded by name. (Signed
 * out the composer really is an <input>, which is the last fallback.)
 */
function metaComposer(): HTMLElement | null {
  // Both the live editor and the dead prehydration textarea carry
  // data-testid="composer-input", so the textarea is excluded by name.
  const byTestId = document.querySelector<HTMLElement>(
    '[data-testid="composer-input"]:not([data-ecto-composer-prehydration-input])',
  );
  if (byTestId) return byTestId;

  const editor = document.querySelector<HTMLElement>(
    'div[contenteditable="true"][data-lexical-editor], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]',
  );
  if (editor) return editor;

  const live = (el: HTMLElement | null) => (el && !el.hasAttribute("data-ecto-composer-prehydration-input") ? el : null);
  const byLabel = live(
    document.querySelector<HTMLElement>(
      'input[aria-label*="Meta AI" i], textarea[aria-label*="Meta AI" i], input[placeholder*="Meta AI" i], textarea[placeholder*="Meta AI" i]',
    ),
  );
  if (byLabel) return byLabel;
  const main = document.querySelector("main") ?? document.body;
  return (
    live(main.querySelector<HTMLElement>('textarea:not([readonly])')) ??
    live(main.querySelector<HTMLElement>('input[type="text"]:not([readonly])'))
  );
}

/**
 * The send button. `aria-label="Send"` follows the account's UI language, so
 * fall back to the last enabled button sitting next to the composer.
 */
function metaSendButton(): HTMLButtonElement | null {
  const byTestId = document.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]');
  if (byTestId) return byTestId;

  const labelled = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((button) =>
    /^(send|ส่ง)/i.test(button.getAttribute("aria-label") ?? ""),
  );
  if (labelled) return labelled;

  const composer = metaComposer();
  const row = composer?.closest("form") ?? composer?.parentElement?.parentElement ?? null;
  const buttons = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter(
    (button) => !/attach|upload|แนบ|เพิ่ม/i.test(button.getAttribute("aria-label") ?? ""),
  );
  return buttons[buttons.length - 1] ?? null;
}

/** While a reply is streaming the send button turns into a stop button. */
/**
 * True while Meta is still working. Measured: the stop button stays up for
 * the whole render, not just while the text streams — and it is not always
 * the composer's own send button, so both are checked.
 */
function metaIsGenerating(): boolean {
  const isStop = (el: Element | null) => /^(stop|หยุด)/i.test(el?.getAttribute("aria-label") ?? "");
  if (isStop(document.querySelector('[data-testid="composer-send-button"]'))) return true;
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).some(isStop);
}

function metaConversationText(): string {
  return (document.querySelector<HTMLElement>("main") ?? document.body).innerText ?? "";
}

/**
 * What Meta wrote back, without the prompt we sent. `fallbackFrom` is the
 * length the conversation had at submit time, used only if the reply is not
 * marked up with the test id this reads first.
 */
function metaReplyText(fallbackFrom: number): string {
  const messages = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"]'));
  if (messages.length) return messages.map((message) => message.innerText ?? "").join("\n");
  return metaConversationText().slice(fallbackFrom);
}

function metaVideoCount(): number {
  return document.querySelectorAll("video").length;
}

/**
 * The generated files, in scene order.
 *
 * Measured on a signed-in reply: the two clips are ordinary <video> elements
 * with direct https sources, in the order Meta wrote them, so the players are
 * the mapping — no guessing which file belongs to which scene. Every video on
 * the page counts, which is exactly why a job runs in a fresh chat
 * (dispatchMetaJob in background.ts) where the only ones present are its own.
 *
 * The Resource Timing sweep behind it is for a reply that streams instead
 * (a blob: src the element cannot hand over); `sinceMark` is a
 * performance.now() reading taken just before the prompt was sent, so the
 * page's own boot traffic is left out.
 */
function metaVideoFileUrls(sinceMark: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (!/^https?:/i.test(raw)) return;
    let key = raw;
    try {
      // The same file can be fetched in byte ranges; one entry per file is wanted.
      const url = new URL(raw, location.href);
      key = url.origin + url.pathname;
    } catch {
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(raw);
  };

  // Scoped to the assistant's messages: Meta puts unrelated players elsewhere
  // in its pages (the Vibes feed is nothing but those), and one of those
  // landing in this list would be saved as a scene of the advert.
  const messages = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"]'));
  const players = messages.length
    ? messages.flatMap((message) => Array.from(message.querySelectorAll<HTMLVideoElement>("video")))
    : Array.from(document.querySelectorAll<HTMLVideoElement>("video")).filter((video) =>
        /\.fbcdn\.net$/i.test(new URL(video.currentSrc || "https://x/", location.href).hostname),
      );
  for (const video of players) add(video.currentSrc || video.getAttribute("src") || "");

  const timed = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.startTime >= sinceMark && /\.mp4(\?|$)/i.test(entry.name))
    .sort((a, b) => a.startTime - b.startTime);
  for (const entry of timed) add(entry.name);

  return urls;
}

/* ---------- composer actions ---------- */

/**
 * React keeps the composer's value in its own state, so assigning `.value`
 * leaves the send button disabled — the value has to go through the native
 * setter and be announced with an input event. (Verified on meta.ai: after
 * this the send button's `disabled` attribute clears.)
 */
function metaWritePrompt(text: string): boolean {
  const composer = metaComposer();
  if (!composer) return false;
  // The composer is a single-line input: a newline either does nothing or sends.
  const line = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  composer.focus();

  if (composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement) {
    const prototype = composer instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(composer, line);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return composer.value.trim().length > 0;
  }

  // Lexical ignores a "delete" on a full selection (the box keeps its old
  // text and the prompt lands appended to it), but an insertText over that
  // same selection replaces the lot — so this is one call, not clear-then-type.
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, line);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return (composer.innerText ?? "").trim().length > 0;
}

/** Clicks a button through the DevTools protocol when the page ignores synthetic events. */
function metaTrustedClick(selector: string, bringToFront: boolean): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", selector, bringToFront }, (result: { ok: boolean; error?: string } | undefined) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(result ?? { ok: false, error: "no response" });
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Sent is judged by the composer emptying (Meta clears it as the message
 * goes) or by a stop button appearing — not by the answer, which only starts
 * seconds later.
 */
async function metaSubmit(): Promise<boolean> {
  const composerText = () => {
    const composer = metaComposer();
    if (!composer) return "";
    return composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
      ? composer.value
      : composer.innerText ?? "";
  };
  const before = composerText().trim().length;
  const sent = () => (composerText().trim().length < before / 2 || metaIsGenerating() ? true : undefined);

  const button = metaSendButton();
  if (button && !button.disabled) {
    const rect = button.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    button.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mousedown", at));
    button.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mouseup", at));
    button.click();
    if (await metaWaitFor(sent, 5000, 300)) return true;
  }

  // Enter in the composer is the other way the page sends a message.
  const composer = metaComposer();
  if (composer) {
    composer.focus();
    for (const type of ["keydown", "keypress", "keyup"] as const) {
      composer.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    if (await metaWaitFor(sent, 5000, 300)) return true;
  }

  for (const bringToFront of [false, true]) {
    if (sent()) return true;
    const click = await metaTrustedClick('button[aria-label="Send"], button[aria-label="ส่ง"]', bringToFront);
    if (!click.ok) {
      if (sent()) return true;
      metaShowBanner(`กดส่งไม่สำเร็จ: ${click.error ?? "unknown"}`, "#dc2626");
      return false;
    }
    if (await metaWaitFor(sent, 15000, 500)) return true;
  }
  return false;
}

/* ---------- attaching the product photo ---------- */

function metaBase64ToFile(base64: string, mimeType: string, name: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mimeType });
}

/**
 * Meta's "Add attachment" opens the OS file dialog, which an extension cannot
 * drive — but the menu behind it puts a real <input type="file"> in the page,
 * and files can be handed to that directly. A paste into the composer is
 * tried first because it needs no menu at all. Returns false when neither
 * works; the job then runs on the written prompt alone.
 */
async function metaAttachImage(job: MetaVideoJob): Promise<boolean> {
  if (!job.imageBase64) return false;
  const mimeType = /^image\/(png|jpeg|webp)/.test(job.imageMimeType ?? "") ? job.imageMimeType!.split(";")[0] : "image/jpeg";
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const file = metaBase64ToFile(job.imageBase64, mimeType, `product-${job.videoId.slice(0, 8)}.${extension}`);
  const before = metaAttachmentCount();

  const composer = metaComposer();
  if (composer) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    composer.focus();
    composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    if (await metaWaitFor(() => (metaAttachmentCount() > before ? true : undefined), 8000, 300)) return true;
  }

  // Signed in, Meta keeps a real <input type="file"> in the composer, so the
  // file can go straight to it; the menu is only opened when it is missing.
  let input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    const menu = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((button) =>
      /attach|upload|photo|image|แนบ|รูป/i.test(button.getAttribute("aria-label") ?? ""),
    );
    menu?.click();
    input = (await metaWaitFor(() => document.querySelector<HTMLInputElement>('input[type="file"]') ?? undefined, 6000, 300)) ?? null;
    document.body.click(); // close the menu again, whether or not the input turned up
  }
  if (!input) return false;

  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return !!(await metaWaitFor(() => (metaAttachmentCount() > before ? true : undefined), 20000, 500));
}

/** Attached images show as thumbnails above the composer; counted to tell an upload that worked from one that did not. */
function metaAttachmentCount(): number {
  const composer = metaComposer();
  const row = composer?.closest("form") ?? composer?.parentElement?.parentElement?.parentElement ?? null;
  return row?.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length ?? 0;
}

/* ---------- the one multi-scene prompt ---------- */

/**
 * Every clip of the job in ONE prompt. This is the whole point of using Meta
 * AI: asking for "2 scenes" returns both videos from a single request instead
 * of one generation per scene.
 */
function metaComposePrompt(job: MetaVideoJob, imageAttached: boolean): string {
  const total = job.clips.length;
  const orientation = job.aspectRatio === "16:9" ? "16:9 landscape (horizontal)" : "9:16 portrait (vertical)";
  // Stated, not derived: Meta renders a 10-second clip per scene whatever the
  // prompt asks for (asking for 8 still returned 10.0s), so a job planned on
  // an older 8-second grid must not tell it something different.
  const seconds = META_CLIP_SECONDS;

  const header =
    total > 1
      ? [
          `Generate ${total} separate videos in this one reply — one video per SCENE below, in the same order, numbered 1 to ${total}.`,
          `Every video is ${orientation}, about ${seconds} seconds long, with spoken Thai audio.`,
          `Produce all ${total} videos: do not merge the scenes into a single video, do not stop after the first one, and do not ask me which scene to start with.`,
          `The ${total} scenes are consecutive parts of ONE advert, so keep the same person, face, wardrobe, location, lighting, camera style and product in all of them — each scene continues from the end of the one before it without replaying it.`,
        ].join(" ")
      : `Generate one ${orientation} video, about ${seconds} seconds long, with spoken Thai audio.`;

  const productReference = imageAttached
    ? " The attached photo shows the exact product being advertised: the product in every video must match it — same shape, colours, pattern, material and packaging design — and must not be replaced by a similar or generic item. Use the photo only as the product reference, not as an opening frame or background. No other brand's logo or packaging may appear."
    : "";

  const scenes = job.clips
    .map((clip, index) => `=== SCENE ${index + 1} OF ${total} === ${clip.prompt}`)
    .join(" ");

  return `${header}${productReference} ${scenes}`;
}

/* ---------- waiting for the videos ---------- */

/**
 * A recognised quota or policy reply, or undefined when the text says
 * neither. `text` must be the reply alone: the prompt sits in the same
 * conversation and is full of instruction words, so classifying the whole
 * page would let our own wording be read back as Meta's refusal.
 */
function metaClassifyRefusal(text: string): string | undefined {
  const reply = text.trim().slice(-300);
  if (/limit|quota|ขีดจำกัด|ครบ|โควต้า|try again later|ภายหลัง|upgrade|อัปเกรด|too many/i.test(reply)) {
    return `โควต้า: Meta AI สร้างวิดีโอเพิ่มไม่ได้ตอนนี้ — ${reply.slice(-200)}`;
  }
  if (/polic|guideline|นโยบาย|หลักเกณฑ์|can't (create|make|generate|help)|cannot (create|make|generate|help)|unable to (create|make|generate)|ไม่สามารถ|ช่วยเรื่องนี้ไม่ได้/i.test(reply)) {
    return `นโยบาย: Meta AI ไม่สร้างคลิปนี้ — ${reply.slice(-200)}`;
  }
  return undefined;
}

type MetaOutcome = { urls: string[] } | { error: string };

/**
 * Waits for the reply's videos. Meta streams them in one at a time, so the
 * wait ends when all `expected` files have been requested — or, when fewer
 * came back, once the reply has been quiet long enough to call it finished.
 * A short answer is still worth keeping: the scenes that did render have
 * already cost the account's video allowance.
 */
async function metaWaitForVideos(videoId: string, expected: number, sinceMark: number): Promise<MetaOutcome> {
  let idlePolls = 0;
  let lastSignature = "";
  let announced = 0;
  let lastReport = 0;
  // Everything on screen right now is the prompt we just sent; the reply is
  // whatever gets added after it.
  const promptLength = metaConversationText().length;
  const replyText = () => metaReplyText(promptLength);

  const outcome = await metaWaitFor<MetaOutcome>(
    () => {
      const urls = metaVideoFileUrls(sinceMark);
      if (urls.length >= expected) return { urls: urls.slice(0, expected) };

      if (urls.length > announced) {
        announced = urls.length;
        metaShowBanner(`AI Affiliate Studio: Meta AI ส่งวิดีโอมาแล้ว ${urls.length}/${expected} ฉาก — ห้ามปิดแท็บนี้`, "#111827");
      }
      // A render can outlast the window autopilot uses to tell a live job from
      // an abandoned one, so keep stamping the progress record while waiting.
      if (Date.now() - lastReport > 60_000) {
        lastReport = Date.now();
        metaReportProgress(videoId, urls.length, expected, "generating");
      }

      const signature = `${urls.length}|${metaVideoCount()}|${metaConversationText().length}`;
      if (metaIsGenerating() || signature !== lastSignature) {
        lastSignature = signature;
        idlePolls = 0;
        return undefined;
      }
      idlePolls += 1;

      if (urls.length > 0) {
        // Some scenes arrived: give the rest a while, then keep what there is.
        return idlePolls >= META_IDLE_POLLS_BEFORE_DONE ? { urls } : undefined;
      }
      if (idlePolls < META_IDLE_POLLS_BEFORE_FAIL) return undefined;
      const refusal = metaClassifyRefusal(replyText());
      return refusal ? { error: refusal } : undefined;
    },
    META_MAX_WAIT_MS,
    META_POLL_MS,
  );

  if (metaCancelled) return { error: "ยกเลิกงานแล้ว" };
  return (
    outcome ?? {
      error: "รอวิดีโอจาก Meta AI นานเกินไป — เช็คที่หน้า Meta AI ว่ายังสร้างอยู่หรือเปล่า",
    }
  );
}

/* ---------- saving the clips ---------- */

type MetaUploadResult = { ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } };

function metaSendWithTimeout(message: object): Promise<MetaUploadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: MetaUploadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, error: "อัปโหลดไม่ตอบสนองภายในเวลาที่กำหนด" }), META_UPLOAD_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, (result: MetaUploadResult | undefined) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          settle({ ok: false, error: chrome.runtime.lastError.message ?? "ส่งข้อความไม่สำเร็จ" });
          return;
        }
        settle(result ?? { ok: false, error: "no response" });
      });
    } catch (err) {
      clearTimeout(timer);
      settle({ ok: false, error: err instanceof Error ? err.message : "ส่งข้อความไม่สำเร็จ" });
    }
  });
}

/**
 * fbcdn answers this page's request only WITHOUT credentials — sending
 * cookies turns it into a CORS failure (measured on meta.ai). If the fetch
 * fails anyway, the worker can fetch the URL itself, where no CORS applies.
 */
async function metaUploadClip(videoId: string, src: string, clipIndex: number, clipTotal: number): Promise<MetaUploadResult> {
  try {
    const res = await fetch(src, { credentials: "omit" });
    if (res.ok) {
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return metaSendWithTimeout({
        type: "UPLOAD_VIDEO",
        videoId,
        base64: btoa(binary),
        mimeType: "video/mp4",
        clipIndex,
        clipTotal,
      });
    }
  } catch {
    // fall through to the worker
  }
  return metaSendWithTimeout({ type: "FETCH_AND_UPLOAD_VIDEO", videoId, url: src, clipIndex, clipTotal });
}

/* ---------- the job ---------- */

async function metaRunJob(job: MetaVideoJob) {
  const total = job.clips.length;

  await metaWaitFor(() => (metaIsGenerating() ? undefined : true), 60000, 1000);
  // Measured on a signed-in page: the Lexical composer only replaces the
  // prehydration textarea around 15 seconds in, so this wait is generous.
  const composer = await metaWaitFor(() => metaComposer() ?? undefined, 45000, 500);
  if (!composer) {
    metaReportProgress(job.videoId, 0, total, "failed", "ไม่พบช่องพิมพ์บนหน้า Meta AI");
    metaShowBanner("ไม่พบช่องพิมพ์บนหน้า Meta AI — ล็อกอิน meta.ai ในแท็บนี้ก่อน แล้วลองใหม่", "#dc2626");
    return;
  }

  metaReportProgress(job.videoId, 0, total, "generating");

  let imageAttached = false;
  if (job.imageBase64) {
    metaShowBanner("AI Affiliate Studio: กำลังแนบรูปสินค้าใน Meta AI...", "#111827");
    imageAttached = await metaAttachImage(job);
    if (!imageAttached) metaShowBanner("แนบรูปสินค้าไม่สำเร็จ — สร้างต่อจากข้อความอย่างเดียว (สินค้าในคลิปอาจไม่ตรง)", "#d97706");
  }

  metaShowBanner(
    total > 1
      ? `AI Affiliate Studio: กำลังสั่ง Meta AI สร้าง ${total} ฉากในครั้งเดียว...`
      : "AI Affiliate Studio: กำลังสั่ง Meta AI สร้างวิดีโอ...",
    "#111827",
  );
  if (!metaWritePrompt(metaComposePrompt(job, imageAttached))) {
    metaReportProgress(job.videoId, 0, total, "failed", "ใส่ prompt ลงช่องของ Meta AI ไม่สำเร็จ");
    metaShowBanner("ใส่ prompt ลงช่องของ Meta AI ไม่สำเร็จ", "#dc2626");
    return;
  }
  await metaSleep(800);

  // Taken before sending: everything requested from here on belongs to this job.
  const mark = performance.now();
  if (!(await metaSubmit())) {
    metaReportProgress(job.videoId, 0, total, "failed", "ส่ง prompt ไม่สำเร็จ");
    metaShowBanner("ส่ง prompt ไม่สำเร็จ — ลองกดส่งเองในหน้า Meta AI ได้ prompt ใส่ไว้ให้แล้ว", "#dc2626");
    return;
  }

  metaShowBanner(
    total > 1
      ? `AI Affiliate Studio: Meta AI กำลังสร้าง ${total} ฉาก — ห้ามปิดหรือรีเฟรชแท็บนี้`
      : "AI Affiliate Studio: Meta AI กำลังสร้างวิดีโอ — ห้ามปิดหรือรีเฟรชแท็บนี้",
    "#111827",
  );

  const outcome = await metaWaitForVideos(job.videoId, total, mark);
  if ("error" in outcome) {
    metaReportProgress(job.videoId, 0, total, "failed", outcome.error);
    metaShowBanner(outcome.error, "#dc2626");
    return;
  }
  if (outcome.urls.length === 0) {
    const error = "Meta AI ตอบแล้วแต่ไม่พบไฟล์วิดีโอในหน้า — เปิดวิดีโอในแชทให้เล่นสักครั้งแล้วลองใหม่";
    metaReportProgress(job.videoId, 0, total, "failed", error);
    metaShowBanner(error, "#dc2626");
    return;
  }

  // Meta answered with fewer scenes than asked for: join what came back
  // rather than throwing away generations the account has already paid for.
  // The job record has to shrink with it, or the worker refuses to join the
  // clips because the library holds fewer than the record says it should.
  const received = outcome.urls.length;
  if (received < total) {
    metaShowBanner(`Meta AI ส่งมา ${received}/${total} ฉาก — บันทึกเท่าที่ได้ แล้วต่อเป็นวิดีโอเดียว`, "#d97706");
    await metaSendWithTimeout({ type: "TRIM_VIDEO_CLIPS", videoId: job.videoId, count: received });
  }

  let mergeOutcome: MetaUploadResult["merged"];
  for (const [index, url] of outcome.urls.entries()) {
    if (metaCancelled) {
      metaShowBanner("ยกเลิกงานแล้ว", "#d97706");
      return;
    }
    const label = received > 1 ? `คลิป ${index + 1}/${received}` : "";
    metaShowBanner(`AI Affiliate Studio: ${label} กำลังอัปโหลด...`, "#111827");
    metaReportProgress(job.videoId, index + 1, received, "uploading");

    const result = await metaUploadClip(job.videoId, url, index, received);
    if (!result.ok) {
      metaShowBanner(`อัปโหลดไม่สำเร็จ: ${result.error ?? "unknown error"}`, "#dc2626");
      metaReportProgress(job.videoId, index + 1, received, "failed", result.error);
      return;
    }
    mergeOutcome = result.merged ?? mergeOutcome;
  }

  metaReportProgress(job.videoId, received, received, "done");
  metaShowBanner(
    received > 1
      ? mergeOutcome?.ok
        ? `เสร็จแล้ว — ต่อ ${received} ฉากเป็นวิดีโอเดียว ${mergeOutcome.seconds ?? ""} วิ ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓${mergeOutcome.warning ? ` (${mergeOutcome.warning})` : ""}`
        : `เสร็จแล้ว ${received} ฉาก แต่ต่อเป็นวิดีโอเดียวไม่สำเร็จ: ${mergeOutcome?.error ?? "ไม่ทราบสาเหตุ"} — กด "ต่อเป็นวิดีโอเดียว" ในแท็บคลังได้`
      : "บันทึกคลิปแล้ว — ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓",
    mergeOutcome && !mergeOutcome.ok ? "#d97706" : "#16a34a",
  );
}

function metaStartJob(job: MetaVideoJob): { ok: boolean; error?: string } {
  if (metaJobRunning) return { ok: false, error: "มีงานกำลังทำอยู่แล้วในแท็บนี้" };
  metaJobRunning = true;
  metaCancelled = false;
  aiPanelClearLog();
  // Only matters for the streaming fallback in metaVideoFileUrls: the buffer
  // defaults to 250 entries and a Meta chat page spends them quickly.
  try {
    performance.setResourceTimingBufferSize(2000);
  } catch {
    // not supported — the <video> elements are the primary source anyway
  }
  metaRunJob(job)
    .catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      metaShowBanner(
        /context invalidated/i.test(text) ? "Extension ถูกรีโหลดระหว่างทำงาน — กด F5 รีเฟรชหน้านี้" : `เกิดข้อผิดพลาด: ${text}`,
        "#dc2626",
      );
    })
    .finally(() => {
      metaJobRunning = false;
    });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: { type: string; job?: MetaVideoJob }, _sender, sendResponse) => {
  if (message.type === "CANCEL_RUNNING_JOB") {
    metaCancelled = true;
    metaShowBanner("กำลังยกเลิก...", "#d97706");
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
  sendResponse(metaStartJob(message.job));
});

aiPanelMount({ site: "meta", siteLabel: "Meta AI" });

// A job the worker opened this page for. It is claimed whatever the URL
// turned out to be: the worker only leaves a job waiting when it has just
// sent a tab to a new chat for it, and Meta may well answer that with a
// redirect to the chat's own address — refusing to start there would strand
// the job. What keeps a file matched to the right scene is the timing mark
// metaRunJob takes just before sending (metaMp4UrlsSince), with the empty
// chat dispatchMetaJob opens as the second line of defence.
chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB", site: "meta" }, (result: { job: MetaVideoJob | null } | undefined) => {
  if (chrome.runtime.lastError) return;
  if (result?.job) metaStartJob(result.job);
});
