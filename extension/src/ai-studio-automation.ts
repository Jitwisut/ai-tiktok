// NOTE: every file here compiles to a classic script (Chrome loads content
// scripts and MV3 service workers as classic, not modules), so they all share
// one TypeScript global scope — top-level names must stay unique across files.
interface StudioVideoJob {
  videoId: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

function showBanner(text: string, color: string) {
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

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

  const selectorButton = document.querySelector<HTMLButtonElement>("button.model-selector-card");
  selectorButton?.click();

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

async function uploadStartFrameImage(base64: string, mimeType: string): Promise<boolean> {
  const input = await waitFor(
    () =>
      document.querySelector<HTMLInputElement>(
        'input[type="file"][data-test-upload-file-input]:not([multiple])',
      ) ?? undefined,
    8000,
    400,
  );
  if (!input) return false;

  const bytes = decodeBase64ToBytes(base64);
  const file = new File([bytes as unknown as BlobPart], "product.jpg", { type: mimeType });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  // AI Studio keeps Run disabled while it uploads and validates the image,
  // which takes far longer than the change event — wait for the attachment
  // chip to appear instead of guessing a delay.
  const attached = await waitFor(
    () => (document.body.textContent?.includes("product.jpg") ? true : undefined),
    30000,
    500,
  );
  return attached === true;
}

async function runJob(job: StudioVideoJob) {
  // A generation already in flight means something else (a duplicate
  // delivery, or the user) started one — don't fight it for the Run button.
  if (findStopButton()) {
    showBanner("มีวิดีโอกำลังสร้างอยู่ในแท็บนี้แล้ว", "#d97706");
    return;
  }

  showBanner("AI Affiliate Studio: กำลังเลือกโมเดล...", "#111827");
  const modelOk = await ensureModelSelected(job.modelId);
  if (!modelOk) {
    showBanner("เลือกโมเดล Veo ไม่สำเร็จ (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return;
  }

  if (job.imageBase64 && job.imageMimeType) {
    showBanner("AI Affiliate Studio: กำลังแนบรูปสินค้า...", "#111827");
    const uploaded = await uploadStartFrameImage(job.imageBase64, job.imageMimeType);
    if (!uploaded) {
      showBanner("แนบรูปสินค้าไม่สำเร็จ กำลังสร้างแบบไม่มีรูปแทน", "#d97706");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  showBanner("AI Affiliate Studio: กำลังกรอก prompt...", "#111827");

  const textarea = await waitFor(
    () => document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Describe your video"]'),
    30000,
    500,
  );
  if (!textarea) {
    showBanner("ไม่พบช่อง prompt บนหน้า AI Studio (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return;
  }

  setNativeValue(textarea, job.prompt);

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

  const started = await waitFor(() => (findStopButton() ? true : undefined), 8000, 400);
  if (!started) {
    showBanner("กดสร้างไม่สำเร็จ — ลองกดปุ่ม Run เองได้เลย prompt กับรูปใส่ไว้ให้แล้ว", "#d97706");
    return;
  }

  showBanner("AI Affiliate Studio: กำลังสร้างวิดีโอ รอสักครู่...", "#111827");

  // Generation is in progress while the Stop button is visible; wait for it
  // to disappear, then look for the resulting <video> element.
  await waitFor(() => (findStopButton() ? undefined : true), MAX_WAIT_MS, POLL_INTERVAL_MS);

  const video = await waitFor(() => document.querySelector<HTMLVideoElement>("video[src^='blob:']"), 15000, 1000);
  if (!video) {
    showBanner("สร้างวิดีโอไม่สำเร็จ หรือหาไฟล์ผลลัพธ์ไม่เจอ", "#dc2626");
    return;
  }

  showBanner("AI Affiliate Studio: กำลังอัปโหลดกลับเข้าแอป...", "#111827");

  const response = await fetch(video.src);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = uint8ArrayToBase64(bytes);

  chrome.runtime.sendMessage(
    { type: "UPLOAD_VIDEO", videoId: job.videoId, base64, mimeType: "video/mp4" },
    (result: { ok: boolean; error?: string }) => {
      if (result?.ok) {
        showBanner("อัปโหลดกลับเข้าแอปสำเร็จ ✓", "#16a34a");
      } else {
        showBanner(`อัปโหลดไม่สำเร็จ: ${result?.error ?? "unknown error"}`, "#dc2626");
      }
    },
  );
}

let jobRunning = false;

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

  jobRunning = true;
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
  if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
  const started = startJob(message.job);
  sendResponse({ ok: started, error: started ? undefined : "มีงานกำลังทำอยู่แล้วในแท็บนี้" });
});

// Triggered by the app opening this tab with a job already queued.
chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB" }, (result: { job: StudioVideoJob | null }) => {
  if (result?.job) startJob(result.job);
});
