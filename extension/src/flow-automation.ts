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

// Flow reloads its own page after a generation finishes, which tears down
// this script mid-job — that is why multi-clip runs always died on the
// second clip. Progress is kept outside the page so the next load can pick
// the job back up instead of starting over or stalling.
const FLOW_JOB_KEY = "activeFlowJob";
const FLOW_JOB_STALE_MS = 60 * 60 * 1000;

interface FlowActiveJob {
  job: FlowVideoJob;
  nextClipIndex: number;
  at: number;
}

async function flowSaveActiveJob(job: FlowVideoJob, nextClipIndex: number) {
  await chrome.storage.local.set({
    [FLOW_JOB_KEY]: { job, nextClipIndex, at: Date.now() } satisfies FlowActiveJob,
  });
}

async function flowClearActiveJob() {
  await chrome.storage.local.remove(FLOW_JOB_KEY);
}

async function flowLoadActiveJob(): Promise<FlowActiveJob | null> {
  const stored = await chrome.storage.local.get(FLOW_JOB_KEY);
  const active = stored[FLOW_JOB_KEY] as FlowActiveJob | undefined;
  if (!active) return null;
  if (Date.now() - active.at > FLOW_JOB_STALE_MS) {
    await flowClearActiveJob();
    return null;
  }
  if (active.nextClipIndex >= active.job.clips.length) {
    await flowClearActiveJob();
    return null;
  }
  return active;
}

function flowShowBanner(text: string, color: string) {
  // The in-page panel is the primary surface; the floating banner stays as a
  // fallback for when the panel has not mounted yet.
  aiPanelStatus(text, color === "#111827" ? "#e5e7eb" : color);

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

/**
 * execCommand writes nothing if anything else holds focus, and the failure is
 * silent — the run then waits forever on a Run button that stays disabled
 * because the box is empty. Read the text back and retry rather than trust it.
 */
async function flowSetPromptVerified(text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const editor = flowFindEditor();
    if (editor) {
      flowSetPrompt(editor, text);
      await new Promise((resolve) => setTimeout(resolve, 700));
      if ((flowFindEditor()?.textContent ?? "").trim().length > 20) return true;
    }
    // Something took focus — usually a picker overlay still open.
    await flowCloseIngredientMenu();
  }
  return false;
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
 * Flow only attaches the real <video> once a tile is hovered, and the
 * listener sits on an inner node — mouseenter does not bubble and nothing
 * propagates downward, so the events go to the tile and every descendant.
 */
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
 * Every clip currently in the project. Position cannot be used to find the
 * newest one — Flow does not place a finished clip first, it landed fifth in
 * testing — so a new clip is identified as a src that was not there before.
 */
function flowAllVideoSrcs(): Set<string> {
  for (const tile of Array.from(document.querySelectorAll("flow-video-tile"))) {
    flowHover(tile);
  }
  return new Set(
    Array.from(document.querySelectorAll<HTMLVideoElement>("flow-video-tile video"))
      .map((v) => v.getAttribute("src") ?? v.currentSrc ?? "")
      .filter(Boolean),
  );
}

/**
 * Snapshot taken immediately before submitting. Hovering is what attaches the
 * <video> elements, and it takes a moment to settle, so this waits for the
 * count to stop climbing — a half-built snapshot makes an existing clip look
 * new and the run then races ahead while Flow is still busy.
 */
async function flowSnapshotVideoSrcs(): Promise<Set<string>> {
  let previous = flowAllVideoSrcs();
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const current = flowAllVideoSrcs();
    if (current.size === previous.size) return current;
    previous = current;
  }
  return previous;
}

/**
 * Hands the previous clip to the agent as an ingredient. Prompt text alone
 * does not hold the scene together — an earlier three-clip run came back
 * with a different person and room each time — but Flow will carry over
 * look and subject when it can see the clip it is continuing from.
 */
/**
 * The prompt bar, scoped from the Run button. Deliberately returns null when
 * that anchor is missing rather than falling back to the document — clearing
 * ingredients clicks every remove/close control it finds, and page-wide that
 * would start dismissing Flow's own dialogs.
 */
function flowComposer(): Element | null {
  return flowFindStartButton()?.closest("div")?.parentElement?.parentElement ?? null;
}

/** Drops ingredients left over from the previous clip so they do not stack up. */
async function flowClearIngredients() {
  const composer = flowComposer();
  const removers = composer
    ? Array.from(composer.querySelectorAll("button")).filter((b) =>
        /remove|delete|clear|close/i.test(b.getAttribute("aria-label") ?? ""),
      )
    : [];
  for (const button of removers) button.click();
  if (removers.length) await new Promise((resolve) => setTimeout(resolve, 800));
}

