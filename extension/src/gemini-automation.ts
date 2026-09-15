// NOTE: shares one TypeScript global scope with the other extension scripts
// (Chrome loads them as classic scripts), so every top-level name here is
// prefixed with "gemini" to stay unique.
//
// Drives the video tool on gemini.google.com (/videos). Its buttons are
// found by their Material icon names rather than aria-labels, which follow
// the account's UI language (Thai, English, …).
interface GeminiClip {
  index: number;
  prompt: string;
}

interface GeminiVideoJob {
  videoId: string;
  clips: GeminiClip[];
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

const GEMINI_VIDEOS_PATH = "/videos";
const GEMINI_MAX_WAIT_MS = 10 * 60 * 1000;
const GEMINI_POLL_MS = 3000;
/**
 * Polls in a row with nothing running and no video before the reply is
 * checked for a quota or policy refusal. Quiet that is neither keeps waiting
 * until GEMINI_MAX_WAIT_MS — the turn can end while the render goes on, and
 * failing early would throw away a video from a one-a-day allowance.
 */
const GEMINI_IDLE_POLLS_BEFORE_FAIL = 6;
const GEMINI_UPLOAD_TIMEOUT_MS = 90_000;

// A job survives its chat being refreshed: progress lives in chrome.storage.
const GEMINI_JOB_KEY = "activeGeminiJob";
const GEMINI_JOB_STALE_MS = 60 * 60 * 1000;
const GEMINI_HEARTBEAT_MS = 10_000;
const GEMINI_ORPHANED_AFTER_MS = 45_000;

interface GeminiActiveJob {
  job: GeminiVideoJob;
  nextClipIndex: number;
  /** The /app/<id> chat the job runs in; a resume only happens in that chat, never in some other conversation. */
  chatPath?: string;
  at: number;
  owner: string;
  heartbeat: number;
}

let geminiJobRunning = false;
let geminiCancelled = false;

function geminiTabToken(): string {
  const key = "aiAffiliateGeminiTab";
  let token = sessionStorage.getItem(key);
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem(key, token);
  }
  return token;
}

function geminiShowBanner(text: string, color: string) {
  aiPanelStatus(text, color === "#111827" ? "#e5e7eb" : color);

  const id = "ai-affiliate-gemini-banner";
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

function geminiReportProgress(videoId: string, current: number, total: number, state: string) {
  try {
    chrome.storage.local.set({ jobProgress: { videoId, current, total, state, at: Date.now() } }).catch(() => {});
  } catch {
    // context already gone
  }
}

async function geminiSaveActiveJob(job: GeminiVideoJob, nextClipIndex: number) {
  const now = Date.now();
  const chatPath = window.location.pathname.startsWith("/app/") ? window.location.pathname : undefined;
  await chrome.storage.local.set({
    [GEMINI_JOB_KEY]: { job, nextClipIndex, chatPath, at: now, owner: geminiTabToken(), heartbeat: now } satisfies GeminiActiveJob,
  });
}

async function geminiHeartbeat() {
  try {
    const stored = await chrome.storage.local.get(GEMINI_JOB_KEY);
    const active = stored[GEMINI_JOB_KEY] as GeminiActiveJob | undefined;
    if (!active || active.owner !== geminiTabToken()) return;
    await chrome.storage.local.set({ [GEMINI_JOB_KEY]: { ...active, heartbeat: Date.now() } });
  } catch {
    // context already gone
  }
}

async function geminiClearActiveJob() {
  await chrome.storage.local.remove(GEMINI_JOB_KEY);
}

async function geminiLoadActiveJob(): Promise<GeminiActiveJob | null> {
  const stored = await chrome.storage.local.get(GEMINI_JOB_KEY);
  const active = stored[GEMINI_JOB_KEY] as GeminiActiveJob | undefined;
  if (!active) return null;
  if (Date.now() - active.at > GEMINI_JOB_STALE_MS || active.nextClipIndex >= active.job.clips.length) {
    await geminiClearActiveJob();
    return null;
  }
  if (!active.chatPath || active.chatPath !== window.location.pathname) return null;
  const ownedHere = active.owner === geminiTabToken();
  const abandoned = Date.now() - active.heartbeat > GEMINI_ORPHANED_AFTER_MS;
  return ownedHere || abandoned ? active : null;
}

async function geminiWaitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (geminiCancelled) return undefined;
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

const geminiSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- page elements ---------- */

function geminiIconName(icon: Element): string {
  return icon.getAttribute("fonticon") || icon.getAttribute("data-mat-icon-name") || icon.textContent?.trim() || "";
}

function geminiButtonWithIcon(root: ParentNode, icons: string[]): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    Array.from(button.querySelectorAll("mat-icon")).some((icon) => icons.includes(geminiIconName(icon))),
  );
}

