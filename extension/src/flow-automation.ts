// NOTE: shares one TypeScript global scope with the other extension scripts
// (Chrome loads them as classic scripts), so every top-level name here is
// prefixed to stay unique.
interface FlowClip {
  index: number;
  prompt: string;
}

interface FlowVideoJob {
  videoId: string;
  clips: FlowClip[];
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

// Flow queues generations behind "high demand" waits far longer than the
// AI Studio playground does.
const FLOW_MAX_WAIT_MS = 12 * 60 * 1000;
const FLOW_POLL_MS = 5000;

function flowShowBanner(text: string, color: string) {
  const id = "ai-affiliate-flow-banner";
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
    boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(banner);
}

function flowReportProgress(videoId: string, current: number, total: number, state: string) {
  chrome.storage.local.set({ jobProgress: { videoId, current, total, state, at: Date.now() } });
}

async function flowWaitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}


function flowFindEditor(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("div.ProseMirror")).find(
    (el) => el.getBoundingClientRect().width > 0,
  );
}

/**
 * Flow's prompt box is a ProseMirror editor, which ignores a plain value
 * assignment — execCommand produces the input events it listens for.
 */
function flowSetPrompt(editor: HTMLElement, text: string) {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, text);
}

function flowFindStartButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Start generation"]');
}

function flowIsGenerating(): boolean {
  return Boolean(
    document.querySelector('button[aria-label="Stop generation"]') ??
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "stop",
      ),
  );
}

/**
 * The agent asks to confirm each generation ("...costing 12 credits?") unless
 * the account already chose "Always approve". Click the plain Approve, never
 * the one that changes the account-wide setting.
 */
function flowFindApprove(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("button, [role='menuitem'], [role='button']")).find(
    (el) => el.textContent?.trim() === "Approve",
  );
}

function flowFindRejectedNotice(): string | undefined {
  const text = document.body.innerText ?? "";
  if (/out of credits|no credits|upgrade to continue|insufficient/i.test(text)) {
    return "เครดิต Flow ไม่พอ — เติมหรือรอเครดิตรีเซ็ตก่อน";
  }
  return undefined;
}

function flowHover(el: Element) {
  const fire = (target: Element) => {
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }),
      );
    }
  };
  fire(el);
  for (const child of Array.from(el.querySelectorAll("*"))) fire(child);
}

/**
 * Only ever looks at the newest tile. Flow renders newest-first in a
 * virtualised grid, so scanning the whole grid for "a src we haven't seen"
 * reports an old clip as new the moment one scrolls into view — which
 * previously made the run think a clip had finished while Flow was still
 * generating it, leaving the next clip unable to submit.
 *
 * Flow also only attaches the real <video> once a tile is hovered, and the
 * listener sits on an inner node (mouseenter does not bubble, and nothing
 * propagates downward), hence hovering every descendant.
 */
function flowNewestVideoSrc(): string | undefined {
  const tile = document.querySelector("flow-video-tile");
  if (!tile) return undefined;
  flowHover(tile);
  const video = tile.querySelector("video");
  return video?.getAttribute("src") ?? video?.currentSrc ?? undefined;
}

/**
 * The baseline this run compares against. A plain read right after page load
 * returns undefined because the hover has not attached the <video> yet, and
 * treating that as "no videos" makes the first already-existing clip look
 * freshly generated — which is how a run could "finish" a clip seconds after
 * starting it.
 */
async function flowBaselineVideoSrc(): Promise<string | undefined> {
  if (!document.querySelector("flow-video-tile")) return undefined;
  return await flowWaitFor(() => flowNewestVideoSrc(), 15000, 500);
}

/**
 * Hands the previous clip to the agent as an ingredient. Prompt text alone
 * does not hold the scene together — an earlier three-clip run came back
 * with a different person and room each time — but Flow will carry over
 * look and subject when it can see the clip it is continuing from.
 */
