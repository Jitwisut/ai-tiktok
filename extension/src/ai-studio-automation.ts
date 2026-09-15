// NOTE: every file here compiles to a classic script (Chrome loads content
// scripts and MV3 service workers as classic, not modules), so they all share
// one TypeScript global scope — top-level names must stay unique across files.
interface StudioClip {
  index: number;
  prompt: string;
}

interface StudioVideoJob {
  videoId: string;
  clips: StudioClip[];
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

interface StudioFrame {
  base64: string;
  mimeType: string;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

function showBanner(text: string, color: string) {
  // The in-page panel is the primary surface; the floating banner stays as a
  // fallback for when the panel has not mounted yet.
  aiPanelStatus(text, color === "#111827" ? "#e5e7eb" : color);

  const id = "ai-affiliate-ext-banner";
  document.getElementById(id)?.remove();

  const banner = document.createElement("div");
  banner.id = id;
  banner.textContent = text;
  Object.assign(banner.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    padding: "10px 16px",
    borderRadius: "8px",
    background: color,
    color: "#fff",
    fontFamily: "sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(banner);
}

function reportProgress(videoId: string, current: number, total: number, state: string) {
  // See the comment on aiPanelStatus in panel.ts — a reloaded extension
  // orphans this tab's script, and chrome.storage then throws.
  try {
    chrome.storage.local.set({ jobProgress: { videoId, current, total, state, at: Date.now() } }).catch(() => {});
  } catch {
    // context already gone
  }
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function findRunButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Run",
  );
}

function findStopButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    /stop/i.test(b.textContent?.trim() ?? ""),
  );
}

function findVideos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>("video[src^='blob:']"));
}

/**
 * Google throws an upgrade/quota dialog over the page once the account runs
 * out of allowance. It looks identical to a generation that never finishes,
 * so name it explicitly instead of reporting a mystery timeout.
 */
function findQuotaBlock(): string | undefined {
  const dialog = document.querySelector("mat-dialog-container, [role='dialog']");
  const text = dialog?.textContent ?? "";
  if (/upgrade to unlock|pay per request|quota|rate limit/i.test(text)) {
    return "AI Studio ขอให้อัปเกรด/โควตาหมด — เปิดหน้า AI Studio แล้วจัดการก่อน แล้วค่อยสั่งใหม่";
  }
  return undefined;
}

/**
 * "This generation might violate our policies" shows inline instead of
 * failing the request — the Stop button just disappears with no video ever
 * appearing, so without this the run polls for one for the full timeout
 * before giving up with a misleading "couldn't find the result" message.
 */
function findPolicyBlock(): string | undefined {
  const text = document.body.innerText ?? "";
  if (/might violate our policies|violates? (our |the )?polic(y|ies)/i.test(text)) {
    return "นโยบาย: AI Studio ปฏิเสธ prompt นี้ (อาจผิดนโยบาย) — ลองแก้ prompt ของฉากนี้แล้วรันใหม่";
  }
  return undefined;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (studioCancelled) return undefined;
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getCurrentModelId(): string | undefined {
  return document.querySelector('[data-test-id="model-name"]')?.textContent?.trim();
}

/**
 * The URL's ?model= param usually preselects Veo already, but AI Studio has
 * ignored it before (cached session state, a saved prompt reopened, etc.),
 * and picking the wrong model here means Run never becomes clickable. This
 * verifies the actual selection and drives the model picker dialog as a
 * fallback rather than trusting the URL alone.
 */
async function ensureModelSelected(modelId: string): Promise<boolean> {
  const currentBadge = await waitFor(
    () => document.querySelector('[data-test-id="model-name"]') ?? undefined,
    15000,
    500,
  );
  if (!currentBadge) return false;
  if (currentBadge.textContent?.trim() === modelId) return true;

  document.querySelector<HTMLButtonElement>("button.model-selector-card")?.click();

  const searchInput = await waitFor(
    () => document.querySelector<HTMLInputElement>('input[placeholder="Search for a model or agent"]'),
    8000,
    400,
  );
  if (!searchInput) return false;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(searchInput, modelId);
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));

  // The default "Featured" tab excludes Veo entirely — "All" guarantees the
  // model shows up regardless of how Google buckets it that week.
  const allTab = await waitFor(
    () => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "All"),
    5000,
    300,
  );
  allTab?.click();

  const row = await waitFor(() => {
    const subtitle = Array.from(document.querySelectorAll(".model-subtitle")).find(
      (el) => el.textContent?.trim() === modelId,
    );
    return (subtitle?.closest("button.content-button") as HTMLButtonElement | null) ?? undefined;
  }, 8000, 400);
  if (!row) return false;

  row.click();
  await waitFor(() => (getCurrentModelId() === modelId ? true : undefined), 8000, 300);
  return getCurrentModelId() === modelId;
}

function findStartFrameInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    'input[type="file"][data-test-upload-file-input]:not([multiple])',
  );
}

