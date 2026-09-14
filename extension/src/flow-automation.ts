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
  /** Which tab is running it — see flowTabToken. */
  owner?: string;
  /** Refreshed while the owning tab is alive, so another tab can tell a live job from an abandoned one. */
  heartbeat?: number;
}

// A second Flow tab opened mid-run used to find activeFlowJob and "resume"
// it at once, submitting the same prompt again while the first tab was
// still waiting on it. Only resume a job this tab owned (Flow reloading
// itself keeps sessionStorage) or one whose owner stopped checking in.
const FLOW_HEARTBEAT_MS = 10_000;
const FLOW_ORPHANED_AFTER_MS = 45_000;

function flowTabToken(): string {
  const key = "aiAffiliateFlowTab";
  let token = sessionStorage.getItem(key);
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem(key, token);
  }
  return token;
}

async function flowSaveActiveJob(job: FlowVideoJob, nextClipIndex: number) {
  const now = Date.now();
  await chrome.storage.local.set({
    [FLOW_JOB_KEY]: {
      job,
      nextClipIndex,
      at: now,
      owner: flowTabToken(),
      heartbeat: now,
    } satisfies FlowActiveJob,
  });
}

async function flowHeartbeat() {
  try {
    const stored = await chrome.storage.local.get(FLOW_JOB_KEY);
    const active = stored[FLOW_JOB_KEY] as FlowActiveJob | undefined;
    if (!active || active.owner !== flowTabToken()) return;
    await chrome.storage.local.set({ [FLOW_JOB_KEY]: { ...active, heartbeat: Date.now() } });
  } catch {
    // context already gone
  }
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
  const ownedHere = active.owner === flowTabToken();
  const abandoned = Date.now() - (active.heartbeat ?? active.at) > FLOW_ORPHANED_AFTER_MS;
  if (!ownedHere && !abandoned) return null; // another tab is still running it
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
  // See the comment on aiPanelStatus in panel.ts — a reloaded extension
  // orphans this tab's script, and chrome.storage then throws.
  try {
    chrome.storage.local.set({ jobProgress: { videoId, current, total, state, at: Date.now() } }).catch(() => {});
  } catch {
    // context already gone
  }
}

async function flowWaitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (flowCancelled) return undefined;
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
      ) ??
      // Newer Flow has no stop button; a render in progress is a tile
      // showing its percentage instead.
      Array.from(document.querySelectorAll<HTMLElement>("flow-video-tile")).find(flowTileInProgress),
  );
}

/**
 * A render shows a percentage while processing, but while queued — and for a
 * moment after finishing — it is only a blurred placeholder with no media.
 * Treat both as not done: a finished clip always has its <img> or <video>.
 */
function flowTileInProgress(tile: HTMLElement): boolean {
  // A failed render has no media either, and used to be taken for one still
  // running — the job then sat on "waiting for Flow" until it timed out.
  if (flowTileFailed(tile)) return false;
  return /\b\d{1,3}%/.test(tile.innerText ?? "") || !tile.querySelector("img, video");
}

/**
 * Newer Flow never puts a <video> in the grid — hovering no longer attaches
 * one — so a finished clip only shows as a thumbnail <img> with a play icon.
 * Reading that as "it made an image" is what sent the same prompt back to
 * Flow over and over.
 */
function flowTileIsVideo(tile: HTMLElement): boolean {
  const icons = Array.from(tile.querySelectorAll("mat-icon")).map((icon) => icon.textContent?.trim());
  return (
    icons.includes("play_arrow") ||
    icons.includes("play_circle") ||
    Boolean(tile.querySelector('img[alt*="video" i]'))
  );
}

/**
 * The grid is a cdk virtual scroll that keeps only ~16 tiles in the DOM, and
 * a new render is inserted first — so the tile count never grows, and any
 * tile scrolled into view later is "unseen" without being new. Keep the grid
 * at the top and only look at the leading tiles.
 */
const FLOW_NEW_TILE_WINDOW = 4;

function flowScrollGridToTop() {
  const viewport = document.querySelector("cdk-virtual-scroll-viewport");
  if (viewport && viewport.scrollTop > 0) viewport.scrollTop = 0;
}

function flowLeadingTiles(): HTMLElement[] {
  flowScrollGridToTop();
  return Array.from(document.querySelectorAll<HTMLElement>("flow-video-tile")).slice(0, FLOW_NEW_TILE_WINDOW);
}

/**
 * The agent's last word is an announcement ("I'm going to generate the
 * second part…") with no approval card and nothing started — it has said
 * what it will do and stopped. A plain follow-up gets it to actually run.
 */
