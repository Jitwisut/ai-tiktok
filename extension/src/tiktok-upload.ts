// Fills TikTok Studio's upload form for a finished video: attaches the file,
// types the caption, turns on the AI-generated label, then either stops for
// the user to press Post or presses it when auto-post is on.
// NOTE: shares one global scope with panel.ts / content-scraper.ts (classic
// scripts), so every top-level name here is prefixed.

interface TtPostJob {
  videoId: string;
  caption: string;
  autoPost: boolean;
  aiLabel: boolean;
  fileName: string;
  /** TikTok Shop product ID to attach as the video's product link; null posts without one. */
  productId: string | null;
}

const TT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const TT_POST_RESULT_TIMEOUT_MS = 2 * 60_000;

const ttSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ttWaitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await ttSleep(intervalMs);
  }
  return null;
}

function ttSend<T = any>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        if (chrome.runtime.lastError) resolve(undefined);
        else resolve(response);
      });
    } catch {
      resolve(undefined); // extension reloaded under this tab
    }
  });
}

function ttBanner(text: string, color = "#111827") {
  let banner = document.getElementById("ai-affiliate-tiktok-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "ai-affiliate-tiktok-banner";
    Object.assign(banner.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "10px",
      color: "#fff",
      fontFamily: "sans-serif",
      fontSize: "13px",
      fontWeight: "600",
      boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
      maxWidth: "80vw",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.background = color;
}

function ttStatus(text: string, color = "#111827") {
  ttBanner(text, color);
  aiPanelStatus(text, color === "#111827" ? "#e5e7eb" : color);
}

async function ttReport(videoId: string, status: "ready" | "posted" | "failed", error?: string) {
  await ttSend({ type: "TIKTOK_POST_RESULT", videoId, status, error });
}

/* ---------- page reads ---------- */

function ttCaptionEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-e2e="caption_container"] .public-DraftEditor-content');
}

function ttPostButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-e2e="post_video_button"]');
}

function ttButtonEnabled(button: HTMLButtonElement | null): boolean {
  return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
}

/**
 * The editor's own DOM is not trustworthy after scripted input, but the
 * mobile preview is rendered from the editor state that actually gets
 * posted — so that is what gets checked.
 */
function ttPreviewHasCaption(caption: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const preview = document.querySelector<HTMLElement>('[data-e2e="mobile_preview_container"]')?.innerText ?? "";
  const head = squash(caption).slice(0, 24);
  if (!head || !squash(preview).includes(head)) return false;
  // The preview can show a stale or cut-off copy, so also check the editor's
  // own character counter — a wiped editor reads "0/4000" or "1/4000".
  const counted = Number(
    document.querySelector<HTMLElement>('[data-e2e="caption_container"]')?.innerText.match(/(\d+)\s*\/\s*4000/)?.[1] ?? NaN,
  );
  return !Number.isFinite(counted) || counted >= Array.from(caption.trim()).length * 0.8;
}

function ttUploadState(): "uploading" | "done" | "failed" {
  const status = document.querySelector<HTMLElement>('[data-e2e="upload_status_container"]');
  if (!status) return "uploading";
  const text = status.innerText;
  if (/fail|error|ไม่สำเร็จ|ล้มเหลว/i.test(text)) return "failed";
  if (/\d+(\.\d+)?\s*%/.test(text)) return "uploading";
  return ttButtonEnabled(ttPostButton()) ? "done" : "uploading";
}

function ttPrimaryButton(root: Element): HTMLButtonElement | null {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((b) => /type-primary/.test(b.className)) ?? buttons[buttons.length - 1] ?? null;
}

/**
 * First upload on an account asks to turn on automatic content checks — an
 * account setting, so decline it (the dialog has checkboxes; ours don't).
 */
function ttDismissSettingsDialogs() {
  for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
    if (!dialog.querySelector('input[type="checkbox"]')) continue;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
    const decline = buttons.find((b) => !/type-primary/.test(b.className));
    decline?.click();
  }
}

/* ---------- steps ---------- */

function ttBase64ToFile(base64: string, name: string, type: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}