async function flowAttachPreviousClip(): Promise<boolean> {
  const addButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add ingredients to the prompt box"]',
  );
  if (!addButton) return false;
  addButton.click();

  const asset = await flowWaitFor(
    () => document.querySelector<HTMLElement>(".asset-item") ?? undefined,
    8000,
    300,
  );
  if (!asset) return false;

  for (const type of ["pointerdown", "mousedown", "mouseup", "click"] as const) {
    asset.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

async function flowGenerateClip(
  clip: FlowClip,
  label: string,
  aspectRatio: string,
): Promise<string | null> {
  const editor = await flowWaitFor(() => flowFindEditor(), 30000, 500);
  if (!editor) {
    flowShowBanner("ไม่พบช่อง prompt บนหน้า Flow (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return null;
  }

  // Flow refuses a new prompt while the last one is still running, so wait
  // for it to go idle rather than typing into a locked composer.
  if (clip.index > 0) {
    flowShowBanner(`AI Affiliate Studio: ${label} รอ Flow ว่าง...`, "#111827");
    await flowWaitFor(() => (flowIsGenerating() ? undefined : true), FLOW_MAX_WAIT_MS, FLOW_POLL_MS);

    flowShowBanner(`AI Affiliate Studio: ${label} กำลังแนบคลิปก่อนหน้า...`, "#111827");
    await flowAttachPreviousClip();
  }

  const previousNewest = await flowBaselineVideoSrc();

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");

  // The previous clip is attached as an ingredient for parts after the
  // first. Say what to copy from it and what must differ — asking only for a
  // match makes the agent re-render the same shot.
  const continuation =
    clip.index > 0
      ? " The attached video is the previous part. Reuse its person, wardrobe, room, product and colour grade, but this part must be a NEW shot: different camera angle and the new action described above. Do not re-create the attached video."
      : "";

  // Flow's agent decides between image and video on its own, so say it outright.
  flowSetPrompt(
    editor,
    `Generate exactly one 8-second video (no images) in ${aspectRatio} vertical format. ${clip.prompt}${continuation}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const start = await flowWaitFor(
    () => {
      const btn = flowFindStartButton();
      return btn && btn.getAttribute("aria-disabled") !== "true" ? btn : undefined;
    },
    60000,
    500,
  );
  if (!start) {
    flowShowBanner("กดปุ่มสร้างไม่ได้ — prompt ใส่ไว้ให้แล้ว ลองกดเองได้เลย", "#d97706");
    return null;
  }
  start.click();

  // The agent asks to confirm the credit spend, but only when the account
  // has not already chosen "Always approve" — so stop waiting as soon as
  // either the card shows up or generation starts without one.
  flowShowBanner(`AI Affiliate Studio: ${label} รอ agent ยืนยัน...`, "#111827");
  const outcome = await flowWaitFor(
    () => flowFindApprove() ?? (flowIsGenerating() ? "generating" : undefined),
    90000,
    1000,
  );
  if (outcome && outcome !== "generating") (outcome as HTMLElement).click();

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังสร้าง (Flow อาจเข้าคิวหลายนาที)...`, "#111827");

  const newSrc = await flowWaitFor(
    () => {
      const blocked = flowFindRejectedNotice();
      if (blocked) return blocked;
      const newest = flowNewestVideoSrc();
      return newest && newest !== previousNewest ? newest : undefined;
    },
    FLOW_MAX_WAIT_MS,
    FLOW_POLL_MS,
  );

  if (!newSrc) {
    flowShowBanner(`${label} รอวิดีโอนานเกินไป — เช็คที่หน้า Flow ว่าคิวค้างหรือเปล่า`, "#dc2626");
    return null;
  }
  if (newSrc.startsWith("เครดิต")) {
    flowShowBanner(newSrc, "#dc2626");
    return null;
  }

  return newSrc;
}

/**
 * Flow's page CSP blocks fetching the clip from here even though it is
 * same-origin, so hand the URL to the worker and let it do both the fetch
 * and the upload.
 */
function flowUploadClip(
  videoId: string,
  src: string,
  clipIndex: number,
  clipTotal: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_AND_UPLOAD_VIDEO", videoId, url: src, clipIndex, clipTotal },
      (result: { ok: boolean; error?: string }) =>
        resolve(result ?? { ok: false, error: "no response" }),
    );
  });
}

async function flowRunJob(job: FlowVideoJob) {
  if (flowIsGenerating()) {
    flowShowBanner("Flow กำลังสร้างงานอื่นอยู่ในแท็บนี้", "#d97706");
    return;
  }

  const total = job.clips.length;

  for (const clip of job.clips) {
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    flowReportProgress(job.videoId, clip.index + 1, total, "generating");

    const src = await flowGenerateClip(clip, label, job.aspectRatio || "9:16");
    if (!src) {
      flowReportProgress(job.videoId, clip.index + 1, total, "failed");
      return;
    }

    flowShowBanner(`AI Affiliate Studio: ${label} กำลังอัปโหลด...`, "#111827");
    flowReportProgress(job.videoId, clip.index + 1, total, "uploading");
    const result = await flowUploadClip(job.videoId, src, clip.index, total);
    if (!result.ok) {
      flowShowBanner(`อัปโหลดไม่สำเร็จ: ${result.error ?? "unknown error"}`, "#dc2626");
      flowReportProgress(job.videoId, clip.index + 1, total, "failed");
      return;
    }
  }

  flowReportProgress(job.videoId, total, total, "done");
  flowShowBanner(
    total > 1 ? `เสร็จแล้ว ${total} คลิป — แอปกำลังต่อเป็นวิดีโอเดียว ✓` : "อัปโหลดกลับเข้าแอปสำเร็จ ✓",
    "#16a34a",
  );
}

let flowJobRunning = false;

function flowStartJob(job: FlowVideoJob) {
  if (flowJobRunning) return false;

  const claimKey = `ai-affiliate-flow-claimed-${job.videoId}`;
  try {
    if (sessionStorage.getItem(claimKey)) return false;
    sessionStorage.setItem(claimKey, "1");
  } catch {
    // sessionStorage can be unavailable; the in-memory guard still applies.
  }

  flowJobRunning = true;
  flowRunJob(job)
    .catch((err) => {
      flowShowBanner(`เกิดข้อผิดพลาด: ${err instanceof Error ? err.message : String(err)}`, "#dc2626");
    })
    .finally(() => {
      flowJobRunning = false;
    });
  return true;
}

chrome.runtime.onMessage.addListener(
  (message: { type: string; job?: FlowVideoJob }, _sender, sendResponse) => {
    if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
    const started = flowStartJob(message.job);
    sendResponse({ ok: started, error: started ? undefined : "มีงานกำลังทำอยู่แล้วในแท็บนี้" });
  },
);

chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB" }, (result: { job: FlowVideoJob | null }) => {
  if (result?.job) flowStartJob(result.job);
});