function geminiInputArea(): HTMLElement | null {
  return document.querySelector<HTMLElement>("input-area-v2") ?? document.querySelector<HTMLElement>("input-container");
}

/** The prompt box — `.ql-editor`, not Quill's hidden `.ql-clipboard`, which is contenteditable too. */
function geminiEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('rich-textarea .ql-editor[contenteditable="true"]');
}

/** The "Video" tool chip (movie icon) that puts the composer into video generation. */
function geminiVideoModeOn(): boolean {
  const area = geminiInputArea();
  return !!area && !!geminiButtonWithIcon(area, ["movie"]);
}

/** An empty thinking-overlay stays in finished replies, so only the dots animation or the stop button count. */
function geminiIsGenerating(): boolean {
  const stopIcon = document.querySelector('.send-button mat-icon[fonticon="stop"]');
  const lastResponse = geminiResponses().pop();
  return !!stopIcon || !!lastResponse?.querySelector("thinking-dots-animation");
}

/** "I'm generating your video… check back" — the reply can end its turn while the render keeps going. */
function geminiAnnouncedRender(response: HTMLElement | undefined): boolean {
  return /generating your video|check back|video is being|กำลังสร้างวิดีโอ|กลับมาดู|สักครู่/i.test(response?.innerText ?? "");
}

function geminiResponses(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("model-response"));
}

function geminiVideoSrc(response: HTMLElement | undefined): string | undefined {
  const video = response?.querySelector<HTMLVideoElement>("generated-video video");
  const src = video?.currentSrc || video?.getAttribute("src") || video?.querySelector("source")?.getAttribute("src") || "";
  return /^https?:/.test(src) ? src : undefined;
}

/**
 * Out of video allowance, Gemini locks the composer (contenteditable="false")
 * and shows "you're out of video generations until …" above it. Returns that
 * notice, whatever the UI language.
 */
function geminiQuotaNotice(): string | undefined {
  const editor = document.querySelector<HTMLElement>("rich-textarea .ql-editor");
  if (!editor || editor.getAttribute("contenteditable") !== "false") return undefined;
  const container = document.querySelector<HTMLElement>("input-container") ?? geminiInputArea();
  const notice = (container?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return `โควต้า: Gemini ล็อกช่อง prompt ไว้ — ${notice || "โควต้าสร้างวิดีโอหมด"}`;
}

function geminiAttachmentCount(): number {
  return geminiInputArea()?.querySelectorAll("gem-media-attachment").length ?? 0;
}

/* ---------- composer actions ---------- */

async function geminiEnsureAspectRatio(aspectRatio: string): Promise<boolean> {
  const area = geminiInputArea();
  if (!area) return false;
  const wanted = aspectRatio === "16:9" ? "16:9" : "9:16";
  const trigger = geminiButtonWithIcon(area, ["crop_16_9", "crop_9_16", "crop_portrait", "crop_landscape", "crop_square"]);
  if (!trigger) return false;
  if ((trigger.getAttribute("aria-label") ?? trigger.innerText).includes(wanted)) return true;

  trigger.click();
  const item = await geminiWaitFor(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.cdk-overlay-container [role="menuitemradio"]')).find((el) =>
        el.innerText.includes(wanted),
      ),
    5000,
    200,
  );
  if (!item) {
    document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click();
    return false;
  }
  item.click();
  await geminiSleep(500);
  return (geminiButtonWithIcon(area, ["crop_16_9", "crop_9_16"])?.getAttribute("aria-label") ?? "").includes(wanted);
}