async function ttAttachVideo(job: TtPostJob): Promise<string | null> {
  ttStatus("TikTok: กำลังโหลดไฟล์วิดีโอจากคลัง...");
  const file = await ttSend<{ ok: boolean; base64?: string; mimeType?: string; error?: string }>({
    type: "GET_TIKTOK_POST_FILE",
    videoId: job.videoId,
  });
  if (!file?.ok || !file.base64) return file?.error ?? "โหลดไฟล์วิดีโอจากคลังไม่สำเร็จ";

  const input = await ttWaitFor(() => document.querySelector<HTMLInputElement>('input[type="file"][accept*="video"]'), 60_000);
  if (!input) return "ไม่พบช่องอัปโหลดวิดีโอในหน้า TikTok Studio";

  const transfer = new DataTransfer();
  transfer.items.add(ttBase64ToFile(file.base64, job.fileName, file.mimeType ?? "video/mp4"));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  ttStatus("TikTok: กำลังอัปโหลดวิดีโอ...");
  const state = await ttWaitFor(() => {
    ttDismissSettingsDialogs();
    const s = ttUploadState();
    return s === "uploading" ? null : s;
  }, TT_UPLOAD_TIMEOUT_MS, 1000);
  if (state === "failed") return "TikTok แจ้งว่าอัปโหลดไม่สำเร็จ";
  if (!state) return "อัปโหลดวิดีโอขึ้น TikTok นานเกินไป";
  return null;
}

async function ttFillCaption(caption: string): Promise<string | null> {
  const editor = await ttWaitFor(ttCaptionEditor, 30_000);
  if (!editor) return "ไม่พบช่องคำอธิบายในหน้า TikTok";
  if (!caption.trim()) return null;

  ttStatus("TikTok: กำลังใส่แคปชัน...");
  editor.scrollIntoView({ block: "center" });
  editor.focus();
  await ttSleep(300);

  // Typed through chrome.debugger (real input events): TikTok's DraftJS
  // editor duplicates or drops hashtags on synthetic input, and a later
  // manual edit then crashes the page.
  // A second go usually lands when the first was swallowed by a focus change.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const typed = await ttSend<{ ok: boolean; error?: string }>({
      type: "TIKTOK_TYPE_CAPTION",
      caption,
      isMac: /Mac/i.test(navigator.platform),
    });
    if (!typed?.ok) return `พิมพ์แคปชันไม่สำเร็จ: ${typed?.error ?? "ไม่ทราบสาเหตุ"}`;
    if (await ttWaitFor(() => ttPreviewHasCaption(caption), 6_000)) return null;
    if (attempt === 1) {
      await aiPanelLog("TikTok: แคปชันไม่ติดในรอบแรก — พิมพ์ใหม่อีกครั้ง");
      // Close a leftover hashtag suggestion list before retyping.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await ttSleep(800);
    }
  }
  return "ใส่แคปชันแล้วแต่ตัวอย่างโพสต์ไม่แสดงข้อความ — ตรวจช่องคำอธิบายอีกครั้ง";
}

async function ttEnableAiLabel(): Promise<string | null> {
  const expand = document.querySelector<HTMLElement>(".more-collapse.collapsed");
  if (expand) {
    (expand.querySelector<HTMLElement>("button,[role=button]") ?? expand).click();
    await ttSleep(600);
  }
  const toggle = await ttWaitFor(
    () => document.querySelector<HTMLInputElement>('[data-e2e="aigc_container"] input[role="switch"]'),
    10_000,
  );
  if (!toggle) return "ไม่พบสวิตช์ป้าย AI-generated content";
  if (toggle.checked) return null;

  toggle.scrollIntoView({ block: "center" });
  toggle.click();
  // Turning it on asks for confirmation in a dialog first.
  const dialog = await ttWaitFor(() => document.querySelector('[role="dialog"]'), 5_000);
  if (dialog) ttPrimaryButton(dialog)?.click();
  const on = await ttWaitFor(() => toggle.checked, 5_000);
  return on ? null : "เปิดป้าย AI-generated content ไม่สำเร็จ";
}

const TT_PUBLIC_LABEL = /^(Everyone|Public|ทุกคน|สาธารณะ)$/i;