function flowAgentAnnouncedWithoutStarting(): boolean {
  const bubbles = document.querySelectorAll<HTMLElement>(".user-bubble, .agent-bubble");
  const last = bubbles[bubbles.length - 1];
  if (!last?.classList.contains("agent-bubble") || last.querySelector("flow-permission-message")) return false;
  const text = last.innerText ?? "";
  return (
    /\b(I'm|I am|I will|I'll|Let me)\b[^.]*\b(generat|creat|render|make|produc)/i.test(text) &&
    !/\b(scheduled|queued|in the queue|started|kicked off|is generating|are generating)\b/i.test(text)
  );
}

function flowTileFailed(tile: HTMLElement): boolean {
  return /^\s*Failed\b|might violate|violates? our polic|not been charged|something went wrong|generation failed|couldn.t generate|try again/i.test(
    tile.innerText ?? "",
  );
}

/**
 * A failed tile carries its own retry (⟳), reuse-prompt (↩) and delete
 * buttons. Retry re-runs the same prompt and ingredients, and Veo's policy
 * filter is inconsistent enough that the same request often passes the
 * second time. The buttons may only render on hover, so hover first.
 */
function flowTileRetryButton(tile: HTMLElement): HTMLButtonElement | undefined {
  const find = () =>
    Array.from(tile.querySelectorAll<HTMLButtonElement>("button")).find((button) => {
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.innerText}`;
      return /retry|regenerate|try again|refresh|replay|autorenew/i.test(label) && !/delete|remove|reuse|undo/i.test(label);
    });
  let button = find();
  if (!button) {
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) {
      tile.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    button = find();
  }
  return button;
}

const FLOW_MAX_TILE_RETRIES = 2;
const FLOW_TILE_RETRY_SETTLE_MS = 20_000;

/**
 * The clip's file is only on the tile's detail page (/project/…/edit/<id>),
 * so open it, read the player's src, and come back to the prompt box.
 */
/**
 * The clip page comes in two shapes: a plain player with a <video src>, or
 * the timeline editor, which draws to a canvas and fetches the file itself.
 * Either way the file comes from flow-content.google/video/…, so read the
 * player's src when there is one and otherwise the request the page made.
 */
function flowFindClipFileUrl(since: number): string | undefined {
  const player = Array.from(document.querySelectorAll<HTMLVideoElement>("video[src]")).find(
    (v) => !v.closest("flow-video-tile"),
  );
  if (player) return player.getAttribute("src") ?? undefined;

  const request = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.startTime >= since && /^https:\/\/flow-content\.google\/video\//.test(entry.name))
    .pop();
  return request?.name;
}

async function flowReadVideoSrcFromTile(tile: HTMLElement): Promise<string | undefined> {
  const onDetail = () => /\/edit\//.test(window.location.pathname);
  // The browser stops recording resource timings once its buffer (250 by
  // default) fills, which a long Flow session does — start from empty so the
  // clip's request is guaranteed to be captured.
  performance.clearResourceTimings();
  const openedAt = performance.now();

  // Hovering swaps a tile's <img> for a <video>; either is the click target
  // that opens the clip (the tile element itself has no handler). A click
  // right as the tile re-renders can land on nothing, so retry until the
  // detail page opens.
  for (let attempt = 0; attempt < 3 && !onDetail(); attempt++) {
    const target = tile.isConnected ? tile : flowLeadingTiles()[0];
    (target?.querySelector<HTMLElement>("img, video") ?? target)?.click();
    await flowWaitFor(() => (onDetail() ? true : undefined), 8000, 400);
  }

  // Grid tiles can still hold hover-preview <video>s for a moment after the
  // click, so only look once the detail page is actually showing.
  const src = await flowWaitFor(() => (onDetail() ? flowFindClipFileUrl(openedAt) : undefined), 30000, 500);

  if (onDetail()) {
    const back = document.querySelector<HTMLButtonElement>('button[aria-label^="Back button"]');
    if (back) back.click();
    else history.back();
  }
  await flowWaitFor(() => flowFindEditor(), 20000, 500);
  return src;
}

/**
 * The agent asks to confirm each generation ("...costing 12 credits?") unless
 * the account already chose "Always approve". Click the plain Approve, never
 * the one that changes the account-wide setting.
 */
function flowFindApprove(): HTMLElement | undefined {
  // The agent's permission card is a radiogroup of div rows, not buttons.
  // Answered cards stay in the chat history with their rows disabled, so
  // skip those or the next clip "approves" last clip's card and never
  // answers its own.
  const cardOption = Array.from(
    document.querySelectorAll<HTMLElement>('flow-permission-message [role="radio"]:not([aria-disabled="true"])'),
  ).find((row) => (row.getAttribute("aria-label") ?? row.querySelector(".option-label")?.textContent ?? "").trim() === "Approve");
  if (cardOption) return cardOption;

  return Array.from(document.querySelectorAll<HTMLElement>("button, [role='menuitem'], [role='button']")).find(
    (el) => {
      const label = (el.textContent ?? "").trim();
      if (!label || /always/i.test(label)) return false; // never the account-wide "always approve" toggle
      return /^(approve|confirm|continue|yes,?\s*continue|generate anyway)$/i.test(label);
    },
  );
}

/**
 * Text of the agent's replies to the latest prompt. Earlier errors stay in
 * the chat history, so scanning the whole page made one policy rejection
 * fail every job that followed in that tab. Pages without the agent chat
 * have nothing to scope to and fall back to the whole page.
 */
function flowLatestAgentReplyText(): string {
  const bubbles = Array.from(document.querySelectorAll<HTMLElement>(".user-bubble, .agent-bubble"));
  if (bubbles.length === 0) return document.body.innerText ?? "";
  let lastUser = -1;
  bubbles.forEach((bubble, index) => {
    if (bubble.classList.contains("user-bubble")) lastUser = index;
  });
  return bubbles
    .slice(lastUser + 1)
    .map((bubble) => bubble.innerText ?? "")
    .join("\n");
}

function flowUserBubbleCount(): number {
  return document.querySelectorAll(".user-bubble").length;
}

function flowFindRejectedNotice(): string | undefined {
  if (/out of credits|no credits|upgrade to continue|insufficient/i.test(flowLatestAgentReplyText())) {
    return "เครดิต Flow ไม่พอ — เติมหรือรอเครดิตรีเซ็ตก่อน";
  }
  return undefined;
}

function flowFindPolicyViolation(): string | undefined {
  if (/might violate our policies|violates? (our |the )?polic(y|ies)/i.test(flowLatestAgentReplyText())) {
    return "นโยบาย: Flow ปฏิเสธ prompt นี้ (อาจผิดนโยบาย) — ลองแก้ prompt ของฉากนี้แล้วรันใหม่";
  }
  return undefined;
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

interface FlowProductImage {
  base64: string;
  mimeType: string;
  /** Asset name in Flow's library — reused across a job's clips instead of re-uploading. */
  name: string;
}

function flowIngredientChips(): number {
  return flowComposer()?.querySelectorAll('button[aria-label="Ingredient"]').length ?? 0;
}

/** The picker's upload button: labelled by aria-label in the compact layout, only by its text in the wide one. */
function flowUploadMediaButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".cdk-overlay-container button")).find(
    (b) => b.getAttribute("aria-label") === "Upload media" || /Upload media\s*$/.test(b.innerText.trim()),
  );
}

/** Opens the ingredient picker; resolves once it is showing (an empty project has an upload button but no assets). */
async function flowOpenIngredientPicker(): Promise<boolean> {
  const addButton = document.querySelector<HTMLButtonElement>('button[aria-label="Add ingredients to the prompt box"]');
  if (!addButton) return false;
  addButton.click();
  const open = await flowWaitFor(
    () => (document.querySelector(".asset-item") || flowUploadMediaButton() ? true : undefined),
    8000,
    300,
  );
  return open === true;
}

function flowAssetItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".asset-item"));
}

/**
 * In the compact layout clicking an asset adds it straight away; in the wide
 * layout (agent panel open) it only selects it and shows a preview with an
 * "Add to prompt" button.
 */
async function flowPickAsset(asset: HTMLElement) {
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"] as const) {
    asset.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  const addToPrompt = await flowWaitFor(
    () =>
      document.querySelector(".asset-item")
        ? Array.from(document.querySelectorAll<HTMLButtonElement>(".cdk-overlay-container button")).find(
            (b) => b.innerText.trim() === "Add to prompt" && b.getAttribute("aria-disabled") !== "true" && !b.disabled,
          )
        : true, // picker already closed: the compact layout added it
    3000,
    200,
  );
  if (addToPrompt && addToPrompt !== true) addToPrompt.click();
}

function flowBase64ToFile(image: FlowProductImage): File {
  const binary = atob(image.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], image.name, { type: image.mimeType });
}

/**
 * Attaches the product photo as an ingredient, so Flow renders the actual
 * product instead of inventing one from the text. Uploads it through Flow's
 * own "Upload media" button the first time (flow-file-picker.ts keeps the OS
 * file dialog from opening) and picks the already-uploaded asset afterwards.
 */
async function flowAttachProductImage(image: FlowProductImage): Promise<boolean> {
  const chipsBefore = flowIngredientChips();
  if (!(await flowOpenIngredientPicker())) return false;

  const byName = () =>
    flowAssetItems().find((item) => item.innerText.includes(image.name) && !/Generating|Uploading/i.test(item.innerText));

  let asset = byName();
  if (!asset) {
    const upload = flowUploadMediaButton();
    if (!upload) {
      await flowCloseIngredientMenu();
      return false;
    }
    document.documentElement.setAttribute("data-ai-affiliate-capture-file", "");
    try {
      upload.click();
      const input = await flowWaitFor(
        () => document.querySelector<HTMLInputElement>("input[data-ai-affiliate-file-input]") ?? undefined,
        5000,
        200,
      );
      if (!input) {
        await flowCloseIngredientMenu();
        return false;
      }
      const transfer = new DataTransfer();
      transfer.items.add(flowBase64ToFile(image));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.removeAttribute("data-ai-affiliate-file-input");
    } finally {
      document.documentElement.removeAttribute("data-ai-affiliate-capture-file");
    }
    asset = await flowWaitFor(byName, 60000, 500);
    if (!asset) {
      await flowCloseIngredientMenu();
      return false;
    }
  }

  await flowPickAsset(asset);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await flowCloseIngredientMenu();
  // The chip shows busy while Flow processes the image; Run stays disabled until it's done.
  const attached = await flowWaitFor(
    () =>
      flowIngredientChips() > chipsBefore && !flowComposer()?.querySelector('button[aria-label="Ingredient"][aria-busy="true"]')
        ? true
        : undefined,
    30000,
    500,
  );
  return attached === true;
}

async function flowAttachPreviousClip(): Promise<boolean> {
  if (!(await flowOpenIngredientPicker())) return false;

  // Newest finished video — the product photo uploaded for this job is an Image and sits above it.
  const asset = await flowWaitFor(
    () =>
      flowAssetItems().find((item) => /\bVideo\s*$/.test(item.innerText.trim()) && !/Generating/i.test(item.innerText)) ??
      undefined,
    8000,
    300,
  );
  if (!asset) {
    await flowCloseIngredientMenu();
    return false;
  }

  await flowPickAsset(asset);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await flowCloseIngredientMenu();
  return true;
}

const IMAGE_INSTEAD_OF_VIDEO = "__IMAGE_INSTEAD_OF_VIDEO__";
const FLOW_NEW_VIDEO_TILE = "__NEW_VIDEO_TILE__";
const FLOW_NUDGE = "__NUDGE__";
const FLOW_QUICK_NUDGE_AFTER_MS = 15_000;
const FLOW_NUDGE_AFTER_MS = 75_000;
const FLOW_MAX_NUDGES = 2;
const FLOW_MAX_IMAGE_RETRIES = 2;

/** Mirrors describeAspectRatio in lib/prompt-engine (content scripts cannot import modules). */
function flowOrientation(aspectRatio: string): string {
  return aspectRatio === "16:9" ? "16:9 landscape (horizontal)" : "9:16 portrait (vertical)";
}

/**
 * Flow renders whatever its own settings panel says, not what the prompt
 * asks for: with the panel left on 16:9 and x2 a "9:16" job came back
 * landscape and every submit cost two renders' worth of credits. Set
 * Video, the job's aspect ratio and a single output before each submit.
 * Best effort — if the panel changes shape, generation still goes ahead.
 */
async function flowEnsureSettings(aspectRatio: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Settings trigger"]');
  if (!trigger) return;

  const ratio = aspectRatio === "16:9" ? "16:9" : "9:16";
  const radios = () => Array.from(document.querySelectorAll<HTMLButtonElement>('mat-button-toggle button[role="radio"]'));
  const wanted: ((label: string) => boolean)[] = [
    (label) => /Video$/.test(label),
    (label) => label.endsWith(ratio),
    (label) => label === "x1",
  ];

  const panelWasOpen = radios().length > 0;
  if (!panelWasOpen) {
    trigger.click();
    if (!(await flowWaitFor(() => (radios().length ? true : undefined), 5000, 200))) return;
  }

  for (const matches of wanted) {
    const option = radios().find((radio) => matches((radio.textContent ?? "").trim()));
    if (option && option.getAttribute("aria-checked") !== "true") {
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  if (!panelWasOpen) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flowWaitFor(() => (radios().length ? undefined : true), 3000, 200);
    if (radios().length) trigger.click();
  }
}

/** One attempt: type the prompt, submit, and wait for a result. Split out of flowGenerateClip so a wrong-media-type result can be retried without duplicating all of this. */
async function flowSubmitAndWaitOnce(
  clip: FlowClip,
  label: string,
  aspectRatio: string,
  withContinuity = true,
  productImage: FlowProductImage | null = null,
): Promise<string | null> {
  // Flow refuses a new prompt while the last one is still running, so wait
  // for it to go idle rather than typing into a locked composer.
  // A render still running from before would otherwise be taken for this
  // one once it finishes — detection anchors on the in-progress tile.
  if (flowLeadingTiles().some(flowTileInProgress)) {
    flowShowBanner(`AI Affiliate Studio: ${label} รอ Flow ว่าง...`, "#111827");
    await flowWaitFor(() => (flowLeadingTiles().some(flowTileInProgress) ? undefined : true), FLOW_MAX_WAIT_MS, FLOW_POLL_MS);
  }

  // Start from an empty prompt box every time, then add this clip's ingredients.
  await flowClearIngredients();

  let imageAttached = false;
  if (productImage) {
    flowShowBanner(`AI Affiliate Studio: ${label} กำลังแนบรูปสินค้า...`, "#111827");
    imageAttached = await flowAttachProductImage(productImage);
    if (!imageAttached) {
      flowShowBanner(`${label} แนบรูปสินค้าไม่สำเร็จ — หยุดไว้ก่อนเพื่อไม่ให้ได้สินค้าผิด`, "#dc2626");
      return null;
    }
    // A freshly uploaded image is a grid tile too, and is briefly media-less
    // while it loads — let it settle so it isn't mistaken for our render.
    await flowWaitFor(() => (flowLeadingTiles().some(flowTileInProgress) ? undefined : true), 30000, 1000);
  }

  let clipAttached = false;
  if (clip.index > 0 && withContinuity) {
    flowShowBanner(`AI Affiliate Studio: ${label} กำลังแนบคลิปก่อนหน้า...`, "#111827");
    clipAttached = await flowAttachPreviousClip();
  }


  flowShowBanner(`AI Affiliate Studio: ${label} กำลังตั้งค่า Flow (Video · ${aspectRatio} · x1)...`, "#111827");
  await flowEnsureSettings(aspectRatio);

  flowShowBanner(`AI Affiliate Studio: ${label} กำลังกรอก prompt...`, "#111827");

  // The previous clip is attached as an ingredient for parts after the
  // first. Say what to copy from it and what must differ — asking only for a
  // match makes the agent re-render the same shot.
  const continuation = clipAttached
    ? " The attached video is the previous part. Start this part as a direct continuation of its LAST frame — same person, wardrobe, location, product, lighting, colour grade and camera position — then follow the [TIMELINE] and [CAMERA] above so the two parts join without a visible cut. Do not replay or copy the attached footage."
    : "";

  // Without this the product in the clip is whatever the model imagines from the name.
  const productReference = imageAttached
    ? " The attached photo shows the exact product being advertised. The product in the video must look exactly like that photo — same shape, colours, pattern, material and packaging design — and must not be replaced by a similar or generic item. Use the photo only as the product reference, not as the video's first frame or background. No other brand's logo or packaging may appear anywhere in the frame."
    : "";

  // Flow's agent decides between image and video on its own, so say it outright.
  const written = await flowSetPromptVerified(
    `Generate exactly one 8-second video (no images) in ${flowOrientation(aspectRatio)} format.\n${clip.prompt}${productReference}${continuation}`,
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
  const userBubblesBefore = flowUserBubbleCount();
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

  // A finished tile can take a moment to show its play icon, so "it made an
  // image instead" needs both a grace period and several consecutive polls
  // before it triggers a costly resubmit.
  const IMAGE_CHECK_GRACE_MS = 30000;
  const IMAGE_CONFIRM_POLLS = 4;
  let consecutiveImageOnlyPolls = 0;

  const waitStartedAt = Date.now();
  const approvedCards = new WeakSet<HTMLElement>();
  let sawGeneration = false;
  if (outcome && outcome !== "generating") approvedCards.add(outcome as HTMLElement);
  let newVideoTile: HTMLElement | undefined;
  let nudges = 0;
  let lastKickAt = Date.now();
  let tileRetries = 0;
  let lastTileRetryAt = 0;
  let policySeenAt = 0;
  const pollForResult = () => {
    // The agent can take a while to think before it asks, and while it
    // thinks its send button shows "stop" — so the pre-wait above can
    // move on before the card appears. Keep answering it here.
    const approve = flowFindApprove();
    if (approve && !approvedCards.has(approve)) {
      approvedCards.add(approve);
      approve.click();
    }

    // Until our prompt shows up in the chat, the "latest reply" is still
    // whatever answered the previous one — possibly an old error.
    const promptPosted = document.querySelector(".agent-bubble") === null || flowUserBubbleCount() > userBubblesBefore;

    // Flow's policy filter rejected the render: press the tile's own retry
    // button before giving up on this prompt.
    const failedTile = flowLeadingTiles().find(flowTileFailed);
    if (failedTile && promptPosted && Date.now() - lastTileRetryAt > FLOW_TILE_RETRY_SETTLE_MS) {
      const retry = tileRetries < FLOW_MAX_TILE_RETRIES ? flowTileRetryButton(failedTile) : undefined;
      if (retry) {
        tileRetries += 1;
        lastTileRetryAt = Date.now();
        sawGeneration = false;
        lastKickAt = Date.now();
        retry.click();
        flowShowBanner(
          `AI Affiliate Studio: ${label} Flow บล็อกคลิป (อาจผิดนโยบาย) — กดสร้างใหม่ให้อัตโนมัติ (${tileRetries}/${FLOW_MAX_TILE_RETRIES})...`,
          "#d97706",
        );
        return undefined;
      }
    }
    // Right after a retry the old tile and the agent's old policy reply are still on screen.
    const settlingAfterRetry = tileRetries > 0 && Date.now() - lastTileRetryAt < FLOW_TILE_RETRY_SETTLE_MS;
    if (settlingAfterRetry) return undefined;

    if (promptPosted) {
      const blocked = flowFindRejectedNotice();
      if (blocked) return blocked;
      // Once a tile retry has been used the chat's policy notice is stale — the tile decides.
      const policyBlocked = tileRetries === 0 ? flowFindPolicyViolation() : undefined;
      if (policyBlocked) {
        // The chat can say so a moment before the tile turns into "Failed"
        // with its retry button — give the tile a chance first.
        policySeenAt ||= Date.now();
        if (!failedTile && Date.now() - policySeenAt < FLOW_TILE_RETRY_SETTLE_MS) return undefined;
        return policyBlocked;
      }
    }

    // Nothing identifies a tile across polls — hovering swaps its <img>
    // for a <video>, and the virtual grid recycles elements — so "new"
    // can't be a set difference. Anchor on the render itself instead: a
    // tile showing a percentage is the one just submitted (new renders
    // land first), and it is ours once no leading tile is in progress.
    const leading = flowLeadingTiles();
    if (leading.some(flowTileInProgress) || document.querySelector('button[aria-label="Stop generation"]')) {
      sawGeneration = true;
      consecutiveImageOnlyPolls = 0;
      return undefined;
    }
    if (!sawGeneration) {
      // The agent sometimes answers "I'm going to generate…" and then
      // never starts. If nothing is running, nothing awaits approval and
      // it has stopped thinking, tell it to go ahead.
      const agentIdle = !flowIsGenerating() && !flowFindApprove();
      const sinceKick = Date.now() - lastKickAt;
      const stalled =
        (flowAgentAnnouncedWithoutStarting() && sinceKick > FLOW_QUICK_NUDGE_AFTER_MS) || sinceKick > FLOW_NUDGE_AFTER_MS;
      if (agentIdle && stalled && nudges < FLOW_MAX_NUDGES) {
        return FLOW_NUDGE;
      }
      return undefined;
    }

    const finished = leading[0];
    if (!finished) return undefined;
    if (flowTileFailed(finished)) return "นโยบาย: Flow สร้างคลิปนี้ไม่สำเร็จ — ลองแก้ prompt ของฉากนี้แล้วรันใหม่";

    const directSrc = finished.querySelector("video")?.getAttribute("src");
    if (flowTileIsVideo(finished) || directSrc) {
      newVideoTile = finished;
      return FLOW_NEW_VIDEO_TILE;
    }

    if (Date.now() - waitStartedAt > IMAGE_CHECK_GRACE_MS) {
      consecutiveImageOnlyPolls += 1;
      if (consecutiveImageOnlyPolls >= IMAGE_CONFIRM_POLLS) return IMAGE_INSTEAD_OF_VIDEO;
    }
    return undefined;
  };

  let newSrc = await flowWaitFor(pollForResult, FLOW_MAX_WAIT_MS, FLOW_POLL_MS);
  while (newSrc === FLOW_NUDGE) {
    nudges += 1;
    flowShowBanner(`AI Affiliate Studio: ${label} Flow ยังไม่เริ่มสร้าง — สั่งให้เริ่ม (${nudges}/${FLOW_MAX_NUDGES})...`, "#111827");
    if (await flowSetPromptVerified("Go ahead and generate that video now.")) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      flowFindStartButton()?.click();
    }
    lastKickAt = Date.now();
    newSrc = await flowWaitFor(pollForResult, FLOW_MAX_WAIT_MS, FLOW_POLL_MS);
  }

  if (newSrc === FLOW_NEW_VIDEO_TILE && newVideoTile) {
    flowShowBanner(`AI Affiliate Studio: ${label} กำลังเปิดคลิปเพื่อดึงไฟล์...`, "#111827");
    newSrc = await flowReadVideoSrcFromTile(newVideoTile);
    if (!newSrc) {
      flowShowBanner(`${label} วิดีโอเสร็จแล้วแต่หาไฟล์ในหน้าคลิปไม่เจอ — ดาวน์โหลดเองจากหน้า Flow ได้`, "#dc2626");
      return null;
    }
  }

  if (flowCancelled) return null;

  if (!newSrc) {
    flowShowBanner(`${label} รอวิดีโอนานเกินไป — เช็คที่หน้า Flow ว่าคิวค้างหรือเปล่า`, "#dc2626");
    return null;
  }
  if (newSrc.startsWith("เครดิต") || newSrc.startsWith("นโยบาย") || newSrc === IMAGE_INSTEAD_OF_VIDEO) {
    if (newSrc !== IMAGE_INSTEAD_OF_VIDEO) flowShowBanner(newSrc, "#dc2626");
    return newSrc;
  }

  return newSrc;
}

async function flowGenerateClip(
  clip: FlowClip,
  label: string,
  aspectRatio: string,
  productImage: FlowProductImage | null = null,
): Promise<string | null> {
  const editor = await flowWaitFor(() => flowFindEditor(), 30000, 500);
  if (!editor) {
    flowShowBanner("ไม่พบช่อง prompt บนหน้า Flow (หน้าเว็บอาจเปลี่ยนไป)", "#dc2626");
    return null;
  }

  let withContinuity = clip.index > 0;
  let image = productImage;
  for (let attempt = 1; attempt <= FLOW_MAX_IMAGE_RETRIES; ) {
    const result = await flowSubmitAndWaitOnce(clip, label, aspectRatio, withContinuity, image);

    // Veo's safety filter is inconsistent, and a clip of a real-looking
    // person attached as a reference trips it far more often than the text
    // alone. Retry without the previous clip first — the product photo is
    // what keeps the product right, so it is dropped only as a last resort.
    if (result?.startsWith("นโยบาย") && !flowCancelled && (withContinuity || image)) {
      if (withContinuity) {
        withContinuity = false;
        flowShowBanner(`${label} Flow ปฏิเสธ prompt — ลองใหม่แบบไม่แนบคลิปก่อนหน้า...`, "#d97706");
      } else {
        image = null;
        flowShowBanner(`${label} Flow ปฏิเสธ prompt — ลองใหม่แบบไม่แนบรูปสินค้า (สินค้าในคลิปอาจไม่ตรง)...`, "#d97706");
      }
      continue;
    }

    if (result !== IMAGE_INSTEAD_OF_VIDEO) {
      // null (a real failure, already banner'd) or a genuine video src.
      if (result?.startsWith("เครดิต") || result?.startsWith("นโยบาย")) return null;
      return result;
    }

    attempt++;
    if (attempt <= FLOW_MAX_IMAGE_RETRIES) {
      flowShowBanner(
        `${label} Flow สร้างเป็นรูปภาพแทนวิดีโอ — ลองใหม่อีกครั้ง (${attempt}/${FLOW_MAX_IMAGE_RETRIES})`,
        "#d97706",
      );
    }
  }

  flowShowBanner(
    `${label} Flow สร้างเป็นรูปภาพแทนวิดีโอซ้ำๆ — ลองแก้ prompt ของฉากนี้แล้วรันใหม่`,
    "#dc2626",
  );
  return null;
}

/**
 * Flow's page CSP blocks fetching the clip from here even though it is
 * same-origin, so hand the URL to the worker and let it do both the fetch
 * and the upload.
 */
/**
 * Without a timeout, a dropped response (background worker restarted, or
 * this tab navigated away mid-flight) leaves this Promise unresolved
 * forever — flowRunJob's `await` never returns, so the job just sits there
 * looking stuck with no error and no way out short of reloading the tab.
 */
const FLOW_UPLOAD_TIMEOUT_MS = 90000;

function flowUploadClip(
  videoId: string,
  src: string,
  clipIndex: number,
  clipTotal: number,
): Promise<{ ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(
      () => settle({ ok: false, error: "อัปโหลดไม่ตอบสนองภายในเวลาที่กำหนด" }),
      FLOW_UPLOAD_TIMEOUT_MS,
    );

    try {
      chrome.runtime.sendMessage(
        { type: "FETCH_AND_UPLOAD_VIDEO", videoId, url: src, clipIndex, clipTotal },
        (result: { ok: boolean; error?: string; merged?: { ok: boolean; seconds?: number; error?: string; warning?: string } } | undefined) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            settle({ ok: false, error: chrome.runtime.lastError.message ?? "ส่งข้อความไม่สำเร็จ" });
            return;
          }
          settle(result ?? { ok: false, error: "no response" });
        },
      );
    } catch (err) {
      clearTimeout(timer);
      settle({ ok: false, error: err instanceof Error ? err.message : "ส่งข้อความไม่สำเร็จ" });
    }
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

  let mergeOutcome: { ok: boolean; seconds?: number; error?: string; warning?: string } | undefined;
  for (const clip of job.clips.slice(startIndex)) {
    if (flowIsCancelled()) {
      flowShowBanner("ยกเลิกงานแล้ว", "#d97706");
      await flowClearActiveJob();
      return;
    }
    const label = total > 1 ? `คลิป ${clip.index + 1}/${total}` : "";
    flowReportProgress(job.videoId, clip.index + 1, total, "generating");

    const productImage: FlowProductImage | null = job.imageBase64
      ? {
          base64: job.imageBase64,
          // CDNs sometimes label images as octet-stream; Flow's upload only accepts image types.
          mimeType: /^image\/(png|jpeg|webp|gif)/.test(job.imageMimeType ?? "") ? job.imageMimeType!.split(";")[0] : "image/jpeg",
          name: `product-${job.videoId.slice(0, 8)}.${/png/.test(job.imageMimeType ?? "") ? "png" : /webp/.test(job.imageMimeType ?? "") ? "webp" : "jpg"}`,
        }
      : null;
    const src = await flowGenerateClip(clip, label, job.aspectRatio || "9:16", productImage);
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
    mergeOutcome = result.merged ?? mergeOutcome;

    // Recorded after the upload lands, so a reload resumes at the next clip
    // and never re-generates one that is already in the app.
    await flowSaveActiveJob(job, clip.index + 1);
  }

  await flowClearActiveJob();
  flowReportProgress(job.videoId, total, total, "done");
  flowShowBanner(
    total > 1
      ? mergeOutcome?.ok
        ? `เสร็จแล้ว — ต่อ ${total} คลิปเป็นวิดีโอเดียว ${mergeOutcome.seconds ?? ""} วิ ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓${mergeOutcome.warning ? ` (${mergeOutcome.warning})` : ""}`
        : `เสร็จแล้ว ${total} คลิป แต่ต่อเป็นวิดีโอเดียวไม่สำเร็จ: ${mergeOutcome?.error ?? "ไม่ทราบสาเหตุ"} — กด "ต่อเป็นวิดีโอเดียว" ในแท็บคลังได้`
      : "บันทึกคลิปแล้ว — ดูได้ในแท็บคลัง และโฟลเดอร์ Downloads/ai-affiliate ✓",
    mergeOutcome && !mergeOutcome.ok ? "#d97706" : "#16a34a",
  );
}

let flowJobRunning = false;
let flowCancelled = false;

/**
 * Cancellation cannot interrupt an await already in flight, so the loop
 * checks between steps and the long waits bail out too — otherwise a cancel
 * during a twelve-minute queue wait would appear to do nothing.
 */
function flowIsCancelled(): boolean {
  return flowCancelled;
}

function flowStartJob(job: FlowVideoJob, startIndex = 0) {
  // Only an in-memory guard: a reload is a legitimate resume, so nothing
  // durable may block the same job from being picked up again.
  if (flowJobRunning) return false;

  // Only wipe the trace on a genuinely fresh start — a resume after Flow's
  // own reload should keep showing what happened before the reload.
  if (startIndex === 0) aiPanelClearLog();

  flowJobRunning = true;
  flowCancelled = false;
  const heartbeat = setInterval(flowHeartbeat, FLOW_HEARTBEAT_MS);
  flowSaveActiveJob(job, startIndex)
    .then(() => flowRunJob(job, startIndex))
    .catch((err) => {
      flowShowBanner(`เกิดข้อผิดพลาด: ${err instanceof Error ? err.message : String(err)}`, "#dc2626");
    })
    .finally(() => {
      clearInterval(heartbeat);
      flowJobRunning = false;
    });
  return true;
}

chrome.runtime.onMessage.addListener(
  (message: { type: string; job?: FlowVideoJob }, _sender, sendResponse) => {
    if (message.type === "CANCEL_RUNNING_JOB") {
      flowCancelled = true;
      flowShowBanner("กำลังยกเลิก...", "#d97706");
      sendResponse({ ok: true });
      return;
    }
    if (message.type !== "RUN_VIDEO_JOB" || !message.job) return;
    const started = flowStartJob(message.job);
    sendResponse({ ok: started, error: started ? undefined : "มีงานกำลังทำอยู่แล้วในแท็บนี้" });
  },
);

aiPanelMount({ site: "flow", siteLabel: "Google Flow" });

/**
 * Runs once per real page load. If Flow reloads the page after finishing a
 * generation, this is what picks a multi-clip job back up on the next
 * clip — the script that was running the previous clip gets torn down
 * along with the whole JS context, so nothing about that script (its
 * in-memory job loop, its pending awaits) survives; only what was written
 * to chrome.storage does. If Flow instead updates itself client-side
 * (no real navigation), this block never runs again and whatever the old
 * script instance was awaiting either resolves normally or times out via
 * flowUploadClip's timeout / flowWaitFor's own deadlines — it does not
 * hang forever.
 */
// Flow's home page has no prompt box, so a job claimed there would only
// fail — leave it in storage for the project page to pick up instead.
const flowOnProjectPage = /^\/project\//.test(window.location.pathname);

if (flowOnProjectPage) flowShowBanner("AI Affiliate Studio: กำลังตรวจสอบงานที่ค้างอยู่...", "#111827");

if (flowOnProjectPage) chrome.runtime.sendMessage({ type: "GET_PENDING_VIDEO_JOB" }, (result: { job: FlowVideoJob | null }) => {
  if (result?.job) {
    flowStartJob(result.job);
    return;
  }
  // No new job, but Flow may have reloaded out from under one that was
  // half finished.
  flowLoadActiveJob().then((active) => {
    if (active) {
      flowShowBanner(
        `AI Affiliate Studio: พบงานค้างอยู่ — ทำต่อจากคลิป ${active.nextClipIndex + 1}`,
        "#111827",
      );
      flowStartJob(active.job, active.nextClipIndex);
    } else {
      document.getElementById("ai-affiliate-flow-banner")?.remove();
    }
  });
});