/**
 * Clears a previously attached start frame before the next clip. The remove
 * control has no stable hook, so fall back to overwriting the input, which a
 * single-file input accepts.
 */
async function clearStartFrame(filename: string) {
  const label = Array.from(document.querySelectorAll("*")).find(
    (el) => el.children.length === 0 && el.textContent?.trim() === filename,
  );
  const container = label?.closest("div")?.parentElement;
  const removeButton = container
    ? Array.from(container.querySelectorAll("button")).find((b) =>
        /remove|delete|clear|close/i.test(b.getAttribute("aria-label") ?? ""),
      )
    : undefined;

  if (removeButton) {
    removeButton.click();
    await waitFor(
      () => (document.body.textContent?.includes(filename) ? undefined : true),
      5000,
      300,
    );
  }
}

async function attachStartFrame(frame: StudioFrame, filename: string): Promise<boolean> {
  const input = await waitFor(() => findStartFrameInput() ?? undefined, 8000, 400);
  if (!input) return false;

  const bytes = decodeBase64ToBytes(frame.base64);
  const file = new File([bytes as unknown as BlobPart], filename, { type: frame.mimeType });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  // AI Studio keeps Run disabled while it uploads and validates the image,
  // which takes far longer than the change event — wait for the attachment
  // chip to appear instead of guessing a delay.
  const attached = await waitFor(
    () => (document.body.textContent?.includes(filename) ? true : undefined),
    30000,
    500,
  );
  return attached === true;
}

/**
 * Grabs the final frame of a finished clip so it can seed the next one and
 * the cuts line up instead of jumping to an unrelated scene.
 */
async function captureLastFrame(video: HTMLVideoElement): Promise<StudioFrame | null> {
  try {
    if (!video.videoWidth) {
      await waitFor(() => (video.videoWidth ? true : undefined), 8000, 300);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done);
      video.currentTime = Math.max(0, (video.duration || 8) - 0.15);
      setTimeout(done, 4000);
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    return { base64: dataUrl.split(",")[1], mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

async function uploadClip(
  videoId: string,
  video: HTMLVideoElement,
  clipIndex: number,
  clipTotal: number,
): Promise<{ ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } }> {
  const response = await fetch(video.src);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = uint8ArrayToBase64(bytes);

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "UPLOAD_VIDEO", videoId, base64, mimeType: "video/mp4", clipIndex, clipTotal },
      (result: { ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } }) => resolve(result ?? { ok: false, error: "no response" }),
    );
  });
}