function ttVisibilityIsPublic(): boolean {
  const container = document.querySelector<HTMLElement>('[data-e2e="video_visibility_container"]');
  if (!container) return false;
  const select = container.querySelector<HTMLSelectElement>("select");
  if (select) return TT_PUBLIC_LABEL.test(select.selectedOptions[0]?.textContent?.trim() ?? "");
  return container.innerText.split("\n").some((line) => TT_PUBLIC_LABEL.test(line.trim()));
}

function ttVisibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], [role="menuitemradio"], li')).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** "Who can see this post" → Everyone. An account set to private can't pick it, which is reported rather than posting privately. */
async function ttSetVisibilityPublic(): Promise<string | null> {
  const container = await ttWaitFor(() => document.querySelector<HTMLElement>('[data-e2e="video_visibility_container"]'), 10_000);
  if (!container) return "ไม่พบช่องตั้งค่าว่าใครดูโพสต์ได้";
  if (ttVisibilityIsPublic()) return null;

  ttStatus("TikTok: กำลังตั้งค่าให้ทุกคนดูโพสต์ได้ (Everyone)...");
  container.scrollIntoView({ block: "center" });

  const select = container.querySelector<HTMLSelectElement>("select");
  if (select) {
    const option = Array.from(select.options).find((o) => TT_PUBLIC_LABEL.test(o.textContent?.trim() ?? ""));
    if (!option || option.disabled) return "ตั้งค่าเป็น Everyone ไม่ได้ — บัญชี TikTok อาจเป็นบัญชีส่วนตัว";
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const trigger =
      container.querySelector<HTMLElement>('[aria-haspopup], [role="combobox"], button') ??
      Array.from(container.querySelectorAll<HTMLElement>("div")).find((d) => /Followers|Friends|Only you|ผู้ติดตาม|เพื่อน|เฉพาะคุณ/i.test(d.innerText) && d.childElementCount <= 3);
    if (!trigger) return "ไม่พบเมนูเลือกว่าใครดูโพสต์ได้";
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    const option = await ttWaitFor(() => ttVisibleOptions().find((el) => TT_PUBLIC_LABEL.test(el.innerText.trim().split("\n")[0])), 5_000);
    if (!option) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return "ไม่พบตัวเลือก Everyone ในเมนู";
    }
    if (option.getAttribute("aria-disabled") === "true") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return "ตั้งค่าเป็น Everyone ไม่ได้ — บัญชี TikTok อาจเป็นบัญชีส่วนตัว";
    }
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      option.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  }

  const ok = await ttWaitFor(() => ttVisibilityIsPublic(), 5_000);
  return ok ? null : "ตั้งค่าเป็น Everyone ไม่สำเร็จ";
}

function ttDialogWith(pattern: RegExp): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  return dialogs.reverse().find((d) => pattern.test(d.innerText)) ?? null;
}

function ttButtonIn(root: Element, label: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.innerText.trim() === label) ?? null;
}

function ttProductLinkAttached(): boolean {
  const anchor = document.querySelector<HTMLElement>('[data-e2e="anchor_container"]');
  // With a link attached the section shows the product chip next to "Add".
  return !!anchor && anchor.innerText.replace(/Add link|Add/g, "").trim().length > 0;
}

/** Cancels every open TikTok dialog, newest first — used to back out of a failed product pick. */
async function ttCancelDialogs() {
  for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]')).reverse()) {
    ttButtonIn(dialog, "Cancel")?.click();
    await ttSleep(400);
  }
}

/**
 * Add link → Products → search the showcase by product ID → pick the row →
 * keep TikTok's suggested link name → Add. Only products in the account's
 * showcase can be linked.
 */