async function geminiClearAttachments() {
  for (let i = 0; i < 5 && geminiAttachmentCount() > 0; i++) {
    const close = geminiInputArea()?.querySelector("gem-media-attachment");
    const button = close ? geminiButtonWithIcon(close, ["close"]) : undefined;
    if (!button) break;
    button.click();
    await geminiSleep(300);
  }
}

function geminiBase64ToFile(base64: string, mimeType: string, name: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mimeType });
}

/** Gemini accepts a pasted image as an attachment, which avoids its OS file dialog entirely. */
async function geminiAttachImage(job: GeminiVideoJob): Promise<boolean> {
  const editor = geminiEditor();
  if (!editor || !job.imageBase64) return false;
  const mimeType = /^image\/(png|jpeg|webp)/.test(job.imageMimeType ?? "") ? job.imageMimeType!.split(";")[0] : "image/jpeg";
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const file = geminiBase64ToFile(job.imageBase64, mimeType, `product-${job.videoId.slice(0, 8)}.${extension}`);

  const before = geminiAttachmentCount();
  const transfer = new DataTransfer();
  transfer.items.add(file);
  editor.focus();
  editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));

  const attached = await geminiWaitFor(() => (geminiAttachmentCount() > before ? true : undefined), 15000, 300);
  if (!attached) return false;
  // The tile shows before the upload finishes; the send button stays inert until it does.
  await geminiWaitFor(
    () => (geminiInputArea()?.querySelector("gem-media-attachment mat-progress-spinner, gem-media-attachment .loading") ? undefined : true),
    30000,
    500,
  );
  return true;
}

function geminiWritePrompt(text: string): boolean {
  const editor = geminiEditor();
  if (!editor) return false;
  editor.focus();
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
  // One line: a newline typed into the composer is the same key that sends.
  document.execCommand("insertText", false, text.replace(/\s*\n+\s*/g, " "));
  return (editor.innerText ?? "").trim().length > 0;
}