/** Runs one Veo generation and returns the <video> element it produced. */
async function generateClip(
  clip: StudioClip,
  frame: StudioFrame | null,
  frameFilename: string,
  label: string,
): Promise<HTMLVideoElement | null> {
  if (frame) {
    showBanner(`AI Affiliate Studio: ${label} กำลังแนบภาพเริ่มต้น...`, "#111827");
    await attachStartFrame(frame, frameFilename);
  }

  showBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");
  const textarea = await waitFor(
    () => document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Describe your video"]'),
    30000,
    500,
  );
  if (!textarea) {
    showBanner("ไม่พบช่อง prompt บนหน้า AI Studio (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return null;
  }

  setNativeValue(textarea, clip.prompt);

  const videosBefore = findVideos().length;

  // Angular enables Run asynchronously, and an attached image keeps it
  // disabled until the upload settles — poll generously rather than
  // checking once right after typing.
  const runButton = await waitFor(() => {
    const btn = findRunButton();
    return btn && btn.getAttribute("aria-disabled") !== "true" ? btn : undefined;
  }, 45000, 500);

  if (runButton) {
    runButton.click();
  } else {
    // The Run button is labelled "Run ↵", so Enter submits too. Use it as a
    // fallback when the button never reports itself as enabled.
    textarea.focus();
    for (const type of ["keydown", "keypress", "keyup"] as const) {
      textarea.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
    }
  }

  const started = await waitFor(() => (findStopButton() ? true : undefined), 10000, 400);
  if (!started) {
    showBanner("กดสร้างไม่สำเร็จ — ลองกดปุ่ม Run เองได้เลย prompt ใส่ไว้ให้แล้ว", "#d97706");
    return null;
  }

  showBanner(`AI Affiliate Studio: ${label} กำลังสร้าง รอสักครู่ — ห้ามปิดแท็บนี้`, "#111827");
  await waitFor(
    () => (findStopButton() && !findQuotaBlock() && !findPolicyBlock() ? undefined : true),
    MAX_WAIT_MS,
    POLL_INTERVAL_MS,
  );

  const quotaMessage = findQuotaBlock();
  if (quotaMessage) {
    showBanner(quotaMessage, "#dc2626");
    return null;
  }

  const policyMessage = findPolicyBlock();
  if (policyMessage) {
    showBanner(policyMessage, "#dc2626");
    return null;
  }

  const videos = await waitFor(() => {
    const current = findVideos();
    return current.length > videosBefore ? current : undefined;
  }, 20000, 1000);
  if (!videos) {
    showBanner(`${label} สร้างไม่สำเร็จ หรือหาไฟล์ผลลัพธ์ไม่เจอ`, "#dc2626");
    return null;
  }

  return videos[videos.length - 1];
}

async function runJob(job: StudioVideoJob) {
  // A generation already in flight means something else (a duplicate
  // delivery, or the user) started one — don't fight it for the Run button.
  if (findStopButton()) {
    showBanner("มีวิดีโอกำลังสร้างอยู่ในแท็บนี้แล้ว", "#d97706");
    return;
  }

  showBanner("AI Affiliate Studio: กำลังเลือกโมเดล...", "#111827");
  if (!(await ensureModelSelected(job.modelId))) {
    showBanner("เลือกโมเดล Veo ไม่สำเร็จ (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return;
  }

  const total = job.clips.length;
  let frame: StudioFrame | null =
    job.imageBase64 && job.imageMimeType
      ? { base64: job.imageBase64, mimeType: job.imageMimeType }
      : null;
  let previousFilename = "";

  let mergeOutcome: { ok: boolean; seconds?: number; error?: string; warning?: string } | undefined;
  for (const clip of job.clips) {
    if (studioCancelled) {
      showBanner("ยกเลิกงานแล้ว", "#d97706");
      return;
    }
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    reportProgress(job.videoId, clip.index + 1, total, "generating");

    if (previousFilename) await clearStartFrame(previousFilename);
    const filename = `frame-${clip.index}.jpg`;

    const video = await generateClip(clip, frame, filename, label);
    if (!video) {
      reportProgress(job.videoId, clip.index + 1, total, "failed");
      return;
    }
    previousFilename = frame ? filename : "";

    showBanner(`AI Affiliate Studio: ${label} กำลังอัปโหลด...`, "#111827");
    reportProgress(job.videoId, clip.index + 1, total, "uploading");
    const result = await uploadClip(job.videoId, video, clip.index, total);
    if (!result.ok) {
      showBanner(`อัปโหลดไม่สำเร็จ: ${result.error ?? "unknown error"}`, "#dc2626");
      reportProgress(job.videoId, clip.index + 1, total, "failed");
      return;
    }
    mergeOutcome = result.merged ?? mergeOutcome;

    // Seed the next clip with this one's final frame so the cuts match.
    if (clip.index < total - 1) {
      frame = await captureLastFrame(video);
      if (!frame) {
        showBanner("จับเฟรมสุดท้ายไม่ได้ คลิปถัดไปอาจไม่ต่อเนื่อง", "#d97706");
        previousFilename = "";
      }
    }
  }

  reportProgress(job.videoId, total, total, "done");
  showBanner(
    total > 1
      ? mergeOutcome?.ok
        ? `เสร็จแล้ว — ต่อ ${total} คลิปเป็นวิดีโอเดียว ${mergeOutcome.seconds ?? ""} วิ ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓${mergeOutcome.warning ? ` (${mergeOutcome.warning})` : ""}`
        : `เสร็จแล้ว ${total} คลิป แต่ต่อเป็นวิดีโอเดียวไม่สำเร็จ: ${mergeOutcome?.error ?? "ไม่ทราบสาเหตุ"} — กด "ต่อเป็นวิดีโอเดียว" ในแท็บคลังได้`
      : "บันทึกคลิปแล้ว — ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓",
    mergeOutcome && !mergeOutcome.ok ? "#d97706" : "#16a34a",
  );
}

let jobRunning = false;
let studioCancelled = false;

function startJob(job: StudioVideoJob) {
  if (jobRunning) return false;

  // Guard against the same job being delivered twice to this tab (a page
  // reload re-runs this script and re-asks the worker for pending work).
  const claimKey = `ai-affiliate-claimed-${job.videoId}`;
  try {
    if (sessionStorage.getItem(claimKey)) return false;
    sessionStorage.setItem(claimKey, "1");
  } catch {
    // sessionStorage can be unavailable; the in-memory guard still applies.
  }

  aiPanelClearLog();
  jobRunning = true;
  studioCancelled = false;
  runJob(job)
    .catch((err) => {
      showBanner(`เกิดข้อผิดพลาด: ${err instanceof Error ? err.message : String(err)}`, "#dc2626");
    })
    .finally(() => {
      jobRunning = false;
    });
  return true;
}

// Triggered from the popup while the user is already looking at this tab.
chrome.runtime.onMessage.addListener((message: { type: string; job?: StudioVideoJob }, _sender, sendResponse) => {
  if (message.type === "CANCEL_RUNNING_JOB") {
    studioCancelled = true;
    showBanner("กำลังยกเลิก...", "#d97706");
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
  const started = startJob(message.job);
  sendResponse({ ok: started, error: started ? undefined : "มีงานกำลังทำอยู่แล้วในแท็บนี้" });
});

// Triggered by the app opening this tab with a job already queued.
aiPanelMount({ site: "aistudio", siteLabel: "AI Studio" });

chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB", site: "aistudio" }, (result: { job: StudioVideoJob | null }) => {
  if (result?.job) startJob(result.job);
});