async function ttAddProductLink(productId: string): Promise<string | null> {
  if (ttProductLinkAttached()) return null;
  const anchor = await ttWaitFor(() => document.querySelector('[data-e2e="anchor_container"]'), 10_000);
  if (!anchor) return "บัญชี TikTok นี้ไม่มีเมนูเพิ่มลิงก์สินค้า (ต้องเป็นบัญชีที่เปิด TikTok Shop Affiliate)";

  ttStatus("TikTok: กำลังติดลิงก์สินค้า...");
  anchor.scrollIntoView({ block: "center" });
  ttButtonIn(anchor, "Add")?.click();

  const typeDialog = await ttWaitFor(() => ttDialogWith(/Link type/), 10_000);
  if (!typeDialog) return "ไม่เปิดหน้าต่างเลือกประเภทลิงก์";
  if (!/Products/.test(typeDialog.innerText)) {
    await ttCancelDialogs();
    return "ประเภทลิงก์ไม่มี Products ให้เลือก";
  }
  ttButtonIn(typeDialog, "Next")?.click();

  const selector = await ttWaitFor(() => document.querySelector<HTMLElement>(".product-selector-modal"), 15_000);
  const search = selector?.querySelector<HTMLInputElement>('input[type="text"]');
  if (!selector || !search) {
    await ttCancelDialogs();
    return "ไม่เปิดหน้าต่างเลือกสินค้า";
  }

  // React owns the input, so set it through the native setter for onChange to fire.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, productId);
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));

  const row = await ttWaitFor(
    () => Array.from(selector.querySelectorAll<HTMLElement>("tr.product-tb-row")).find((r) => r.innerText.includes(productId)),
    15_000,
  );
  if (!row) {
    await ttCancelDialogs();
    return `ไม่พบสินค้า ${productId} ใน Showcase ของบัญชีนี้ — เพิ่มสินค้าเข้า Showcase ก่อน`;
  }
  row.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
  await ttSleep(400);
  ttButtonIn(selector, "Next")?.click();

  const nameDialog = await ttWaitFor(() => ttDialogWith(/Product name will appear/), 10_000);
  if (!nameDialog) {
    await ttCancelDialogs();
    return "ไม่เปิดหน้าตั้งชื่อลิงก์สินค้า";
  }
  ttButtonIn(nameDialog, "Add")?.click();

  const attached = await ttWaitFor(() => !document.querySelector('[role="dialog"]') && ttProductLinkAttached(), 10_000);
  return attached ? null : "กดเพิ่มลิงก์สินค้าแล้วแต่ไม่เห็นสินค้าติดในโพสต์";
}

async function ttPressPost(job: TtPostJob): Promise<string | null> {
  const post = ttPostButton();
  if (!ttButtonEnabled(post)) return "ปุ่ม Post ยังกดไม่ได้";
  // Last guards before publishing: never post without the caption we typed or the product link asked for.
  if (job.caption.trim() && !ttPreviewHasCaption(job.caption)) return "แคปชันในตัวอย่างไม่ตรง — ไม่กดโพสต์ให้";
  if (job.productId && !ttProductLinkAttached()) return "ไม่เห็นลิงก์สินค้าติดในโพสต์ — ไม่กดโพสต์ให้";
  if (!ttVisibilityIsPublic()) return "โพสต์ยังไม่ได้ตั้งเป็น Everyone — ไม่กดโพสต์ให้";

  ttStatus("TikTok: กำลังกดโพสต์...");
  post!.click();

  const startPath = location.pathname;
  const outcome = await ttWaitFor(() => {
    if (location.pathname !== startPath) return "posted";
    const dialog = document.querySelector('[role="dialog"]');
    // "Continue to post?" style confirmations while checks are still running.
    if (dialog && /post|โพสต์/i.test((dialog as HTMLElement).innerText)) {
      const confirm = ttPrimaryButton(dialog);
      if (confirm && /post|โพสต์/i.test(confirm.innerText)) {
        confirm.click();
        return null;
      }
      return "dialog";
    }
    if (/posted|uploaded|โพสต์แล้ว|เผยแพร่แล้ว/i.test(document.body.innerText.slice(0, 5000)) && !ttPostButton()) return "posted";
    return null;
  }, TT_POST_RESULT_TIMEOUT_MS, 1000);

  if (outcome === "posted") return null;
  if (outcome === "dialog") return "TikTok มีหน้าต่างให้ยืนยันก่อนโพสต์ — ตรวจแล้วกดเองในหน้านี้";
  return "กดโพสต์แล้วแต่ไม่เห็นผลลัพธ์ — ตรวจในหน้า Posts ของ TikTok Studio";
}