/** Gemini ignores synthetic clicks on its send button, so the worker clicks it through the DevTools protocol. */
function geminiTrustedClick(selector: string, bringToFront: boolean): Promise<{ ok: boolean; error?: string }> {
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
 * `.click()` works on the other composer buttons but not on send, which
 * suggests it listens for pointer/mouse down — so try the full synthetic
 * sequence first, and only then the DevTools click (which shows Chrome's
 * "debugging this browser" bar and fails while DevTools is open on the tab).
 */
async function geminiSubmit(): Promise<boolean> {
  const before = geminiResponses().length;
  const sent = () => (geminiResponses().length > before ? true : undefined);

  const button = document.querySelector<HTMLButtonElement>(".send-button button");
  if (button) {
    const rect = button.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    button.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mousedown", at));
    button.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mouseup", at));
    button.dispatchEvent(new MouseEvent("click", at));
    if (await geminiWaitFor(sent, 4000, 400)) return true;
  }

  for (const bringToFront of [false, true]) {
    const click = await geminiTrustedClick(".send-button button", bringToFront);
    if (!click.ok) {
      geminiShowBanner(`กดส่งไม่สำเร็จ: ${click.error ?? "unknown"}`, "#dc2626");
      return false;
    }
    if (await geminiWaitFor(sent, 15000, 500)) return true;
  }
  return false;
}

/* ---------- one clip ---------- */

/** Result of one attempt: a video URL, or a Thai message starting with its failure kind. */
type GeminiOutcome = { src: string } | { error: string };

/** A recognised quota or policy reply, or undefined when the text says neither. */
function geminiClassifyRefusal(text: string): string | undefined {
  const reply = text.replace(/^\s*(Gemini (said|บอกว่า))\s*/i, "").trim().slice(0, 200);
  if (/limit|quota|ขีดจำกัด|ครบ|โควต้า|try again later|ภายหลัง|upgrade|อัปเกรด/i.test(text)) {
    return `โควต้า: Gemini สร้างวิดีโอเพิ่มไม่ได้ตอนนี้ — ${reply}`;
  }
  if (/polic|guideline|นโยบาย|หลักเกณฑ์|can't (create|make|generate|help)|cannot (create|make|generate|help)|unable to (create|make|generate)|ไม่สามารถ|ช่วยเรื่องนี้ไม่ได้/i.test(text)) {
    return `นโยบาย: Gemini ไม่สร้างคลิปนี้ — ${reply}`;
  }
  return undefined;
}

async function geminiSubmitAndWait(job: GeminiVideoJob, clip: GeminiClip, label: string, withImage: boolean): Promise<GeminiOutcome> {
  // A reply to an earlier prompt may still be finishing.
  await geminiWaitFor(() => (geminiIsGenerating() ? undefined : true), 60000, 1000);

  const editor = await geminiWaitFor(() => geminiEditor() ?? (geminiQuotaNotice() ? true : undefined), 30000, 500);
  const quota = geminiQuotaNotice();
  if (quota) return { error: quota };
  if (!editor) return { error: "ไม่พบช่อง prompt บนหน้า Gemini (หน้าเว็บอาจเปลี่ยนไป)" };
  if (!geminiVideoModeOn()) return { error: "หน้า Gemini ไม่ได้อยู่ในโหมดสร้างวิดีโอ — เปิด https://gemini.google.com/videos แล้วลองใหม่" };

  geminiShowBanner(`AI Affiliate Studio: ${label} กำลังตั้งค่า (${job.aspectRatio})...`, "#111827");
  if (!(await geminiEnsureAspectRatio(job.aspectRatio))) {
    geminiShowBanner(`${label} ตั้งสัดส่วนภาพไม่สำเร็จ — ใช้ค่าที่หน้าเว็บตั้งไว้`, "#d97706");
  }

  await geminiClearAttachments();
  let imageAttached = false;
  if (withImage && job.imageBase64) {
    geminiShowBanner(`AI Affiliate Studio: ${label} กำลังแนบรูปสินค้า...`, "#111827");
    imageAttached = await geminiAttachImage(job);
    if (!imageAttached) geminiShowBanner(`${label} แนบรูปสินค้าไม่สำเร็จ — สร้างต่อจากข้อความอย่างเดียว`, "#d97706");
  }

  const productReference = imageAttached
    ? " The attached photo shows the exact product being advertised: the product in the video must match it — same shape, colours, pattern, material and packaging design — and must not be replaced by a similar or generic item. Use the photo only as the product reference, not as the video's opening frame or background. No other brand's logo or packaging may appear."
    : "";
  const continuation =
    clip.index > 0
      ? " The previous video in this chat is the part before this one: continue directly from its last frame with the same person, wardrobe, location, product, lighting and camera position, without replaying it."
      : "";
  const orientation = job.aspectRatio === "16:9" ? "16:9 landscape (horizontal)" : "9:16 portrait (vertical)";

  geminiShowBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");
  if (!geminiWritePrompt(`Generate one ${orientation} video. ${clip.prompt}${productReference}${continuation}`)) {
    return { error: "ใส่ prompt ลงช่องของ Gemini ไม่สำเร็จ" };
  }
  await geminiSleep(800);

  if (!(await geminiSubmit())) return { error: "ส่ง prompt ไม่สำเร็จ — ลองกดส่งเองในหน้า Gemini ได้ prompt ใส่ไว้ให้แล้ว" };

  geminiShowBanner(`AI Affiliate Studio: ${label} กำลังสร้างวิดีโอบน Gemini — ห้ามปิดแท็บนี้`, "#111827");
  let idlePolls = 0;
  const outcome = await geminiWaitFor<GeminiOutcome>(
    () => {
      const response = geminiResponses().pop();
      const src = geminiVideoSrc(response);
      if (src) return { src };
      // A video tile can appear before its file is ready.
      if (geminiIsGenerating() || response?.querySelector("generated-video") || geminiAnnouncedRender(response)) {
        idlePolls = 0;
        return undefined;
      }
      idlePolls += 1;
      if (idlePolls < GEMINI_IDLE_POLLS_BEFORE_FAIL) return undefined;
      // Not the composer lock: spending the last allowance on this very render locks it too.
      const refusal = geminiClassifyRefusal(response?.innerText ?? "");
      return refusal ? { error: refusal } : undefined;
    },
    GEMINI_MAX_WAIT_MS,
    GEMINI_POLL_MS,
  );

  if (geminiCancelled) return { error: "ยกเลิกงานแล้ว" };
  return outcome ?? { error: "รอวิดีโอจาก Gemini นานเกินไป — เช็คที่หน้า Gemini ว่ายังสร้างอยู่หรือเปล่า" };
}

async function geminiGenerateClip(job: GeminiVideoJob, clip: GeminiClip, label: string): Promise<string | null> {
  let withImage = !!job.imageBase64;
  for (;;) {
    const outcome = await geminiSubmitAndWait(job, clip, label, withImage);
    if ("src" in outcome) return outcome.src;

    // The safety filter trips more often with a photo attached; the text alone is worth one more try.
    if (outcome.error.startsWith("นโยบาย") && withImage && !geminiCancelled) {
      withImage = false;
      geminiShowBanner(`${label} Gemini ปฏิเสธ — ลองใหม่แบบไม่แนบรูปสินค้า (สินค้าในคลิปอาจไม่ตรง)...`, "#d97706");
      continue;
    }
    geminiShowBanner(`${label} ${outcome.error}`, "#dc2626");
    return null;
  }
}

/* ---------- saving the clip ---------- */

type GeminiUploadResult = { ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } };

