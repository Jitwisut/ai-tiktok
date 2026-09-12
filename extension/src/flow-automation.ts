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

/**
 * Flow only attaches the real <video> element once a tile is hovered, and the
 * listener sits on an inner node — mouseenter does not bubble and no event
 * propagates downward, so the events have to be fired on the tile and every
 * descendant for the video to materialise.
 */
function flowCollectVideoSrcs(): string[] {
  const fire = (el: Element) => {
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
  };

  for (const tile of Array.from(document.querySelectorAll("flow-video-tile"))) {
    fire(tile);
    for (const child of Array.from(tile.querySelectorAll("*"))) fire(child);
  }

  return Array.from(document.querySelectorAll<HTMLVideoElement>("flow-video-tile video"))
    .map((v) => v.getAttribute("src") ?? v.currentSrc ?? "")
    .filter(Boolean);
}

async function flowGenerateClip(clip: FlowClip, label: string, knownSrcs: Set<string>) {
  const editor = await flowWaitFor(() => flowFindEditor(), 30000, 500);
  if (!editor) {
    flowShowBanner("ไม่พบช่อง prompt บนหน้า Flow (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return null;
  }

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");
  // Flow's agent decides between image and video, so say it outright.
  flowSetPrompt(
    editor,
    `Generate exactly one 8-second video (no images) in ${"9:16"} vertical format. ${clip.prompt}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const start = await flowWaitFor(
    () => {
      const btn = flowFindStartButton();
      return btn && btn.getAttribute("aria-disabled") !== "true" ? btn : undefined;
    },
    20000,
    500,
  );
  if (!start) {
    flowShowBanner("กดปุ่มสร้างไม่ได้ — prompt ใส่ไว้ให้แล้ว ลองกดเองได้เลย", "#d97706");
    return null;
  }
  start.click();

  // Approve the credit spend if the agent asks.
  flowShowBanner(`AI Affiliate Studio: ${label} รอ agent ยืนยัน...`, "#111827");
  const approve = await flowWaitFor(() => flowFindApprove(), 90000, 1000);
  if (approve) approve.click();

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังสร้าง (Flow อาจเข้าคิวหลายนาที)...`, "#111827");

  const newSrc = await flowWaitFor(
    () => {
      const blocked = flowFindRejectedNotice();
      if (blocked) return blocked;
      const fresh = flowCollectVideoSrcs().find((src) => !knownSrcs.has(src));
      return fresh;
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
  const knownSrcs = new Set(flowCollectVideoSrcs());

  for (const clip of job.clips) {
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    flowReportProgress(job.videoId, clip.index + 1, total, "generating");

    const src = await flowGenerateClip(clip, label, knownSrcs);
    if (!src) {
      flowReportProgress(job.videoId, clip.index + 1, total, "failed");
      return;
    }
    knownSrcs.add(src);

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