async function ttRunPost(job: TtPostJob) {
  const fail = async (error: string) => {
    ttStatus(`TikTok: ${error}`, "#dc2626");
    await ttReport(job.videoId, "failed", error);
  };

  const attachError = await ttAttachVideo(job);
  if (attachError) return fail(attachError);

  ttDismissSettingsDialogs();
  const captionError = await ttFillCaption(job.caption);
  if (captionError) return fail(captionError);

  if (job.productId) {
    const linkError = await ttAddProductLink(job.productId);
    if (linkError) return fail(linkError);
  }

  const visibilityError = await ttSetVisibilityPublic();
  if (visibilityError) return fail(visibilityError);

  if (job.aiLabel) {
    ttStatus("TikTok: กำลังเปิดป้าย AI-generated content...");
    const labelError = await ttEnableAiLabel();
    if (labelError) return fail(labelError);
  }

  // What TikTok will actually publish, for the job log.
  const preview = document.querySelector<HTMLElement>('[data-e2e="mobile_preview_container"]')?.innerText ?? "";
  const anchorText = document.querySelector<HTMLElement>('[data-e2e="anchor_container"]')?.innerText.replace(/^Add link\s*Add\s*/, "") ?? "";
  const aiOn = document.querySelector<HTMLInputElement>('[data-e2e="aigc_container"] input[role="switch"]')?.checked;
  await aiPanelLog(`ตรวจฟอร์ม — ตัวอย่างโพสต์: ${preview.replace(/\s+/g, " ").slice(0, 200)} | ลิงก์สินค้า: ${anchorText || "-"} | ป้าย AI: ${aiOn ? "เปิด" : "ปิด"} | ใครดูได้: ${ttVisibilityIsPublic() ? "Everyone" : (document.querySelector<HTMLElement>('[data-e2e="video_visibility_container"]')?.innerText.replace(/\s+/g, " ") ?? "-")}`);

  const post = ttPostButton();
  post?.scrollIntoView({ block: "center" });

  if (!job.autoPost) {
    if (post) post.style.outline = "3px solid #f59e0b";
    ttStatus(
      `TikTok: เตรียมโพสต์เสร็จแล้ว — ตรวจวิดีโอ แคปชัน${job.productId ? " ลิงก์สินค้า" : ""} แล้วกด Post เองได้เลย`,
      "#16a34a",
    );
    await ttReport(job.videoId, "ready");
    return;
  }

  const postError = await ttPressPost(job);
  if (postError) return fail(postError);
  ttStatus("TikTok: โพสต์แล้ว ✓", "#16a34a");
  await ttReport(job.videoId, "posted");
}

let ttJobRunning = false;

async function ttClaimJob() {
  if (ttJobRunning || !/^\/tiktokstudio\/upload/.test(location.pathname)) return;
  const result = await ttSend<{ job: TtPostJob | null }>({ type: "CLAIM_TIKTOK_POST" });
  if (!result?.job) return;
  ttJobRunning = true;
  try {
    aiPanelClearLog();
    await ttRunPost(result.job);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ttStatus(`TikTok: เกิดข้อผิดพลาด: ${error}`, "#dc2626");
    await ttReport(result.job.videoId, "failed", error);
  } finally {
    ttJobRunning = false;
  }
}

ttClaimJob();

/* ---------- "+ AI Studio" buttons in the product picker ---------- */

interface TtPickerRow {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
}

const TT_PICKER_MARK = "data-ai-affiliate";