/**
 * The picker is a CDK overlay that keeps focus once open, which silently
 * swallows the prompt typed straight afterwards — the clip then sits there
 * attached with an empty prompt box and Run disabled.
 */
async function flowCloseIngredientMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flowWaitFor(
    () => (document.querySelector(".asset-item") ? undefined : true),
    5000,
    300,
  );
}

async function flowAttachPreviousClip(): Promise<boolean> {
  await flowClearIngredients();

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
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await flowCloseIngredientMenu();
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

  const before = await flowSnapshotVideoSrcs();

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");

  // The previous clip is attached as an ingredient for parts after the
  // first. Say what to copy from it and what must differ — asking only for a
  // match makes the agent re-render the same shot.
  const continuation =
    clip.index > 0
      ? " The attached video is the previous part. Reuse its person, wardrobe, room, product and colour grade, but this part must be a NEW shot: different camera angle and the new action described above. Do not re-create the attached video."
      : "";

  // Flow's agent decides between image and video on its own, so say it outright.
  const written = await flowSetPromptVerified(
    `Generate exactly one 8-second video (no images) in ${aspectRatio} vertical format. ${clip.prompt}${continuation}`,
  );
  if (!written) {
    flowShowBanner(`${label} ใส่ prompt ลงช่องไม่สำเร็จ — มีหน้าต่างอื่นบังอยู่`, "#dc2626");
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, 800));

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

  flowShowBanner(
    `AI Affiliate Studio: ${label} กำลังสร้าง (Flow อาจเข้าคิวหลายนาที) — ห้ามปิดแท็บนี้`,
    "#111827",
  );

  const newSrc = await flowWaitFor(
    () => {
      const blocked = flowFindRejectedNotice();
      if (blocked) return blocked;
      return Array.from(flowAllVideoSrcs()).find((src) => !before.has(src));
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

async function flowRunJob(job: FlowVideoJob, startIndex: number) {
  const total = job.clips.length;
  if (startIndex > 0) {
    flowShowBanner(
      `AI Affiliate Studio: ทำงานต่อจากคลิป ${startIndex + 1}/${total} (หน้าเว็บโหลดใหม่)`,
      "#111827",
    );
  }

  for (const clip of job.clips.slice(startIndex)) {
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    flowReportProgress(job.videoId, clip.index + 1, total, "generating");

    const src = await flowGenerateClip(clip, label, job.aspectRatio || "9:16");
    if (!src) {
      flowReportProgress(job.videoId, clip.index + 1, total, "failed");
      await flowClearActiveJob();
      return;
    }

    flowShowBanner(`AI Affiliate Studio: ${label} กำลังอัปโหลด...`, "#111827");
    flowReportProgress(job.videoId, clip.index + 1, total, "uploading");
    const result = await flowUploadClip(job.videoId, src, clip.index, total);
    if (!result.ok) {
      flowShowBanner(`อัปโหลดไม่สำเร็จ: ${result.error ?? "unknown error"}`, "#dc2626");
      flowReportProgress(job.videoId, clip.index + 1, total, "failed");
      await flowClearActiveJob();
      return;
    }

    // Recorded after the upload lands, so a reload resumes at the next clip
    // and never re-generates one that is already in the app.
    await flowSaveActiveJob(job, clip.index + 1);
  }

  await flowClearActiveJob();
  flowReportProgress(job.videoId, total, total, "done");
  flowShowBanner(
    total > 1 ? `เสร็จแล้ว ${total} คลิป — แอปกำลังต่อเป็นวิดีโอเดียว ✓` : "อัปโหลดกลับเข้าแอปสำเร็จ ✓",
    "#16a34a",
  );
}

let flowJobRunning = false;

function flowStartJob(job: FlowVideoJob, startIndex = 0) {
  // Only an in-memory guard: a reload is a legitimate resume, so nothing
  // durable may block the same job from being picked up again.
  if (flowJobRunning) return false;

  flowJobRunning = true;
  flowSaveActiveJob(job, startIndex)
    .then(() => flowRunJob(job, startIndex))
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

aiPanelMount({ site: "flow", siteLabel: "Google Flow" });

chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB" }, (result: { job: FlowVideoJob | null }) => {
  if (result?.job) {
    flowStartJob(result.job);
    return;
  }
  // No new job, but Flow may have reloaded out from under one that was
  // half finished.
  flowLoadActiveJob().then((active) => {
    if (active) flowStartJob(active.job, active.nextClipIndex);
  });
});
