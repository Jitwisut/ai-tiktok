// Classic content script, scoped to Shopee Seller Centre. Never submit a job twice.
interface SpJob {
  videoId: string; caption: string; autoPost: boolean; fileName: string;
  productUrl: string; productName: string; shopId: string; itemId: string;
}
const spSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function spSend<T>(message: unknown): Promise<T> { return chrome.runtime.sendMessage(message); }
function spVisible(el: Element): boolean { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }
function spText(el: Element): string { return (el.textContent ?? "").replace(/\s+/g, " ").trim(); }
function spButton(pattern: RegExp, root: ParentNode = document): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"]')).find((el) => spVisible(el) && pattern.test(spText(el)));
}
function spEnabled(el: HTMLElement | undefined): el is HTMLElement { return !!el && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true"; }
async function spWait<T>(read: () => T | null | undefined | false, timeout = 30_000): Promise<T | null> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = read(); if (value) return value; await spSleep(500); }
  return null;
}
function spStatus(message: string): void {
  let banner = document.getElementById("ai-affiliate-shopee-banner");
  if (!banner) {
    banner = document.createElement("div"); banner.id = "ai-affiliate-shopee-banner";
    Object.assign(banner.style, { position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "12px 18px", background: "#ee4d2d", color: "white", borderRadius: "10px", font: "600 13px sans-serif", maxWidth: "80vw" });
    document.body.appendChild(banner);
  }
  banner.textContent = message;
}
function spDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],.shopee-modal,.shopee-dialog,.eds-react-modal__content')).filter(spVisible).pop() ?? null;
}
function spSetValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
}
function spCaptionInput(root: ParentNode = document): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],input[type="text"]')).find((el) =>
    spVisible(el) && /caption|แคปชั่น|แคปชัน|คำบรรยาย|description/i.test([el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.className, el.parentElement?.textContent].join(" ")),
  ) ?? null;
}
function spValue(el: HTMLElement): string { return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText; }
function spMatchingLink(link: HTMLAnchorElement, job: SpJob): boolean {
  try {
    const url = new URL(link.href);
    if (url.protocol !== "https:" || !/(^|\.)shopee\.co\.th$/i.test(url.hostname)) return false;
    const ids = url.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:\/|$)/);
    return ids?.[1] === job.shopId && ids[2] === job.itemId;
  } catch { return false; }
}
async function spFillCaption(job: SpJob): Promise<void> {
  let editor = spCaptionInput();
  if (!editor) {
    const open = spButton(/^(เพิ่ม|แก้ไข)แคปชั่?น$|^Add caption$|^Edit caption$/i);
    if (!open) throw new Error("ไม่พบช่องแคปชัน Shopee");
    open.click(); editor = await spWait(() => spCaptionInput(spDialog() ?? document));
  }
  if (!editor) throw new Error("เปิดช่องแคปชัน Shopee ไม่สำเร็จ");
  spStatus("Shopee: กำลังใส่แคปชัน...");
  editor.setAttribute("data-ai-shopee-caption", "true");
  const typed = await spSend<{ ok: boolean; error?: string }>({ type: "SHOPEE_TYPE_CAPTION", videoId: job.videoId, isMac: /Mac/i.test(navigator.platform) });
  if (!typed.ok) throw new Error(typed.error ?? "พิมพ์แคปชันไม่สำเร็จ");
  const expected = job.caption.replace(/\s+/g, "");
  if (!(await spWait(() => spValue(editor!).replace(/\s+/g, "") === expected, 6_000))) throw new Error("ข้อความแคปชันไม่ครบ — ตรวจแบบฟอร์มก่อนโพสต์");
  const dialog = spDialog();
  if (dialog) {
    const save = spButton(/^(ยืนยัน|บันทึก|ตกลง|Confirm|Save|OK)$/i, dialog);
    if (!spEnabled(save)) throw new Error("ไม่พบปุ่มบันทึกแคปชัน");
    save.click();
    if (!(await spWait(() => !spVisible(dialog), 10_000))) throw new Error("บันทึกแคปชันไม่สำเร็จ");
    const preview = Array.from(document.querySelectorAll<HTMLElement>('tr,[role="row"],.video-item,.video-upload-item')).find((el) => spText(el).includes(job.fileName));
    if (!preview || !spText(preview).replace(/\s+/g, "").includes(expected.slice(0, 20))) throw new Error("ยังยืนยันแคปชันที่บันทึกไม่ได้");
  }
}
function spExactProduct(root: ParentNode, job: SpJob): HTMLElement | null {
  // Match the exact item ID/link; never fall back to the first search result or a similar name.
  const rows = Array.from(root.querySelectorAll<HTMLElement>('tr,[role="row"],.product-item,.item-card,.shopee-table__row,.eds-react-table__row'));
  return rows.find((row) => {
    if (!spVisible(row)) return false;
    const link = Array.from(row.querySelectorAll<HTMLAnchorElement>('a[href]')).find((el) => spMatchingLink(el, job));
    const labelledId = new RegExp(`(?:item\\s*id|รหัสสินค้า)\\s*[:：]?\\s*${job.itemId}(?!\\d)`, "i").test(spText(row));
    return !!link || labelledId || row.getAttribute("data-item-id") === job.itemId;
  }) ?? null;
}
async function spAttachProduct(job: SpJob): Promise<void> {
  spStatus("Shopee: กำลังปักสินค้าที่ตรงกับคลิป...");
  const add = Array.from(document.querySelectorAll<HTMLElement>('[class*="CaptionEdit---addProduct--"]')).find(spVisible) ?? spButton(/^เพิ่มสินค้า(?:\s*\(.*\))?$|^Add products?$/i);
  if (!add) throw new Error("ไม่พบปุ่มเพิ่มสินค้า Shopee");
  add.click();
  const dialog = await spWait(spDialog);
  if (!dialog) throw new Error("ไม่พบหน้าต่างเลือกสินค้า");
  const linkTab = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"],button,.shopee-tabs__nav-tab')).find((el) => spVisible(el) && /ลิงก์|link/i.test(spText(el)));
  linkTab?.click(); await spSleep(400);
  const search = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="checkbox"]):not([type="radio"]),textarea')).find((el) => spVisible(el) && /ลิงก์|link|URL|ค้นหา|search|รหัส|ID/i.test([el.placeholder, el.getAttribute("aria-label")].join(" ")));
  if (!search) throw new Error("ไม่พบช่องค้นหาด้วยรหัสหรือลิงก์สินค้า — ตรวจสิทธิ์เพิ่มสินค้าของบัญชี");
  const useUrl = /ลิงก์|link|url/i.test([search.placeholder, search.getAttribute("aria-label")].join(" "));
  spSetValue(search, useUrl ? job.productUrl : /ชื่อสินค้า|product name/i.test(search.placeholder) ? job.productName : job.itemId);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  const searchButton = spButton(/^(ค้นหา|Search|เพิ่ม|Add|ยืนยัน)$/i, dialog);
  if (spEnabled(searchButton)) searchButton.click();
  const row = await spWait(() => spExactProduct(dialog, job), 30_000);
  if (!row) throw new Error(`Seller Centre ไม่แสดงสินค้า ${job.itemId} ให้บัญชีนี้เลือก — ลิงก์ที่นำเข้าโปรแกรมไม่ได้เพิ่มสินค้าในตัวเลือกของ Shopee ใช้คลิปเดิมจากคลัง → ดาวน์โหลดสำหรับแอป Shopee → เพิ่มสินค้า Affiliate ในแอปก่อนโพสต์`);
  const box = row.querySelector<HTMLElement>('input[type="checkbox"],[role="checkbox"],.shopee-checkbox,.eds-react-checkbox');
  if (!box) throw new Error("พบสินค้าแต่ไม่พบปุ่มเลือกสินค้า");
  if (!(box instanceof HTMLInputElement ? box.checked : box.getAttribute("aria-checked") === "true" || box.classList.contains("checked"))) box.click();
  const confirm = spButton(/^(ยืนยัน|เพิ่ม|ตกลง|Confirm|Add|OK)(?:\s*\(\d+\))?$/i, dialog.querySelector('.eds-react-modal__footer') ?? dialog);
  if (!spEnabled(confirm)) throw new Error("ยังยืนยันการเลือกสินค้าไม่ได้");
  const name = row.querySelector<HTMLElement>('.product-name,[class*="product-name"],a')?.textContent?.trim();
  confirm.click();
  if (!(await spWait(() => !spVisible(dialog), 10_000))) throw new Error("ปักสินค้าไม่สำเร็จ");
  // The selection modal may hide IDs in the compact preview. Match the canonical product link or the exact selected product name.
  const verified = await spWait(() => {
    const linked = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).some((el) => spVisible(el) && spMatchingLink(el, job));
    if (linked) return true;
    if (!name || name.length < 6) return false;
    const singleProductField = Array.from(document.querySelectorAll<HTMLElement>('.eds-react-form-item')).find((el) =>
      spVisible(el) && /^(สินค้า|Products?)$/i.test(spText(el.querySelector('.eds-react-form-item__label') ?? el.querySelector('label') ?? document.createElement('span'))),
    );
    return (singleProductField && spText(singleProductField).includes(name)) || Array.from(document.querySelectorAll<HTMLElement>('tr,[role="row"],.video-item,.video-upload-item')).some((el) => spText(el).includes(job.fileName) && spText(el).includes(name));
  }, 10_000);
  if (!verified) throw new Error("ยังยืนยันสินค้าที่ปักในตัวอย่างโพสต์ไม่ได้ — ตรวจแบบฟอร์ม Shopee");
}
function spConsent(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('label,[role="checkbox"],.shopee-checkbox,.eds-react-checkbox')).find((el) => spVisible(el) && /ยอมรับ.*เงื่อนไข|agree.*terms|accept.*terms/i.test(spText(el))) ?? null;
}
async function spEnsureActive(job: SpJob): Promise<void> {
  const result = await spSend<{ ok: boolean; error?: string }>({ type: "SHOPEE_CHECK_JOB", videoId: job.videoId });
  if (!result.ok) throw new Error(result.error ?? "งานนี้ถูกยกเลิกหรือเริ่มโพสต์แล้ว");
}
function spAiToggle(): HTMLElement | null {
  const switches = '.eds-react-switch,[role="switch"]';
  const label = /เพิ่มป้ายกำกับ\s*AI|AI\s*(?:content\s*)?label/i;
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[class*="aigcLabelTitleRow"]')).filter(spVisible);
  const exact = rows.flatMap((row) => label.test(spText(row)) ? Array.from(row.querySelectorAll<HTMLElement>(switches)).filter(spVisible) : []);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  // Only accept a small row with one switch; the whole form also contains the reuse switch.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(switches)).filter((toggle) => {
    if (!spVisible(toggle)) return false;
    let row = toggle.parentElement;
    for (let depth = 0; row && depth < 3; depth++, row = row.parentElement) {
      if (label.test(spText(row))) return Array.from(row.querySelectorAll<HTMLElement>(switches)).filter(spVisible).length === 1;
    }
    return false;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
function spAiState(toggle: HTMLElement | null): boolean | null {
  if (!toggle) return null;
  const checked = toggle.getAttribute("aria-checked");
  if (checked === "true" || checked === "false") return checked === "true";
  if (toggle.classList.contains("eds-react-switch--open")) return true;
  if (toggle.classList.contains("eds-react-switch--close")) return false;
  return null;
}
async function spAiLabel(): Promise<void> {
  const toggle = await spWait(spAiToggle, 5000);
  if (!toggle) throw new Error("ไม่พบตัวเลือกป้าย AI — ตรวจแบบฟอร์ม Shopee");
  const state = spAiState(toggle);
  if (state === null) throw new Error("อ่านสถานะป้าย AI ไม่ได้ — ตรวจแบบฟอร์ม Shopee");
  if (state) return;
  if (!spEnabled(toggle)) throw new Error("ตัวเลือกป้าย AI ยังไม่พร้อม");
  toggle.click();
  // React can replace controls after caption edits. Always read the current live switch.
  if (await spWait(() => spAiState(spAiToggle()) === true, 5000)) return;
  const current = spAiToggle();
  if (!current || spAiState(current) !== false || !spEnabled(current)) throw new Error("เปิดป้ายกำกับ AI ไม่สำเร็จ");
  current.setAttribute("data-ai-shopee-label", "true");
  try {
    const result = await spSend<{ ok: boolean; error?: string }>({ type: "TRUSTED_CLICK", selector: '[data-ai-shopee-label="true"]' });
    if (!result.ok) throw new Error(result.error ?? "กดป้ายกำกับ AI ไม่สำเร็จ");
    if (!(await spWait(() => spAiState(spAiToggle()) === true, 5000))) throw new Error("เปิดป้ายกำกับ AI ไม่สำเร็จ");
  } finally { current.removeAttribute("data-ai-shopee-label"); }
}
async function spRun(job: SpJob): Promise<void> {
  let submitted = false;
  try {
    await extensionRequireLicense();
    const input = await spWait(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
      return inputs.find((el) => /video|mp4/i.test(el.accept) || (!el.accept && inputs.length === 1));
    }, 60_000);
    if (!input) throw new Error("ไม่พบช่องอัปโหลดวิดีโอ Shopee — ล็อกอินบัญชีใน Chrome แล้วเริ่มเตรียมโพสต์ใหม่");
    spStatus("Shopee: กำลังอัปโหลดวิดีโอจากคลัง...");
    const file = await spSend<{ ok: boolean; base64?: string; mimeType?: string; error?: string }>({ type: "GET_SHOPEE_POST_FILE", videoId: job.videoId });
    if (!file.ok || !file.base64) throw new Error(file.error ?? "อ่านไฟล์วิดีโอไม่สำเร็จ");
    const binary = atob(file.base64); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], job.fileName, { type: file.mimeType ?? "video/mp4" }));
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    const loaded = await spWait(() => spCaptionInput() || spButton(/^(เพิ่ม|แก้ไข)แคปชั่?น$|^Add caption$/i), 10 * 60_000);
    if (!loaded) throw new Error("อัปโหลด Shopee นานเกินไปหรือไฟล์ถูกปฏิเสธ");
    await spEnsureActive(job); await spFillCaption(job); await spAiLabel(); await spAttachProduct(job); await spEnsureActive(job);
    if (!job.autoPost) {
      spStatus("Shopee: วิดีโอ แคปชัน และสินค้าเตรียมครบแล้ว — ตรวจแล้วกดยอมรับเงื่อนไขและโพสต์");
      await spSend({ type: "SHOPEE_POST_RESULT", videoId: job.videoId, status: "ready" });
      // Block the original click until the background has persisted the marker.
      let manualSubmitting = false;
      let allowSiteClick = false;
      document.addEventListener("click", (event) => {
        const button = (event.target as Element | null)?.closest('button,[role="button"]');
        if (!(button instanceof HTMLElement) || !/^(โพสต์|Post|Publish)$/i.test(spText(button))) return;
        if (allowSiteClick) { allowSiteClick = false; return; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (manualSubmitting || !spEnabled(button)) return;
        manualSubmitting = true;
        void extensionRequireLicense().then(() => spSend<{ ok: boolean; error?: string }>({ type: "SHOPEE_POST_SUBMITTING", videoId: job.videoId })).then((result) => {
          if (!result.ok) throw new Error(result.error ?? "บันทึกสถานะก่อนโพสต์ไม่สำเร็จ — ตรวจผลในคลังก่อนทำต่อ");
          allowSiteClick = true; button.click(); return spObservePublished(job);
        }).catch(async error => {
          if (await extensionReportLicensePause(job.videoId, error)) spStatus(error instanceof Error ? error.message : String(error));
          else spStatus("Shopee: ยังยืนยันผลโพสต์ไม่ได้ — ตรวจบัญชีและสถานะในคลังก่อนทำต่อ");
        }).finally(() => { manualSubmitting = false; });
      }, { capture: true, once: false });
      return;
    }
    const consent = spConsent();
    if (!consent) throw new Error("ไม่พบตัวเลือกยอมรับเงื่อนไข Shopee — ตรวจแบบฟอร์มก่อนโพสต์");
    const checkbox = consent instanceof HTMLInputElement ? consent : consent.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!(checkbox?.checked || consent.getAttribute("aria-checked") === "true" || consent.classList.contains("checked"))) consent.click();
    const post = await spWait(() => { const button = spButton(/^(โพสต์|Post|Publish)$/i); return spEnabled(button) ? button : null; }, 15_000);
    if (!post) throw new Error("ปุ่มโพสต์ Shopee ยังไม่พร้อม — ตรวจข้อมูลสินค้าและการอัปโหลด");
    await extensionRequireLicense();
    const marker = await spSend<{ ok: boolean; error?: string }>({ type: "SHOPEE_POST_SUBMITTING", videoId: job.videoId });
    if (!marker.ok) throw new Error(marker.error ?? "บันทึกสถานะก่อนโพสต์ไม่สำเร็จ");
    submitted = true; post.click(); await spObservePublished(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!submitted && await extensionReportLicensePause(job.videoId, error)) { spStatus(message); return; }
    spStatus(`Shopee: ${message}`);
    await spSend({ type: "SHOPEE_POST_RESULT", videoId: job.videoId, status: submitted ? "uncertain" : "failed", error: message }).catch(() => {});
  }
}
async function spObservePublished(job: SpJob): Promise<void> {
  const result = await spWait(() => {
    const notifications = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"],[role="status"],.shopee-toast,.shopee-message,.shopee-modal,.eds-react-toast,.eds-react-message,.eds-react-notification,.eds-react-modal__content')).filter(spVisible).map(spText).join(" ");
    if (/ไม่สำเร็จ|failed|unsuccessful/i.test(notifications)) return "uncertain" as const;
    if (/โพสต์.*สำเร็จ|เผยแพร่.*สำเร็จ|published successfully|posted successfully|successfully published/i.test(notifications)) return "posted" as const;
    return null;
  }, 120_000);
  await spSend({ type: "SHOPEE_POST_RESULT", videoId: job.videoId, status: result ?? "uncertain", error: result === "posted" ? undefined : "ยังยืนยันผลโพสต์ไม่ได้ — ตรวจ Shopee ก่อนเริ่มใหม่" });
  spStatus(result === "posted" ? "Shopee: โพสต์สำเร็จแล้ว ✓" : "Shopee: ตรวจผลโพสต์ในบัญชีก่อนทำต่อ เพื่อป้องกันโพสต์ซ้ำ");
}
let spStarted = false;
async function spClaim(): Promise<void> {
  if (spStarted || !location.pathname.includes("/creator-center/video-upload/")) return;
  const result = await spSend<{ job?: SpJob }>({ type: "CLAIM_SHOPEE_POST" }).catch(() => null);
  if (result?.job) { spStarted = true; await spRun(result.job); }
}
void spClaim();
// Seller Centre is an SPA; log-in redirects may return here without reinjecting the script.
setInterval(() => { void spClaim(); }, 4000);