function ttReadPickerRow(row: HTMLElement): TtPickerRow | null {
  const cells = Array.from(row.querySelectorAll<HTMLElement>("td"));
  const tiktokId = cells.map((c) => c.innerText.trim()).find((t) => /^\d{12,22}$/.test(t));
  if (!tiktokId) return null;
  const nameCell = cells.find((c) => c.querySelector("img")) ?? cells[0];
  const name = Array.from(nameCell?.querySelectorAll<HTMLElement>("span,div,p") ?? [])
    .filter((el) => !el.closest(`[${TT_PICKER_MARK}]`) && el.childElementCount === 0)
    .map((el) => el.innerText.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  const priceText = cells.map((c) => c.innerText.trim()).find((t) => /^฿\s?[\d,.]+$/.test(t));
  const price = priceText ? Number(priceText.replace(/[^0-9.]/g, "")) : undefined;
  return {
    tiktokId,
    name: name || tiktokId,
    price: price && Number.isFinite(price) ? price : undefined,
    image: row.querySelector("img")?.src,
  };
}

async function ttImportRows(rows: TtPickerRow[], button: HTMLButtonElement, idleLabel: string) {
  button.disabled = true;
  button.textContent = "กำลังดึงรายละเอียด...";
  const result = await ttSend<{ ok: boolean; error?: string; products?: { name: string; images: number; detailed: boolean }[] }>({
    type: "IMPORT_TIKTOK_PRODUCT_DETAILS",
    products: rows,
  });
  button.disabled = false;
  if (!result?.ok) {
    button.textContent = "ลองใหม่";
    ttBanner(`AI Studio: เพิ่มสินค้าไม่สำเร็จ — ${result?.error ?? "ติดต่อส่วนขยายไม่ได้ (รีเฟรชหน้านี้)"}`, "#dc2626");
    return;
  }
  const items = result.products ?? [];
  const partial = items.filter((p) => !p.detailed).length;
  button.textContent = "✓ เพิ่มแล้ว";
  setTimeout(() => (button.textContent = idleLabel), 4000);
  ttBanner(
    items.length === 1
      ? `AI Studio: เพิ่ม "${items[0].name.slice(0, 40)}" แล้ว — รูป ${items[0].images} รูป${items[0].detailed ? " พร้อมรายละเอียด" : " (อ่านรายละเอียดจากหน้าสินค้าไม่ได้ ใช้ข้อมูลย่อ)"}`
      : `AI Studio: เพิ่มสินค้า ${items.length} รายการแล้ว${partial ? ` (${partial} รายการได้แค่ข้อมูลย่อ)` : " พร้อมรูปและรายละเอียด"}`,
    partial ? "#d97706" : "#16a34a",
  );
}

function ttPickerButton(label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(TT_PICKER_MARK, "");
  button.textContent = label;
  Object.assign(button.style, {
    marginTop: "6px",
    padding: "4px 10px",
    border: "none",
    borderRadius: "6px",
    background: "#2563eb",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  } satisfies Partial<CSSStyleDeclaration>);
  // The row itself selects the product on click — keep our button from doing that too.
  for (const type of ["pointerdown", "mousedown", "mouseup"]) button.addEventListener(type, (e) => e.stopPropagation());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(button);
  });
  return button;
}

function ttDecoratePicker() {
  const picker = document.querySelector<HTMLElement>(".product-selector-modal");
  if (!picker) return;

  for (const row of Array.from(picker.querySelectorAll<HTMLElement>("tr.product-tb-row"))) {
    if (row.querySelector(`[${TT_PICKER_MARK}]`)) continue;
    const data = ttReadPickerRow(row);
    // The Status column: the name column is a flex layout that an extra child breaks.
    const statusCell = row.querySelector<HTMLElement>("td:last-child");
    if (!data || !statusCell) continue;
    const wrap = document.createElement("div");
    wrap.setAttribute(TT_PICKER_MARK, "");
    wrap.appendChild(ttPickerButton("+ AI Studio", (button) => ttImportRows([data], button, "+ AI Studio")));
    statusCell.appendChild(wrap);
  }

  const search = picker.querySelector<HTMLInputElement>('input[type="text"]');
  const searchBox = search?.closest<HTMLElement>("div[class]")?.parentElement;
  if (searchBox && !picker.querySelector(`[${TT_PICKER_MARK}="all"]`)) {
    const all = ttPickerButton("+ เพิ่มทุกสินค้าในหน้านี้ไป AI Studio", (button) => {
      const rows = Array.from(picker.querySelectorAll<HTMLElement>("tr.product-tb-row"))
        .map(ttReadPickerRow)
        .filter((r): r is TtPickerRow => !!r);
      ttImportRows(rows, button, "+ เพิ่มทุกสินค้าในหน้านี้ไป AI Studio");
    });
    all.setAttribute(TT_PICKER_MARK, "all");
    all.style.marginLeft = "12px";
    searchBox.insertAdjacentElement("afterend", all);
  }
}

// The picker is a modal React mounts and re-renders on search and paging.
let ttDecorateScheduled = false;
new MutationObserver(() => {
  if (ttDecorateScheduled) return;
  ttDecorateScheduled = true;
  requestAnimationFrame(() => {
    ttDecorateScheduled = false;
    ttDecoratePicker();
  });
}).observe(document.body, { childList: true, subtree: true });