function geminiSendWithTimeout(message: object): Promise<GeminiUploadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GeminiUploadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, error: "อัปโหลดไม่ตอบสนองภายในเวลาที่กำหนด" }), GEMINI_UPLOAD_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, (result: GeminiUploadResult | undefined) => {
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
 * The file is served from a Google download host that needs this page's
 * cookies, so fetch it here and hand the bytes over; if that fails, let the
 * worker try the URL itself.
 */
async function geminiUploadClip(videoId: string, src: string, clipIndex: number, clipTotal: number): Promise<GeminiUploadResult> {
  try {
    const res = await fetch(src, { credentials: "include" });
    if (res.ok) {
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return geminiSendWithTimeout({
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
  return geminiSendWithTimeout({ type: "FETCH_AND_UPLOAD_VIDEO", videoId, url: src, clipIndex, clipTotal });
}

/* ---------- the job ---------- */

async function geminiRunJob(job: GeminiVideoJob, startIndex: number) {
  const total = job.clips.length;
  if (startIndex > 0) geminiShowBanner(`AI Affiliate Studio: ทำงานต่อจากคลิป ${startIndex + 1}/${total}`, "#111827");

  let mergeOutcome: GeminiUploadResult["merged"];
  for (const clip of job.clips.slice(startIndex)) {
    if (geminiCancelled) {
      geminiShowBanner("ยกเลิกงานแล้ว", "#d97706");
      await geminiClearActiveJob();
      return;
    }
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    geminiReportProgress(job.videoId, clip.index + 1, total, "generating");

    const src = await geminiGenerateClip(job, clip, label);
    if (!src) {
      geminiReportProgress(job.videoId, clip.index + 1, total, "failed");
      await geminiClearActiveJob();
      return;
    }

    geminiShowBanner(`AI Affiliate Studio: ${label} กำลังอัปโหลด...`, "#111827");
    geminiReportProgress(job.videoId, clip.index + 1, total, "uploading");
    const result = await geminiUploadClip(job.videoId, src, clip.index, total);
    if (!result.ok) {
      geminiShowBanner(`อัปโหลดไม่สำเร็จ: ${result.error ?? "unknown error"}`, "#dc2626");
      geminiReportProgress(job.videoId, clip.index + 1, total, "failed");
      await geminiClearActiveJob();
      return;
    }
    mergeOutcome = result.merged ?? mergeOutcome;
    await geminiSaveActiveJob(job, clip.index + 1);
  }

  await geminiClearActiveJob();
  geminiReportProgress(job.videoId, total, total, "done");
  geminiShowBanner(
    total > 1
      ? mergeOutcome?.ok
        ? `เสร็จแล้ว — ต่อ ${total} คลิปเป็นวิดีโอเดียว ${mergeOutcome.seconds ?? ""} วิ ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓${mergeOutcome.warning ? ` (${mergeOutcome.warning})` : ""}`
        : `เสร็จแล้ว ${total} คลิป แต่ต่อเป็นวิดีโอเดียวไม่สำเร็จ: ${mergeOutcome?.error ?? "ไม่ทราบสาเหตุ"} — กด "ต่อเป็นวิดีโอเดียว" ในแท็บคลังได้`
      : "บันทึกคลิปแล้ว — ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓",
    mergeOutcome && !mergeOutcome.ok ? "#d97706" : "#16a34a",
  );
}

function geminiStartJob(job: GeminiVideoJob, startIndex = 0): { ok: boolean; error?: string } {
  if (geminiJobRunning) return { ok: false, error: "มีงานกำลังทำอยู่แล้วในแท็บนี้" };
  // The worker sends new jobs to a fresh /videos page, so an earlier job's clips are not in the chat.
  if (startIndex === 0 && !window.location.pathname.startsWith(GEMINI_VIDEOS_PATH)) {
    return { ok: false, error: "แท็บ Gemini ไม่ได้อยู่ที่หน้า /videos" };
  }

  if (startIndex === 0) aiPanelClearLog();
  geminiJobRunning = true;
  geminiCancelled = false;
  const heartbeat = setInterval(geminiHeartbeat, GEMINI_HEARTBEAT_MS);
  geminiSaveActiveJob(job, startIndex)
    .then(() => geminiRunJob(job, startIndex))
    .catch((err) => {
      geminiShowBanner(`เกิดข้อผิดพลาด: ${err instanceof Error ? err.message : String(err)}`, "#dc2626");
    })
    .finally(() => {
      clearInterval(heartbeat);
      geminiJobRunning = false;
    });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: { type: string; job?: GeminiVideoJob }, _sender, sendResponse) => {
  if (message.type === "CANCEL_RUNNING_JOB") {
    geminiCancelled = true;
    geminiShowBanner("กำลังยกเลิก...", "#d97706");
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
  sendResponse(geminiStartJob(message.job));
});

aiPanelMount({ site: "gemini", siteLabel: "Gemini" });

// Runs once per real page load: a job the worker opened /videos for, or one
// cut off by a refresh of the chat it was running in.
if (window.location.pathname.startsWith(GEMINI_VIDEOS_PATH)) {
  chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB", site: "gemini" }, (result: { job: GeminiVideoJob | null } | undefined) => {
    if (chrome.runtime.lastError) return;
    if (result?.job) geminiStartJob(result.job);
  });
} else if (window.location.pathname.startsWith("/app/")) {
  void geminiResumeIfAbandoned();
}

async function geminiResumeIfAbandoned() {
  const active = await geminiLoadActiveJob();
  if (!active) return;
  geminiShowBanner(`AI Affiliate Studio: พบงานค้างอยู่ — ทำต่อจากคลิป ${active.nextClipIndex + 1}`, "#111827");
  geminiStartJob(active.job, active.nextClipIndex);
}
