import { initLicensePanel } from "./license-panel.js";
import { SHOPEE_STYLES, shopeeProductLink, type PublishPlatform } from "./lib/commerce.js";
// The one big UI. Runs as a real extension page (not injected into someone
// else's site), so it can use real ES module imports straight into the
// IndexedDB clip library, and talks to background.ts for everything else.

import { getClipsForVideo, MERGED_CLIP_INDEX } from "./lib/library.js";
import { CONTENT_STYLES } from "./lib/analysis-prompts.js";
import { styleLabel } from "./lib/style-playbooks.js";
import { clipCountFor, clipSecondsForSite, durationOptions } from "./lib/prompt-engine.js";
import { stepLabel, type AutopilotState } from "./lib/autopilot.js";
import { initPhonePanel } from "./phone-panel.js";

/* ---------- shared helpers ---------- */

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/**
 * Reloading the extension leaves an already-open side panel orphaned: every
 * sendMessage rejects, and since callers only handle a resolved response the
 * buttons just stopped doing anything with no trace. Say so instead, and
 * resolve with a normal failure so callers restore their buttons.
 */
function send<T = any>(message: unknown): Promise<T> {
  try {
    return chrome.runtime.sendMessage(message).catch((err: unknown) => {
      log(`ติดต่อส่วนขยายไม่ได้ (${err instanceof Error ? err.message : String(err)}) — ปิดแล้วเปิด side panel ใหม่`);
      return { ok: false, error: "ติดต่อส่วนขยายไม่ได้" } as T;
    });
  } catch (err) {
    log(`ส่วนขยายถูกโหลดใหม่ — ปิดแล้วเปิด side panel ใหม่ (${err instanceof Error ? err.message : String(err)})`);
    return Promise.resolve({ ok: false, error: "ส่วนขยายถูกโหลดใหม่" } as T);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function log(text: string) {
  const list = $("log");
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString("th-TH")} — ${text}`;
  list.prepend(line);
  while (list.children.length > 20) list.lastElementChild?.remove();

  // The log lives on the Products tab; mirror the newest line as a toast so
  // feedback from the other tabs (autopilot, library, settings) is seen too.
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4500);
}

/** Builds an element from tag + class + text — never parses scraped text as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Product / video thumbnail that degrades to an empty tile instead of a broken-image icon. */
function thumb(src: string | null | undefined, className = "thumb"): HTMLImageElement {
  const img = el("img", className);
  img.alt = "";
  img.loading = "lazy";
  if (src) img.src = src;
  img.addEventListener("error", () => img.removeAttribute("src"), { once: true });
  return img;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/* ---------- tabs ---------- */

const phonePanel = initPhonePanel({
  getVideos: async () => {
    const result = await send<{ ok: boolean; videos: CompletedVideo[]; error?: string }>({ type: "GET_COMPLETED_VIDEOS" });
    if (!result.ok) throw new Error(result.error ?? "โหลดคลิปไม่สำเร็จ");
    return result.videos;
  },
  resolve: async videoId => {
    const result = await send<{ ok: boolean; error?: string }>({ type: "RESOLVE_SHOPEE_POST", videoId, posted: true });
    if (!result.ok) throw new Error(result.error ?? "บันทึกผลโพสต์ไม่สำเร็จ");
  },
});
const TABS = ["products", "library", "autopilot", "phone", "settings"] as const;
type TabName = (typeof TABS)[number];

function showTab(name: TabName) {
  for (const tab of TABS) {
    $(`view-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).classList.toggle("active", tab === name);
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
  }
  window.scrollTo({ top: 0 });
  if (name === "library") loadLibrary();
  if (name === "autopilot") loadAutopilot();
  void phonePanel.setVisible(name === "phone");
}

for (const tab of TABS) {
  $(`tab-${tab}`).addEventListener("click", () => showTab(tab));
}

/* ================= Products tab ================= */

interface AppProduct {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  status?: string;
  source: string;
  sourceUrl: string | null;
  images: string[];
}

interface ScrapedTikTokProduct {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
}

interface ProductAnalysisResult {
  targetCustomer: string;
  painPoints: string[];
  sellingPoints: string[];
  angles: string[];
}

interface GeneratedContent {
  id: string;
  hook: string;
  script: string;
  caption: string;
  cta: string;
  onScreenText?: string;
  onScreenCta?: string;
  angle?: string;
}

interface GeneratedScene {
  duration: number;
  description: string;
  visual?: string;
  clip?: number;
  dialogue?: string;
  voiceover?: string;
}

let products: AppProduct[] = [];
const selected = new Set<string>();

let reviewProductId: string | null = null;
let activeAnalysis: ProductAnalysisResult | null = null;
let activeContent: GeneratedContent | null = null;
let activeScenes: GeneratedScene[] = [];

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Lengths depend on the site (joined 8s clips on Flow/AI Studio, joined 10s
 * scenes on Meta AI, one generation of the whole length on Gemini), so
 * rebuild the list when the site changes — keeping the closest length to what
 * was picked (16s on Flow becomes 20s on Meta, never a value the new list has
 * no option for).
 */
function renderDurationOptions(durationSelect: HTMLSelectElement, site: string) {
  const previous = Number(durationSelect.value);
  const options = durationOptions(site);
  durationSelect.innerHTML = options
    .map((value) => {
      const clips = clipCountFor(value, clipSecondsForSite(site, value));
      return `<option value="${value}">${value} วิ · ${clips === 1 ? "คลิปเดียว" : `ต่อ ${clips} คลิป`}</option>`;
    })
    .join("");
  if (previous) {
    const closest = options.reduce((best, v) => (Math.abs(v - previous) < Math.abs(best - previous) ? v : best));
    durationSelect.value = String(closest);
  }
}

function bindDurationToSite(durationId: string, siteId: string) {
  const durationSelect = $(durationId) as HTMLSelectElement;
  const siteSelect = $(siteId) as HTMLSelectElement;
  renderDurationOptions(durationSelect, siteSelect.value);
  siteSelect.addEventListener("change", () => renderDurationOptions(durationSelect, siteSelect.value));
}

/** Thai names in the picker; the option value stays the English style key used by prompts and storage. */
function styleOptions(platform: PublishPlatform = "tiktok"): string {
  return (platform === "shopee" ? SHOPEE_STYLES : CONTENT_STYLES).map((s) => `<option value="${s}" title="${escapeHtml(styleLabel(s).description)}">${escapeHtml(styleLabel(s).name)}</option>`).join("");
}

/** Shows what the chosen style looks like under its picker, and keeps it in sync. */
function bindStyleDescription(selectId: string, descId: string, rotateText?: string) {
  const select = $(selectId) as HTMLSelectElement;
  const desc = $(descId);
  const render = () => {
    desc.textContent = select.value === "rotate" && rotateText ? rotateText : styleLabel(select.value).description;
  };
  select.addEventListener("change", render);
  render();
}

function populateStyles() {
  const select = $("style") as HTMLSelectElement;
  select.innerHTML = styleOptions();
  bindStyleDescription("style", "style-desc");
}

function setCatalogStatus(text: string) {
  const status = $("catalog-status");
  status.textContent = text;
  status.hidden = !text;
}

function updateSelectionCount() {
  const deleteBtn = $("delete-selected") as HTMLButtonElement;
  const resetBtn = $("reset-selection") as HTMLButtonElement;
  deleteBtn.textContent = `Delete (${selected.size})`;
  deleteBtn.disabled = selected.size === 0;
  resetBtn.textContent = `Reset (${selected.size})`;
  $("product-count").textContent = `${products.length} ชิ้น`;
  $("selection-label").textContent = selected.size ? `เลือกแล้ว ${selected.size} ชิ้น` : "ยังไม่ได้เลือก";

  // Which product the studio steps will run on — the flow needs exactly one.
  const target = $("studio-target");
  const [onlyId] = selected;
  const product = selected.size === 1 ? products.find((p) => p.id === onlyId) : undefined;
  target.replaceChildren();
  target.classList.toggle("is-ready", !!product);
  if (product) {
    target.append(thumb(product.images[0], ""), el("span", "", product.name));
  } else {
    target.append(el("span", "", selected.size > 1 ? `เลือกไว้ ${selected.size} ชิ้น — สร้างวิดีโอได้ทีละ 1 ชิ้น` : "เลือกสินค้า 1 ชิ้นจากคลังด้านบน"));
  }
}

function productPlatform(product: AppProduct): "shopee" | "tiktok" | null {
  if (shopeeProductLink(product.sourceUrl)) return "shopee";
  if (tiktokIdFromSourceUrl(product.sourceUrl) || product.source === "tiktok") return "tiktok";
  return null;
}

function renderProductsTable() {
  const list = $("products-tbody");
  list.replaceChildren();

  if (products.length === 0) {
    const empty = el("div", "empty");
    empty.append(
      el("strong", "", "ยังไม่มีสินค้าในคลัง"),
      el("span", "", 'เปิดหน้า TikTok Shop หรือ Shopee แล้วกด "ดึงจากหน้า TikTok" / "ดึงจากหน้า Shopee" ด้านบน'),
    );
    list.append(empty);
    return;
  }

  for (const product of products) {
    const row = el("label", "product-row");
    row.setAttribute("role", "listitem");
    row.title = product.name;
    // The checkbox stays the row's first input — selection reads it by querySelector("input").
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(product.id);
    checkbox.setAttribute("aria-label", `เลือก ${product.name}`);
    row.classList.toggle("is-selected", checkbox.checked);

    const meta = el("div", "product-meta");
    meta.append(el("div", "product-name", product.name));
    const sub = el("div", "product-sub");
    sub.append(el("span", "product-price", product.price ? `฿${product.price}` : "ไม่มีราคา"));
    const platform = productPlatform(product);
    if (platform) sub.append(el("span", `tag tag-${platform}`, platform === "shopee" ? "Shopee" : "TikTok"));
    const id = el("span", "product-id", product.id);
    id.title = product.id;
    sub.append(id);
    meta.append(sub);

    row.append(checkbox, thumb(product.images[0]), meta);
    row.querySelector("input")?.addEventListener("change", (event) => {
      if ((event.target as HTMLInputElement).checked) selected.add(product.id);
      else selected.delete(product.id);
      row.classList.toggle("is-selected", (event.target as HTMLInputElement).checked);
      updateSelectionCount();
      resetReview();
    });
    list.appendChild(row);
  }
}

function loadProducts() {
  send<{ ok: boolean; products?: AppProduct[]; error?: string }>({ type: "GET_TIKTOK_PRODUCTS" }).then((result) => {
    if (!result?.ok) {
      setCatalogStatus(result?.error ?? "โหลดสินค้าไม่สำเร็จ");
      return;
    }
    products = result.products ?? [];
    selected.clear();
    renderProductsTable();
    updateSelectionCount();
  });
}

async function getProductFromTikTok() {
  const tabId = await activeTabId();
  if (!tabId) return;

  const button = $("get-product") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "กำลังดึง...";

  let scraped: ScrapedTikTokProduct[] = [];
  try {
    scraped = (await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_CHECKED_PRODUCTS" })) ?? [];
  } catch {
    log("อ่านหน้านี้ไม่ได้ — เปิดหน้า TikTok Shop/Studio แล้วลองใหม่");
  }

  button.disabled = false;
  button.textContent = "ดึงจากหน้า TikTok";

  if (scraped.length === 0) {
    log("ไม่พบสินค้าที่เลือกในหน้านี้ — ติ๊กเลือกสินค้าในตารางของ TikTok ก่อน");
    return;
  }

  const result = await send<{ ok: boolean; error?: string }>({ type: "IMPORT_TIKTOK_PRODUCTS", products: scraped });
  if (!result?.ok) {
    log(result?.error ?? "โหลดสินค้าไม่สำเร็จ");
    return;
  }
  log(`เพิ่มแล้ว ${scraped.length} รายการจากหน้านี้`);
  loadProducts();
}

interface ExtractedProduct {
  url: string;
  name?: string;
  description?: string;
  price?: string;
  image?: string;
  images?: string[];
}

async function addFromCurrentPage() {
  const tabId = await activeTabId();
  if (!tabId) return;

  let extracted: ExtractedProduct | { error: string } | null = null;
  try {
    extracted = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PRODUCT" });
  } catch {
    log("อ่านหน้านี้ไม่ได้");
    return;
  }
  if (!extracted) return;
  if ("error" in extracted) {
    log(extracted.error);
    return;
  }

  const result = await send<{ ok: boolean; error?: string }>({ type: "ADD_PRODUCT", product: extracted });
  if (!result?.ok) {
    log(result?.error ?? "เพิ่มสินค้าไม่สำเร็จ");
    return;
  }
  log(`เพิ่ม "${extracted.name ?? extracted.url}" แล้ว`);
  loadProducts();
}

function deleteSelected() {
  if (selected.size === 0) return;
  const ids = [...selected];
  send<{ ok: boolean; count?: number; error?: string }>({ type: "DELETE_TIKTOK_PRODUCTS", ids }).then((result) => {
    if (!result?.ok) {
      log(result?.error ?? "ลบสินค้าไม่สำเร็จ");
      return;
    }
    log(`ลบแล้ว ${result.count ?? ids.length} รายการ`);
    loadProducts();
  });
}

function resetSelection() {
  selected.clear();
  renderProductsTable();
  updateSelectionCount();
  resetReview();
  log("ล้างการเลือกแล้ว");
}

/* ---------- review flow ---------- */

function resetReview() {
  reviewProductId = null;
  activeAnalysis = null;
  activeContent = null;
  activeScenes = [];
  renderReview();
  (($("create-video") as HTMLButtonElement)).disabled = true;
}

function reviewHead(icon: string, title: string, note?: string): HTMLElement {
  const head = el("div", "review-head");
  const ic = el("i", "ic");
  ic.dataset.icon = icon;
  ic.setAttribute("aria-hidden", "true");
  head.append(ic, el("span", "", title));
  if (note) head.append(el("small", "", note));
  return head;
}

function chipGroup(label: string, items: string[], tone: string): HTMLElement {
  const group = el("div", "insight");
  group.append(el("div", "insight-label", label));
  const chips = el("div", "chips");
  for (const item of items) if (item.trim()) chips.append(el("span", `chip ${tone}`, item));
  group.append(chips);
  return group;
}

function keyValue(label: string, value: string): HTMLElement {
  const box = el("div", "kv");
  box.append(el("b", "", label), el("span", "", value));
  return box;
}

function renderReview() {
  const box = $("review");
  $("step-analyze").dataset.state = activeAnalysis ? "done" : "";
  $("step-scenes").dataset.state = activeContent ? "done" : "";
  if (!activeAnalysis && !activeContent) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const blocks: HTMLElement[] = [];
  if (activeAnalysis) {
    const block = el("div", "review-block");
    block.append(reviewHead("target", "ผลวิเคราะห์สินค้า", "ขั้นที่ 1"));
    const target = el("div", "insight");
    target.append(el("div", "insight-label", "กลุ่มเป้าหมาย"), el("div", "insight-text", activeAnalysis.targetCustomer));
    block.append(
      target,
      chipGroup("Pain points", activeAnalysis.painPoints, "chip-pain"),
      chipGroup("จุดขาย", activeAnalysis.sellingPoints, "chip-sell"),
      chipGroup("มุมคอนเทนต์", activeAnalysis.angles, "chip-angle"),
    );
    blocks.push(block);
  }
  if (activeContent) {
    const block = el("div", "review-block");
    block.append(reviewHead("quote", "คอนเทนต์", "ขั้นที่ 2"));
    const hook = el("div", "hook");
    hook.append(el("span", "hook-label", "HOOK"), document.createTextNode(activeContent.hook));
    block.append(hook, keyValue("Script", activeContent.script), keyValue("Caption", activeContent.caption), keyValue("CTA", activeContent.cta));
    if (activeContent.angle) block.append(keyValue("มุมการขาย", activeContent.angle));
    if (activeContent.onScreenText || activeContent.onScreenCta) {
      const texts = el("div", "overlay-texts");
      if (activeContent.onScreenText) {
        const tag = el("span", "overlay-text", `"${activeContent.onScreenText}"`);
        tag.prepend(el("small", "", "ข้อความบนจอ"));
        texts.append(tag);
      }
      if (activeContent.onScreenCta) {
        const tag = el("span", "overlay-text", `"${activeContent.onScreenCta}"`);
        tag.prepend(el("small", "", "CTA บนจอ"));
        texts.append(tag);
      }
      block.append(texts);
    }
    blocks.push(block);
  }
  if (activeScenes.length) {
    const block = el("div", "review-block");
    block.append(reviewHead("film", "Storyboard", `${activeScenes.length} ฉาก · เลื่อนดูด้านข้าง`));
    const board = el("div", "storyboard");
    activeScenes.forEach((scene, i) => {
      const card = el("article", "scene");
      const top = el("div", "scene-top");
      top.append(el("span", "scene-no", `SCENE ${String(i + 1).padStart(2, "0")}`));
      const meta = el("span", "tag tag-muted", `${Number.isInteger(scene.clip) ? `คลิป ${scene.clip! + 1} · ` : ""}${scene.duration}s`);
      top.append(meta);
      card.append(top, el("div", "scene-desc", scene.description));
      if (scene.visual) card.append(el("div", "scene-visual", `ภาพ: ${scene.visual}`));
      const dialogue = scene.dialogue?.trim();
      const voiceover = scene.voiceover?.trim();
      if (dialogue || voiceover) {
        const speech = el("div", `scene-speech${dialogue ? "" : " vo"}`);
        speech.append(el("b", "", dialogue ? "บทพูด" : "เสียงบรรยาย"), document.createTextNode(dialogue ?? voiceover ?? ""));
        card.append(speech);
      }
      board.append(card);
    });
    block.append(board);
    blocks.push(block);
  }

  box.replaceChildren(...blocks);
  box.hidden = false;
}

function requireSingleSelected(): string | null {
  if (selected.size !== 1) {
    log(selected.size === 0 ? "เลือกสินค้า 1 รายการก่อน" : "รองรับทีละ 1 รายการตอนนี้ — เลือกสินค้าแค่ 1 ชิ้น");
    return null;
  }
  const [productId] = selected;
  if (productId !== reviewProductId) resetReview();
  reviewProductId = productId;
  return productId;
}

function analyzeSelected() {
  const productId = requireSingleSelected();
  if (!productId) return;

  const button = $("analyze") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "กำลังวิเคราะห์...";
  log("กำลังวิเคราะห์สินค้า...");

  send<{ ok: boolean; analysis?: ProductAnalysisResult; error?: string }>({
    type: "ANALYZE_PRODUCT",
    productId,
  }).then((result) => {
    button.disabled = false;
    button.textContent = "วิเคราะห์สินค้า";
    if (!result?.ok || !result.analysis) {
      log(result?.error ?? "วิเคราะห์สินค้าไม่สำเร็จ");
      return;
    }
    activeAnalysis = result.analysis;
    renderReview();
    log("วิเคราะห์สินค้าเสร็จแล้ว — ดูผลด้านล่าง");
  });
}

function generateScenesSelected() {
  const productId = requireSingleSelected();
  if (!productId) return;

  const style = ($("style") as HTMLSelectElement).value || CONTENT_STYLES[0];
  const targetDuration = Number(($("duration") as HTMLSelectElement).value ?? 24);
  const site = ($("site") as HTMLSelectElement).value;

  const button = $("generate-scenes") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "กำลังสร้างฉาก...";
  log("กำลังสร้างคอนเทนต์และวางแผนฉาก...");

  send<{ ok: boolean; content?: GeneratedContent; scenes?: GeneratedScene[]; error?: string }>({
    type: "GENERATE_CONTENT_SCENES",
    productId,
    style,
    targetDuration,
    site,
    platform: ($("publish-platform") as HTMLSelectElement).value,
  }).then((result) => {
    button.disabled = false;
    button.textContent = "สร้างฉาก";
    if (!result?.ok || !result.content) {
      log(result?.error ?? "สร้างฉากไม่สำเร็จ");
      return;
    }
    activeContent = result.content;
    activeScenes = result.scenes ?? [];
    renderReview();
    ($("create-video") as HTMLButtonElement).disabled = false;
    log(`สร้างฉากเสร็จแล้ว (${activeScenes.length} ฉาก) — ตรวจสอบ Storyboard ด้านล่าง แล้วกด "สร้างวิดีโอ" ได้เลย`);
  });
}

function selectedRunOptions() {
  return {
    targetDuration: Number(($("duration") as HTMLSelectElement).value || 24),
    count: Number(($("repeat") as HTMLSelectElement).value || 1),
    site: (($("site") as HTMLSelectElement).value || "flow") as "aistudio" | "flow" | "gemini" | "meta",
  };
}

function describeRun(targetDuration: number, count: number, site: string): string {
  const clips = clipCountFor(targetDuration, clipSecondsForSite(site, targetDuration));
  const shape = clips > 1 ? `วิดีโอ ${targetDuration} วิ (ต่อ ${clips} คลิป)` : `คลิปเดียว ${targetDuration} วิ`;
  return count > 1 ? `${shape} × ${count} วิดีโอ รันต่อกันอัตโนมัติ` : shape;
}

/** Creates the videos for one content and starts the first; the rest run in order from the worker's queue. */
function startBatch(contentId: string, button: HTMLButtonElement, idleLabel: string) {
  if (libraryBusy) {
    log("มีงานกำลังทำอยู่แล้ว — รอให้เสร็จหรือกดยกเลิกในแท็บคลัง/งาน");
    return;
  }
  const { targetDuration, count, site } = selectedRunOptions();

  button.disabled = true;
  button.textContent = "กำลังเริ่ม...";
  log(`กำลังเริ่ม: ${describeRun(targetDuration, count, site)}`);

  send<{ ok: boolean; opened?: boolean; error?: string; videoIds?: string[] }>({
    type: "RUN_BATCH",
    contentId,
    targetDuration,
    count,
    site,
  }).then((result) => {
    button.disabled = false;
    button.textContent = idleLabel;
    if (!result?.ok) {
      log(result?.error ?? "เริ่มสร้างวิดีโอไม่สำเร็จ");
      return;
    }
    if (result.videoIds?.[0]) setBusy(true, result.videoIds[0]);
    log(result.opened ? `เปิดแท็บ ${site} เพื่อเริ่มสร้างวิดีโอแล้ว` : "เริ่มสร้างวิดีโอแล้ว");
    showTab("library");
  });
}

function createVideoFromContent() {
  if (!activeContent) {
    log('ยังไม่มีคอนเทนต์ — กด "สร้างฉาก" (ขั้นที่ 2) ก่อน');
    return;
  }
  startBatch(activeContent.id, $("create-video") as HTMLButtonElement, "สร้างวิดีโอ");
}

/* ---------- export/import ---------- */

function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson() {
  downloadFile("tiktok-products.json", JSON.stringify(products, null, 2), "application/json");
  log(`ดาวน์โหลด JSON (${products.length} รายการ)`);
}

function exportCsv() {
  const header = "id,name,price,source,sourceUrl";
  const rows = products.map((p) =>
    [p.id, p.name, p.price ?? "", p.source, p.sourceUrl ?? ""]
      .map((field) => `"${String(field).replace(/"/g, '""')}"`)
      .join(","),
  );
  downloadFile("tiktok-products.csv", [header, ...rows].join("\n"), "text/csv");
  log(`Export CSV (${products.length} รายการ)`);
}

function tiktokIdFromSourceUrl(sourceUrl: string | null): string | undefined {
  return sourceUrl?.match(/\/product\/(\d+)$/)?.[1];
}

function importJsonFile(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch {
      log("ไฟล์ไม่ใช่ JSON ที่ถูกต้อง");
      return;
    }
    if (!Array.isArray(parsed)) {
      log("ไฟล์ต้องเป็น array ของสินค้า");
      return;
    }

    const toImport: ScrapedTikTokProduct[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const tiktokId =
        (typeof record.tiktokId === "string" && record.tiktokId) ||
        tiktokIdFromSourceUrl(typeof record.sourceUrl === "string" ? record.sourceUrl : null);
      const name = typeof record.name === "string" ? record.name : undefined;
      if (!tiktokId || !name) continue;
      toImport.push({
        tiktokId,
        name,
        price: typeof record.price === "number" ? record.price : undefined,
        image: typeof record.image === "string" ? record.image : undefined,
      });
    }

    if (toImport.length === 0) {
      log("ไม่พบสินค้าที่นำเข้าได้ในไฟล์นี้");
      return;
    }

    send<{ ok: boolean; error?: string }>({ type: "IMPORT_TIKTOK_PRODUCTS", products: toImport }).then((result) => {
      if (!result?.ok) {
        log(result?.error ?? "นำเข้าไม่สำเร็จ");
        return;
      }
      log(`นำเข้าแล้ว ${toImport.length} รายการจากไฟล์`);
      loadProducts();
    });
  };
  reader.readAsText(file);
}

$("get-product").addEventListener("click", getProductFromTikTok);
$("sync-showcase").addEventListener("click", () => {
  const button = $("sync-showcase") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "กำลังดึง...";
  send<{ ok: boolean; added?: number; total?: number; error?: string }>({ type: "SYNC_TIKTOK_SHOWCASE" }).then((result) => {
    button.disabled = false;
    button.textContent = "ดึงสินค้าจาก Showcase";
    if (!result?.ok) {
      log(result?.error ?? "ดึงสินค้าไม่สำเร็จ");
      return;
    }
    log(`ดึงสินค้าจาก Showcase แล้ว ${result.total ?? 0} รายการ (ใหม่ ${result.added ?? 0})`);
    loadProducts();
  });
});
$("add-current-page").addEventListener("click", addFromCurrentPage);
$("delete-selected").addEventListener("click", deleteSelected);
$("reset-selection").addEventListener("click", resetSelection);
$("analyze").addEventListener("click", analyzeSelected);
$("generate-scenes").addEventListener("click", generateScenesSelected);
$("create-video").addEventListener("click", createVideoFromContent);
$("download-json").addEventListener("click", downloadJson);
$("export-csv").addEventListener("click", exportCsv);

const importFileInput = $("import-file") as HTMLInputElement;
$("import-json").addEventListener("click", () => importFileInput.click());
importFileInput.addEventListener("change", () => {
  const file = importFileInput.files?.[0];
  if (file) importJsonFile(file);
  importFileInput.value = "";
});

/* ================= Library tab ================= */

interface LibraryJob {
  videoId: string;
  productName: string;
  hook: string;
  clips: { index: number; prompt: string }[];
  duration?: number;
  aspectRatio?: string;
  imageUrl: string | null;
}

interface LibraryContent {
  contentId: string;
  productName: string;
  hook: string;
  sceneCount: number;
  imageUrl: string | null;
}

interface CompletedVideo {
  videoId: string;
  productName: string;
  hook: string;
  imageUrl: string | null;
  clipCount: number;
  seconds: number;
  mergedAt: number | null;
  mergeError: string | null;
  caption: string;
  platform?: PublishPlatform;
  productShopeeUrl?: string | null;
  shopeePost?: { status: string; at: number; error: string | null } | null;
  productTikTokId: string | null;
  tiktokPost: { status: "preparing" | "ready" | "posted" | "failed" | "submitting" | "uncertain"; at: number; error: string | null } | null;
}

let libraryBusy = false;
let libraryActiveVideoId: string | null = null;

function libraryRow(imageUrl: string | null, title: string, subtitle: string, actionLabel: string, onAction: (button: HTMLButtonElement) => void): HTMLElement {
  const row = el("div", "media-row");
  const info = el("div", "product-meta");
  const name = el("div", "media-title", title);
  name.title = title;
  info.append(name, el("div", "media-sub", subtitle));
  const button = el("button", "btn btn-primary btn-sm", actionLabel);
  button.dataset.icon = "play";
  button.addEventListener("click", () => onAction(button));
  row.append(thumb(imageUrl), info, button);
  return row;
}

function emptyNote(text: string): HTMLElement {
  return el("div", "empty", text);
}

function setProgress(current: number, total: number, state: string) {
  const wrap = $("progress-wrap");
  if ((!total && state !== "paused") || state === "idle") {
    wrap.hidden = true;
    return;
  }
  const labels: Record<string, string> = {
    generating: "กำลังสร้าง",
    uploading: "กำลังอัปโหลด",
    done: "เสร็จแล้ว",
    failed: "ล้มเหลว",
    cancelled: "ยกเลิกแล้ว",
    paused: "พักงาน — ตรวจสิทธิ์ใช้งานแล้วกดทำงานที่พักต่อ",
  };
  wrap.hidden = false;
  wrap.dataset.state = state;
  $("progress-label").textContent = `${labels[state] ?? state}${total ? ` — คลิป ${current}/${total}` : ""}`;
  const bar = $("progress-bar");
  bar.style.width = `${Math.round((current / Math.max(1, total)) * 100)}%`;
  // Clip counts are the only real progress; before the first clip lands,
  // show that work is moving without inventing a percentage.
  $("progress-track").classList.toggle("is-indeterminate", (state === "generating" || state === "uploading") && current === 0);
}

/** Content scripts send a colour meant for their in-page banner; map it to a tone that reads on the panel. */
function statusTone(color: string | undefined): string {
  const c = (color ?? "").toLowerCase();
  if (c === "#dc2626" || c === "#ef4444" || c === "#f87171") return "danger";
  if (c === "#d97706" || c === "#f59e0b" || c === "#fbbf24") return "warning";
  if (c === "#16a34a" || c === "#22c55e" || c === "#4ade80") return "success";
  return "neutral";
}

function showStatusText(status: { text: string; color: string } | undefined) {
  const box = $("status-text");
  box.textContent = status?.text ?? "";
  box.dataset.tone = statusTone(status?.color);
  box.hidden = !status?.text;
}

function setBusy(running: boolean, videoId?: string) {
  libraryBusy = running;
  if (running && videoId) libraryActiveVideoId = videoId;
}

async function renderQueueInfo() {
  const stored = await chrome.storage.local.get("jobQueue");
  const queue = stored.jobQueue as { current: string | null; pending: unknown[] } | undefined;
  const info = $("queue-info");
  const waiting = queue?.pending.length ?? 0;
  info.textContent = waiting ? `รอคิวอีก ${waiting} วิดีโอ — จะเริ่มต่ออัตโนมัติเมื่อวิดีโอนี้เสร็จ` : "";
  info.hidden = !waiting;
}

function cancelJob() {
  const videoId = libraryActiveVideoId;
  if (!videoId) return;
  if (!confirm("ยกเลิกงานนี้และวิดีโอที่รอคิวอยู่? คลิปของงานนี้ที่สร้างไปแล้วจะถูกทิ้ง")) return;

  log("กำลังยกเลิก...");
  // Stop the automation loop in its tab first, then discard the partial job —
  // the other order can let one more clip land after cancelling.
  send({ type: "CANCEL_RUNNING_JOB" }).finally(() => {
    send<{ ok: boolean; error?: string }>({ type: "CANCEL_JOB", videoId }).then((result) => {
      setBusy(false);
      setProgress(0, 0, "idle");
      log(result?.ok ? "ยกเลิกแล้ว" : (result?.error ?? "ยกเลิกไม่สำเร็จ"));
      loadLibrary();
    });
  });
}

function runJob(job: LibraryJob, button: HTMLButtonElement) {
  if (libraryBusy) {
    log("มีงานกำลังทำอยู่แล้ว");
    return;
  }
  const targetDuration = Number(($("duration") as HTMLSelectElement).value ?? 24);
  const site = (($("site") as HTMLSelectElement).value ?? "flow") as "aistudio" | "flow" | "gemini" | "meta";

  setBusy(true, job.videoId);
  button.disabled = true;
  button.textContent = "กำลังเริ่ม...";

  send<{ ok: boolean; error?: string }>({ type: "RUN_JOB_FROM_POPUP", job, targetDuration, site }).then((result) => {
    button.disabled = false;
    button.textContent = "สร้าง";
    if (!result?.ok) {
      setBusy(false);
      log(result?.error ?? "เริ่มงานไม่สำเร็จ");
    }
  });
}

function createFromContent(content: LibraryContent, button: HTMLButtonElement) {
  startBatch(content.contentId, button, "สร้าง");
}

/** A 9:16 player — every clip here is a vertical short. Size comes from the container. */
function clipPlayer(blob: Blob): HTMLVideoElement {
  const videoEl = el("video", "player");
  videoEl.src = URL.createObjectURL(blob);
  videoEl.controls = true;
  videoEl.preload = "metadata";
  videoEl.playsInline = true;
  return videoEl;
}

function downloadBlob(blob: Blob, filename: string): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  const result = chrome.downloads.download({ url, filename, saveAs: false }).then(
    () => { log(`เริ่มดาวน์โหลด ${filename} แล้ว`); return true; },
    (err: unknown) => { log(`ดาวน์โหลดไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`); return false; },
  );
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  return result;
}

function mergeVideo(video: CompletedVideo, button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "กำลังต่อ...";
  send<{ ok: boolean; seconds?: number; error?: string; warning?: string }>({ type: "MERGE_VIDEO", videoId: video.videoId }).then(
    (result) => {
      button.disabled = false;
      button.textContent = "ต่อเป็นวิดีโอเดียว";
      if (!result?.ok) {
        log(result?.error ?? "ต่อคลิปไม่สำเร็จ");
        return;
      }
      log(`ต่อเป็นวิดีโอเดียว ${result.seconds ?? video.seconds} วิ แล้ว${result.warning ? ` — ${result.warning}` : ""}`);
      renderClips();
    },
  );
}

const TIKTOK_POST_LABELS: Record<string, string> = {
  preparing: "กำลังเตรียมโพสต์ในแท็บ TikTok...",
  ready: "เตรียมโพสต์เสร็จแล้ว — ไปกด Post ในแท็บ TikTok",
  posted: "โพสต์ขึ้น TikTok แล้ว ✓",
  failed: "เตรียมโพสต์ไม่สำเร็จ",
  submitting: "ส่งโพสต์แล้ว กำลังรอยืนยันผล",
  uncertain: "ตรวจผลโพสต์ใน TikTok ก่อนทำต่อ",
};

function tiktokPostBlock(video: CompletedVideo, autoPostDefault: boolean): HTMLElement {
  const block = el("div", "post-block");
  block.append(el("div", "section-label", "โพสต์ TikTok"));

  const caption = document.createElement("textarea");
  caption.rows = 3; caption.maxLength = 150; caption.setAttribute("aria-label", "แคปชัน TikTok ไม่เกิน 150 ตัวอักษร");
  caption.value = video.caption;
  caption.placeholder = "แคปชันและ #แฮชแท็ก";
  block.appendChild(caption);

  // Product link: any product imported from TikTok can be linked, defaulting to the video's own product.
  const productSelect = document.createElement("select");
  productSelect.setAttribute("aria-label", "ลิงก์สินค้าที่จะติดในโพสต์");
  const noLink = new Option("ไม่ติดลิงก์สินค้า", "");
  productSelect.add(noLink);
  const linkable = products.flatMap((p) => {
    const tiktokId = tiktokIdFromSourceUrl(p.sourceUrl);
    return tiktokId ? [{ tiktokId, name: p.name }] : [];
  });
  if (video.productTikTokId && !linkable.some((p) => p.tiktokId === video.productTikTokId)) {
    linkable.unshift({ tiktokId: video.productTikTokId, name: video.productName });
  }
  for (const p of linkable) {
    productSelect.add(new Option(`🛒 ${p.name.slice(0, 40)} (${p.tiktokId})`, p.tiktokId));
  }
  productSelect.value = video.productTikTokId ?? "";
  if (linkable.length === 0) {
    noLink.text = 'ไม่ติดลิงก์สินค้า — กด "ดึงสินค้าจาก Showcase" ในแท็บสินค้าก่อน';
  }
  block.appendChild(productSelect);

  const row = el("div", "row");

  const autoLabel = el("label", "check");
  const auto = document.createElement("input");
  auto.type = "checkbox";
  auto.checked = autoPostDefault;
  auto.addEventListener("change", () => {
    send({ type: "SAVE_SETTINGS", settings: { tiktokAutoPost: auto.checked } });
  });
  autoLabel.append(auto, "กดโพสต์ให้อัตโนมัติ");

  const button = el("button", "btn btn-primary", "เตรียมโพสต์ TikTok");
  button.dataset.icon = "send";
  button.addEventListener("click", () => {
    if (auto.checked && !productSelect.value && !confirm("ยังไม่ได้เลือกลิงก์สินค้า — โพสต์โดยไม่ติดลิงก์ใช่ไหม?")) return;
    if (auto.checked && !confirm("ระบบจะกด Post ให้เองทันทีที่กรอกเสร็จ — วิดีโอจะขึ้นบัญชี TikTok จริง ยืนยันไหม?")) return;
    button.disabled = true;
    button.textContent = "กำลังเปิด TikTok...";
    send<{ ok: boolean; error?: string }>({
      type: "PREPARE_TIKTOK_POST",
      videoId: video.videoId,
      caption: caption.value,
      autoPost: auto.checked,
      productId: productSelect.value || null,
    }).then((result) => {
      button.disabled = false;
      button.textContent = "เตรียมโพสต์ TikTok";
      log(result?.ok ? "เปิดแท็บ TikTok Studio แล้ว — ระบบกำลังแนบวิดีโอและใส่แคปชัน" : (result?.error ?? "เปิดหน้าโพสต์ไม่สำเร็จ"));
    });
  });

  row.append(button, autoLabel);
  block.appendChild(row);

  if (video.tiktokPost) {
    const status = el("div", "post-status");
    status.dataset.tone =
      video.tiktokPost.status === "failed" ? "danger" : video.tiktokPost.status === "posted" ? "success" : "warning";
    status.textContent = `${TIKTOK_POST_LABELS[video.tiktokPost.status] ?? video.tiktokPost.status}${video.tiktokPost.error ? `: ${video.tiktokPost.error}` : ""}`;
    block.appendChild(status);
  }
  if (video.tiktokPost && ["submitting", "uncertain"].includes(video.tiktokPost.status)) {
    const resolveRow = el("div", "row");
    block.appendChild(resolveRow);
    for (const posted of [true, false]) {
      const confirmResult = document.createElement("button"); confirmResult.className = "btn btn-sm";
      confirmResult.textContent = posted ? "ตรวจแล้ว: โพสต์ TikTok แล้ว" : "ตรวจแล้ว: ยังไม่โพสต์";
      confirmResult.addEventListener("click", async () => {
        if (!confirm(posted ? "ตรวจใน TikTok แล้วว่าคลิปนี้เผยแพร่แล้วใช่ไหม?" : "ตรวจใน TikTok ว่าคลิปยังไม่เผยแพร่แล้วใช่ไหม? ระบบจะปิดแท็บโพสต์เดิมก่อนอนุญาตให้เริ่มใหม่")) return;
        const result = await send<{ ok: boolean; error?: string }>({ type: "RESOLVE_TIKTOK_POST", videoId: video.videoId, posted });
        if (result.ok) await loadLibrary(); else log(result.error ?? "บันทึกผลไม่สำเร็จ");
      });
      resolveRow.appendChild(confirmResult);
    }
  }
  return block;
}

async function renderClips() {
  const container = $("clips-list");
  const [result, settingsResult] = await Promise.all([
    send<{ ok: boolean; videos?: CompletedVideo[]; error?: string }>({ type: "GET_COMPLETED_VIDEOS" }),
    send<{ ok: boolean; settings?: { tiktokAutoPost?: boolean } }>({ type: "GET_SETTINGS" }),
  ]);
  const videos = result?.videos ?? [];
  const autoPostDefault = settingsResult?.settings?.tiktokAutoPost ?? false;

  container.replaceChildren();
  if (!result?.ok) {
    container.appendChild(emptyNote(result?.error ?? "โหลดคลิปที่เสร็จแล้วไม่สำเร็จ"));
    return;
  }
  if (videos.length === 0) {
    container.appendChild(emptyNote("ยังไม่มีคลิปที่เสร็จแล้ว — วิดีโอที่เรนเดอร์เสร็จจะมาอยู่ที่นี่ พร้อมดาวน์โหลดและโพสต์"));
    return;
  }

  for (const video of videos) {
    const wrap = el("article", "video-card");
    const shape = video.clipCount > 1 ? `${video.seconds} วิ · ${video.clipCount} คลิป` : `${video.seconds} วิ · คลิปเดียว`;
    const head = el("div", "video-head");
    const title = el("div", "media-title", video.productName);
    title.title = video.productName;
    const sub = el("div", "product-sub");
    sub.append(el("span", `tag ${video.platform === "shopee" ? "tag-shopee" : "tag-tiktok"}`, video.platform === "shopee" ? "Shopee" : "TikTok"), el("span", "", shape));
    head.append(title, el("div", "media-sub", video.hook), sub);
    wrap.appendChild(head);

    const stored = await getClipsForVideo(video.videoId);
    const merged = stored.find((c) => c.index === MERGED_CLIP_INDEX);
    const parts = stored.filter((c) => c.index >= 0);

    if (merged) {
      const block = el("div", "video-hero");
      block.appendChild(clipPlayer(merged.blob));
      const side = el("div", "video-side");
      side.append(
        el("span", "tag tag-ok", `วิดีโอเต็ม ${video.seconds} วิ`),
        el("div", "media-sub", `ต่อ ${parts.length} คลิปเป็นไฟล์เดียวแล้ว พร้อมโพสต์`),
      );
      const download = el("button", "btn btn-success", "ดาวน์โหลดวิดีโอเต็ม");
      download.dataset.icon = "download";
      download.addEventListener("click", () => downloadBlob(merged.blob, `ai-affiliate/${video.videoId}-full-${video.seconds}s.mp4`));
      side.appendChild(download);
      block.appendChild(side);
      wrap.appendChild(block);
    } else if (parts.length > 1) {
      const row = el("div", "stack");
      if (video.mergeError) row.appendChild(el("div", "post-status", video.mergeError)).dataset.tone = "warning";
      const mergeButton = el("button", "btn btn-primary", "ต่อเป็นวิดีโอเดียว");
      mergeButton.dataset.icon = "layers";
      mergeButton.addEventListener("click", () => mergeVideo(video, mergeButton));
      row.appendChild(mergeButton);
      wrap.appendChild(row);
    }

    if (parts.length > 1 || !merged) {
      if (merged) wrap.appendChild(el("div", "section-label", "คลิปย่อย"));
      const clipRow = el("div", merged ? "clip-strip" : "clip-strip is-main");
      for (const clip of parts) clipRow.appendChild(clipPlayer(clip.blob));
      wrap.appendChild(clipRow);
    }

    if (merged || parts.length === 1) {
      if (video.platform === "shopee") wrap.appendChild(shopeePostBlock(video));
      else wrap.appendChild(tiktokPostBlock(video, autoPostDefault));
    }
    container.appendChild(wrap);
  }
}

async function loadLibrary() {
  const [jobsResult, contentsResult] = await Promise.all([
    send<{ ok: boolean; jobs?: LibraryJob[]; error?: string }>({ type: "GET_PENDING_JOBS" }),
    send<{ ok: boolean; contents?: LibraryContent[]; error?: string }>({ type: "GET_CONTENTS" }),
  ]);

  const jobsList = $("jobs-list");
  jobsList.replaceChildren();
  const jobs = jobsResult?.jobs ?? [];
  if (jobs.length === 0) {
    jobsList.appendChild(emptyNote('ยังไม่มีงานที่รออยู่ — ไปที่แท็บ "สินค้า" แล้วสร้างวิดีโอ'));
  } else {
    for (const job of jobs) {
      jobsList.appendChild(libraryRow(job.imageUrl, job.productName, job.hook, "สร้าง", (btn) => runJob(job, btn)));
    }
  }

  const contentsList = $("contents-list");
  contentsList.replaceChildren();
  const contents = contentsResult?.contents ?? [];
  if (contents.length === 0) {
    contentsList.appendChild(emptyNote('ยังไม่มีคอนเทนต์ที่มีฉาก — ทำขั้นตอน "สร้างฉาก" ในแท็บสินค้าก่อน'));
  } else {
    for (const content of contents) {
      contentsList.appendChild(
        libraryRow(content.imageUrl, content.productName, `${content.sceneCount} ฉาก · ${content.hook}`, "สร้าง", (btn) =>
          createFromContent(content, btn),
        ),
      );
    }
  }

  await renderClips();
  await renderJobLog();
}

interface JobLogEntry {
  at: number;
  text: string;
}

function formatJobLogEntries(entries: JobLogEntry[]): string {
  return entries
    .map((e) => `[${new Date(e.at).toLocaleTimeString("th-TH")}] ${e.text}`)
    .join("\n");
}

async function renderJobLog() {
  const stored = await chrome.storage.local.get("jobLog");
  const entries = (Array.isArray(stored.jobLog) ? stored.jobLog : []) as JobLogEntry[];
  const box = $("job-log");
  if (entries.length === 0) {
    box.textContent = "ยังไม่มีบันทึก — จะเริ่มบันทึกอัตโนมัติเมื่อเริ่มสร้างวิดีโอ";
    return;
  }
  box.textContent = formatJobLogEntries(entries);
  box.scrollTop = box.scrollHeight;
}

$("copy-job-log").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("jobLog");
  const entries = (Array.isArray(stored.jobLog) ? stored.jobLog : []) as JobLogEntry[];
  const text = entries.length ? formatJobLogEntries(entries) : "(ไม่มีบันทึก)";
  try {
    await navigator.clipboard.writeText(text);
    log("คัดลอกบันทึกแล้ว");
  } catch {
    log("คัดลอกไม่สำเร็จ — เบราว์เซอร์อาจบล็อกการเข้าถึง clipboard");
  }
});

$("cancel-job").addEventListener("click", cancelJob);

chrome.storage.onChanged.addListener((changes) => {
  const progress = changes.jobProgress?.newValue as
    | { videoId: string; current: number; total: number; state: string }
    | undefined;
  if (progress) {
    setProgress(progress.current, progress.total, progress.state);
    const terminal = progress.state === "done" || progress.state === "failed" || progress.state === "cancelled";
    // Whatever job is reporting progress is "the active one" for Cancel's
    // purposes, regardless of which tab (Products or Library) started it —
    // without this, a job started via "3. สร้างวิดีโอ" left libraryActiveVideoId
    // unset and the Cancel button silently did nothing.
    setBusy(!terminal, progress.videoId);
    if (terminal) loadLibrary();
  }

  const status = changes.jobStatusText?.newValue as { text: string; color: string } | undefined;
  if (status) showStatusText(status);

  if (changes.jobLog) renderJobLog();
  if (changes.jobQueue) renderQueueInfo();
});

chrome.storage.local.get(["jobProgress", "jobStatusText"], (stored) => {
  const progress = stored.jobProgress as { videoId: string; current: number; total: number; state: string } | undefined;
  if (progress && progress.state !== "done" && progress.state !== "failed" && progress.state !== "cancelled") {
    setBusy(true, progress.videoId);
    setProgress(progress.current, progress.total, progress.state);
  }
  const status = stored.jobStatusText as { text: string; color: string } | undefined;
  if (status?.text) showStatusText(status);
});

renderQueueInfo();

/* ================= Autopilot tab ================= */

const apSelected = new Set<string>();
let apProductsLoaded = false;
let apTextSourceTouched = false;
const AP_TEXT_SOURCE_LABELS: Record<string, string> = {
  "gemini-web": "เว็บ Gemini",
  "chatgpt-web": "เว็บ ChatGPT",
  api: "Gemini API",
};

function apFormatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `วันนี้ ${time}` : `${d.toLocaleDateString("th-TH", { day: "numeric", month: "short" })} ${time}`;
}

function apUpdateSelectedCount() {
  $("ap-selected-count").textContent = `เลือกแล้ว ${apSelected.size} ชิ้น`;
}

function apRenderProducts() {
  const list = $("ap-products");
  list.replaceChildren();
  if (products.length === 0) {
    list.appendChild(emptyNote('ยังไม่มีสินค้า — ไปแท็บสินค้าแล้วกด "ดึงสินค้าจาก Showcase"'));
    return;
  }
  const platform = ($("ap-platform") as HTMLSelectElement).value;
  const available = products.filter((p) => platform === "shopee" ? !!shopeeProductLink(p.sourceUrl) : !shopeeProductLink(p.sourceUrl));
  if (!available.length) list.appendChild(emptyNote(platform === "shopee" ? 'เปิดหน้าสินค้า Shopee ใน Chrome แล้วกด "ดึงจากหน้า Shopee" ในแท็บสินค้า' : "ยังไม่มีสินค้า TikTok"));
  for (const product of available) {
    const row = el("label", "ap-product");
    const linkable = platform === "shopee" ? !!shopeeProductLink(product.sourceUrl) : !!tiktokIdFromSourceUrl(product.sourceUrl);
    const linkLabel = platform === "shopee" ? "มีลิงก์สินค้า" : "ติดลิงก์ได้";
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = apSelected.has(product.id);
    const name = el("span", "name", product.name);
    name.title = product.name;
    const tag = el("span", `tag ${linkable ? "tag-ok" : "tag-muted"}`, linkable ? linkLabel : "ไม่มีลิงก์");
    tag.title = platform === "shopee" ? "มี URL สินค้าสำหรับแนบในแอป Shopee ต้องตรวจสิทธิ์ปักสินค้าบนเว็บแยกต่างหาก" : "สินค้าจาก TikTok Showcase";
    row.append(checkbox, thumb(product.images[0], ""), name, tag);
    row.querySelector("input")!.addEventListener("change", (event) => {
      if ((event.target as HTMLInputElement).checked) apSelected.add(product.id);
      else apSelected.delete(product.id);
      apUpdateSelectedCount();
    });
    list.appendChild(row);
  }
  apUpdateSelectedCount();
}

function apSetupOptions() {
  $("ap-text-source").addEventListener("change", () => { apTextSourceTouched = true; });
  const style = $("ap-style") as HTMLSelectElement;
  style.innerHTML =
    `<option value="rotate">สลับสไตล์ทุกคลิป</option>` + styleOptions();
  bindStyleDescription("ap-style", "ap-style-desc", "ใช้สไตล์ต่างกันในแต่ละคลิป วนไปตามลำดับ เพื่อให้คอนเทนต์ไม่ซ้ำกัน");
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ap-mode"]'))) {
    radio.addEventListener("change", () => {
      $("ap-schedule-box").hidden = apMode() !== "schedule";
    });
  }
}

function apMode(): "batch" | "schedule" {
  return document.querySelector<HTMLInputElement>('input[name="ap-mode"]:checked')?.value === "schedule" ? "schedule" : "batch";
}

const AP_HISTORY_LABELS: Record<string, { text: string; tone: string }> = {
  posted: { text: "โพสต์แล้ว", tone: "tag-ok" },
  ready: { text: "เตรียมโพสต์แล้ว รอกด Post", tone: "tag-warn" },
  made: { text: "สร้างวิดีโอแล้ว", tone: "tag-violet" },
  failed: { text: "ไม่สำเร็จ", tone: "tag-danger" },
};

function apRender(state: AutopilotState | null) {
  const running = !!state && state.status !== "idle";
  $("ap-setup").hidden = running;
  $("ap-controls").hidden = !running;
  ($("ap-pause") as HTMLButtonElement).hidden = state?.status !== "running";
  ($("ap-resume") as HTMLButtonElement).hidden = state?.status !== "paused";
  ($("ap-skip") as HTMLButtonElement).hidden = !state?.current;

  const status = $("ap-status");
  if (!state || (state.status === "idle" && !state.message)) {
    status.hidden = true;
  } else {
    const parts: HTMLElement[] = [];
    const head = el("div", "ap-state");
    head.append(
      el("span", "dot"),
      el("span", "", state.status === "running" ? "กำลังทำงาน" : state.status === "paused" ? "หยุดชั่วคราว" : "ไม่ได้ทำงาน"),
    );
    if (state.status !== "idle") head.append(el("small", "", `· ${state.mode === "batch" ? "ทำเลยจนครบ" : "ตามเวลา"}`));
    parts.push(head);
    if (state.message) parts.push(el("div", "ap-msg", state.message));
    if (state.current) {
      const cur = state.current;
      const box = el("div", "ap-current");
      const doing = el("div", "", "กำลังทำ: ");
      doing.append(el("b", "", cur.productName.slice(0, 50)));
      box.append(
        doing,
        el("div", "", `ขั้นตอน: ${stepLabel(cur.step)}${cur.attempts ? ` (ลองใหม่ครั้งที่ ${cur.attempts + 1})` : ""}${cur.style ? ` · สไตล์ ${styleLabel(cur.style).name}` : ""}`),
      );
      if (cur.lastError) box.append(el("div", "ap-err", `ผิดพลาดล่าสุด: ${cur.lastError}`));
      parts.push(box);
    }
    if (state.status !== "idle") {
      if (state.mode === "batch") parts.push(el("div", "", `เหลืออีก ${state.productIds.length} ชิ้น`));
      else if (state.nextRunAt) parts.push(el("div", "", `รอบถัดไป: ${apFormatTime(state.nextRunAt)} · หมุนเวียน ${state.productIds.length} ชิ้น · เวลา ${state.times.join(", ")}`));
      const post = { auto: "โพสต์อัตโนมัติ", prepare: "เตรียมโพสต์รอกดเอง", none: "ไม่โพสต์" }[state.settings.postMode];
      const textSource = AP_TEXT_SOURCE_LABELS[state.settings.textSource] ?? "เว็บ Gemini";
      parts.push(el("div", "ap-meta", `วิเคราะห์ด้วย ${textSource} · ${state.settings.targetDuration} วิ · ${state.settings.platform === "shopee" ? "Shopee" : "TikTok"} · ${post}`));
    }
    status.dataset.state = state.status;
    status.replaceChildren(...parts);
    status.hidden = false;
  }

  const history = $("ap-history");
  const entries = state?.history ?? [];
  history.replaceChildren();
  if (!entries.length) history.appendChild(emptyNote("ยังไม่มีประวัติ — ผลของแต่ละชิ้นจะแสดงที่นี่"));
  for (const entry of entries.slice(0, 30)) {
    const meta = AP_HISTORY_LABELS[entry.status] ?? { text: entry.status, tone: "tag-muted" };
    const row = el("div", "ap-history-row");
    const top = el("div", "ap-history-top");
    top.append(el("span", `tag ${meta.tone}`, meta.text), el("span", "name", entry.productName.slice(0, 40)));
    row.append(
      top,
      el("div", "ap-history-meta", `${apFormatTime(entry.at)} · ${entry.platform === "shopee" ? "Shopee" : "TikTok"}${entry.style ? ` · ${styleLabel(entry.style).name}` : ""}`),
    );
    if (entry.error) row.append(el("div", "ap-history-err", entry.error));
    history.appendChild(row);
  }
}

async function loadAutopilot() {
  if (!apProductsLoaded) {
    const result = await send<{ ok: boolean; products?: AppProduct[] }>({ type: "GET_TIKTOK_PRODUCTS" });
    if (result?.products) products = result.products;
    apProductsLoaded = true;
  }
  apRenderProducts();
  const [result, settingsResult] = await Promise.all([
    send<{ ok: boolean; state?: AutopilotState | null }>({ type: "AUTOPILOT_GET_STATE" }),
    send<{ ok: boolean; settings?: { textSource?: string } }>({ type: "GET_SETTINGS" }),
  ]);
  if (!apTextSourceTouched) {
    const source = result?.state?.status !== "idle" && result?.state?.settings.textSource
      ? result.state.settings.textSource : settingsResult?.settings?.textSource;
    ($("ap-text-source") as HTMLSelectElement).value =
      source && AP_TEXT_SOURCE_LABELS[source] ? source : "gemini-web";
  }
  apRender(result?.state ?? null);
}

function apCommand(type: string, extra: Record<string, unknown> = {}) {
  return send<{ ok: boolean; error?: string; state?: AutopilotState | null }>({ type, ...extra }).then((result) => {
    if (!result?.ok) log(result?.error ?? "คำสั่งไม่สำเร็จ");
    if (result?.state !== undefined) apRender(result.state);
    return result;
  });
}

$("ap-pick-first").addEventListener("click", () => {
  const count = Math.max(1, Number(($("ap-count") as HTMLInputElement).value) || 1);
  apSelected.clear();
  products.filter((p) => ($("ap-platform") as HTMLSelectElement).value === "shopee" ? !!shopeeProductLink(p.sourceUrl) : !shopeeProductLink(p.sourceUrl)).slice(0, count).forEach((p) => apSelected.add(p.id));
  apRenderProducts();
});
$("ap-pick-none").addEventListener("click", () => {
  apSelected.clear();
  apRenderProducts();
});

$("ap-start").addEventListener("click", () => {
  const productIds = products.filter((p) => apSelected.has(p.id)).map((p) => p.id);
  const postMode = ($("ap-post-mode") as HTMLSelectElement).value;
  const mode = apMode();
  if (productIds.length === 0) {
    log("เลือกสินค้าอย่างน้อย 1 ชิ้น");
    return;
  }
  const plan =
    mode === "batch"
      ? `สร้างวิดีโอ ${productIds.length} ชิ้นต่อกันเลย`
      : `ทุกวันเวลา ${($("ap-times") as HTMLInputElement).value} ทำ 1 ชิ้น วนสินค้า ${productIds.length} ชิ้นไปเรื่อยๆ`;
  const platform = ($("ap-platform") as HTMLSelectElement).value;
  const warning = postMode === "auto" ? `\n\nระบบจะกด Post ให้เอง — วิดีโอจะขึ้นบัญชี ${platform === "shopee" ? "Shopee" : "TikTok"} จริงโดยไม่ถามอีก` : "";
  const siteSelect = $("ap-site") as HTMLSelectElement;
  const siteName = siteSelect.selectedOptions[0]?.textContent ?? "Flow";
  const sourceSelect = $("ap-text-source") as HTMLSelectElement;
  const source = sourceSelect.value;
  const sourceQuota = source === "chatgpt-web" ? "โควต้าแชท ChatGPT" : source === "api" ? "โควต้า Gemini API" : "โควต้าแชท Gemini";
  if (!confirm(`${plan}\nใช้เครดิต/โควต้าวิดีโอของ ${siteName} และ${sourceQuota} ทุกชิ้น${warning}\n\nเริ่มเลยไหม?`)) return;

  apCommand("AUTOPILOT_START", {
    mode,
    productIds,
    times: ($("ap-times") as HTMLInputElement).value,
    settings: {
      platform,
      targetDuration: Number(($("ap-duration") as HTMLSelectElement).value),
      style: ($("ap-style") as HTMLSelectElement).value,
      postMode,
      site: ($("ap-site") as HTMLSelectElement).value,
      textSource: source,
    },
  });
});
$("ap-pause").addEventListener("click", () => apCommand("AUTOPILOT_PAUSE"));
$("ap-resume").addEventListener("click", () => apCommand("AUTOPILOT_RESUME"));
$("ap-skip").addEventListener("click", () => {
  if (confirm("ข้ามสินค้าที่กำลังทำอยู่แล้วไปชิ้นถัดไป?")) apCommand("AUTOPILOT_SKIP_CURRENT");
});
$("ap-stop").addEventListener("click", () => {
  if (confirm("หยุดระบบอัตโนมัติทั้งหมด?")) apCommand("AUTOPILOT_STOP");
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.autopilot) apRender((changes.autopilot.newValue as AutopilotState | undefined) ?? null);
  if (changes.products) apProductsLoaded = false;
});

apSetupOptions();

/* ================= Settings tab ================= */

interface KeyStatus {
  key: string;
  masked: string;
  cooldownUntil: number | null;
  lastError: { status?: number; message: string; at: number } | null;
}

function loadSettings() {
  send<{ ok: boolean; settings?: { geminiModel: string; flowProjectUrl: string; textSource?: string; presenter?: string } }>({
    type: "GET_SETTINGS",
  }).then((result) => {
    const settings = result?.settings;
    if (!settings) return;
    ($("presenter") as HTMLSelectElement).value =
      settings.presenter === "female" || settings.presenter === "male" ? settings.presenter : "alternate";
    ($("text-source") as HTMLSelectElement).value =
      settings.textSource === "api" || settings.textSource === "chatgpt-web" ? settings.textSource : "gemini-web";
    ($("gemini-model") as HTMLInputElement).value = settings.geminiModel;
    ($("flow-project-url") as HTMLInputElement).value = settings.flowProjectUrl;
  });
  loadApiKeyList();
  renderKeyStatus();
}

function loadApiKeyList() {
  send<{ ok: boolean; keys?: KeyStatus[] }>({ type: "GET_API_KEYS_STATUS" }).then((result) => {
    const keys = result?.keys ?? [];
    ($("gemini-api-keys") as HTMLTextAreaElement).value = keys.map((k) => k.key).join("\n");
  });
}

function formatCooldown(until: number): string {
  const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
  if (mins < 60) return `พักอีก ${mins} นาที`;
  const hours = Math.round(mins / 60);
  return `พักอีก ~${hours} ชม.`;
}

function renderKeyStatus() {
  send<{ ok: boolean; keys?: KeyStatus[] }>({ type: "GET_API_KEYS_STATUS" }).then((result) => {
    const list = $("key-status-list");
    const keys = result?.keys ?? [];
    if (keys.length === 0) {
      list.replaceChildren(emptyNote("ยังไม่มี key — วางอย่างน้อย 1 key ด้านบนแล้วกดบันทึก"));
      return;
    }
    list.replaceChildren();
    for (const k of keys) {
      const row = el("div", "key-row");
      const onCooldown = !!k.cooldownUntil;
      // A broken key (denied project, invalid key) says why instead of a countdown.
      const status = k.lastError
        ? `ใช้ไม่ได้${k.lastError.status ? ` (${k.lastError.status})` : ""}: ${k.lastError.message}`
        : onCooldown
          ? formatCooldown(k.cooldownUntil!)
          : "พร้อมใช้งาน";
      const info = el("div", "product-meta");
      const state = el("div", "key-state", status);
      state.dataset.tone = k.lastError || onCooldown ? "bad" : "ok";
      info.append(el("div", "key-masked", k.masked), state);
      row.appendChild(info);
      const actions = el("div", "actions");
      row.appendChild(actions);

      const testBtn = document.createElement("button");
      testBtn.className = "btn btn-sm";
      testBtn.textContent = "ทดสอบ";
      testBtn.addEventListener("click", () => {
        testBtn.disabled = true;
        testBtn.textContent = "กำลังทดสอบ...";
        send<{ ok: boolean; status?: number; error?: string }>({ type: "TEST_API_KEY", key: k.key }).then((result) => {
          log(result?.ok ? `key ${k.masked} ใช้งานได้ ✓` : `key ${k.masked} ใช้ไม่ได้${result?.status ? ` (${result.status})` : ""}: ${result?.error ?? "ไม่ทราบสาเหตุ"}`);
          renderKeyStatus();
        });
      });
      actions.appendChild(testBtn);

      if (onCooldown || k.lastError) {
        const resetBtn = document.createElement("button");
        resetBtn.className = "btn btn-sm btn-ghost";
        resetBtn.textContent = "รีเซ็ต";
        resetBtn.addEventListener("click", () => {
          send({ type: "RESET_KEY_COOLDOWN", key: k.key }).then(renderKeyStatus);
        });
        actions.appendChild(resetBtn);
      }
      list.appendChild(row);
    }
  });
}

$("save-settings").addEventListener("click", () => {
  const keys = ($("gemini-api-keys") as HTMLTextAreaElement).value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uniqueKeys = [...new Set(keys)];

  const settings = {
    geminiModel: ($("gemini-model") as HTMLInputElement).value.trim() || "gemini-flash-latest",
    flowProjectUrl: ($("flow-project-url") as HTMLInputElement).value.trim(),
    textSource: ($("text-source") as HTMLSelectElement).value,
  };

  Promise.all([send({ type: "SAVE_SETTINGS", settings }), send({ type: "SAVE_API_KEYS", keys: uniqueKeys })]).then(
    () => {
      const status = $("settings-status");
      status.textContent = `บันทึกแล้ว ✓ (${uniqueKeys.length} key)`;
      status.hidden = false;
      setTimeout(() => (status.hidden = true), 2000);
      renderKeyStatus();
    },
  );
});

// Saved as soon as it changes: every way of starting a video (button, batch, autopilot) reads it.
$("presenter").addEventListener("change", () => {
  void send({ type: "SAVE_SETTINGS", settings: { presenter: ($("presenter") as HTMLSelectElement).value } });
});

/* ---------- boot ---------- */

// Small disclosure menus (e.g. "ข้อมูล") fold away once an item in them is used.
for (const menu of Array.from(document.querySelectorAll<HTMLDetailsElement>("details.menu"))) {
  menu.addEventListener("click", (event) => {
    if ((event.target as Element).closest(".menu-panel button")) menu.open = false;
  });
}

populateStyles();
bindDurationToSite("duration", "site");
bindDurationToSite("ap-duration", "ap-site");
loadProducts();
loadSettings();


function updatePlatformOptions(prefix: "ap-" | "") {
  const platform = ($(prefix ? "ap-platform" : "publish-platform") as HTMLSelectElement).value as PublishPlatform;
  const select = $(`${prefix}style`) as HTMLSelectElement;
  select.innerHTML = (prefix ? '<option value="rotate">สลับสไตล์ทุกคลิป</option>' : "") + styleOptions(platform);
  select.dispatchEvent(new Event("change"));
  if (prefix) {
    apSelected.clear(); apRenderProducts();
    if (platform === "shopee") ($("ap-post-mode") as HTMLSelectElement).value = "none";
    $("ap-post-hint").textContent = platform === "shopee" ? "Shopee Affiliate: สร้างคลิปขายแล้วดาวน์โหลดไปโพสต์ในแอป Shopee ได้ ส่วนโพสต์ผ่าน Chrome ต้องมีสิทธิ์ปักสินค้าร้านอื่นในหน้าเว็บก่อน — Seller Centre อาจแสดงเฉพาะสินค้าร้านตัวเอง" : "โพสต์จะติดลิงก์สินค้าให้อัตโนมัติถ้าสินค้ามาจาก TikTok Showcase และเปิดป้าย AI-generated content ทุกครั้ง";
  } else resetReview();
}
$("ap-platform").addEventListener("change", () => updatePlatformOptions("ap-"));
$("publish-platform").addEventListener("change", () => updatePlatformOptions(""));
$("get-shopee-product").addEventListener("click", async () => {
  const button = $("get-shopee-product") as HTMLButtonElement;
  const status = $("shopee-import-status");
  button.disabled = true; button.textContent = "กำลังดึงสินค้า...";
  status.textContent = "กำลังอ่านสินค้า Shopee จากแท็บที่เปิดอยู่...";
  try {
    const tabId = await activeTabId();
    if (!tabId) throw new Error("ไม่พบแท็บ — เปิดหน้าสินค้า Shopee ใน Chrome ก่อน");
    const result = await send<{ ok: boolean; error?: string; products?: AppProduct[]; warnings?: string[] }>({ type: "FETCH_SHOPEE_PRODUCTS", tabId });
    if (!result.ok || !result.products?.length) throw new Error(result.error ?? "ไม่พบข้อมูลสินค้า Shopee ที่นำเข้าได้");
    status.textContent = `นำเข้า/อัปเดตสินค้า Shopee ${result.products.length} รายการแล้ว${result.warnings?.length ? ` · ${result.warnings.join(" · ")}` : ""}`;
    log(status.textContent); await loadProducts();
    ($("publish-platform") as HTMLSelectElement).value = "shopee"; updatePlatformOptions("");
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    log(status.textContent);
  } finally { button.disabled = false; button.textContent = "ดึงจากหน้า Shopee"; }
});

function shopeePostBlock(video: CompletedVideo): HTMLElement {
  const block = el("div", "post-block");
  const title = document.createElement("div"); title.textContent = "โพสต์ในแอป Shopee พร้อมสินค้า Affiliate"; title.className = "section-label"; block.appendChild(title);
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = "ส่งคลิปเข้ามือถือ → Shopee Video → เพิ่มสินค้า → ไอคอนลิงก์ → ใส่ลิงก์สินค้าจากไฟล์ข้อมูล → นำเข้า → เพิ่ม → เปิดป้าย AI → โพสต์ หรือเลือกสินค้าที่ตรงกันจากแท็บ Affiliate หาก Seller Centre ไม่มีสินค้า ให้ใช้ช่องทางแอปนี้"; block.appendChild(hint);
  const phone = document.createElement("button"); phone.className = "btn btn-success"; phone.dataset.icon = "phone"; phone.textContent = "ส่งไปมือถือ (Android / iPhone)";
  phone.addEventListener("click", () => { phonePanel.selectVideo(video.videoId, caption.value); showTab("phone"); }); block.appendChild(phone);
  const handoff = document.createElement("button"); handoff.className = "btn"; handoff.dataset.icon = "download"; handoff.textContent = "ดาวน์โหลดคลิปพร้อมข้อมูลสำหรับแอป Shopee";
  handoff.addEventListener("click", async () => {
    handoff.disabled = true;
    try {
      const product = shopeeProductLink(select.value);
      if (!product || product.url !== shopeeProductLink(video.productShopeeUrl)?.url) throw new Error("เลือกสินค้าที่ตรงกับคลิปนี้ก่อนดาวน์โหลด");
      const stored = await getClipsForVideo(video.videoId);
      const clip = stored.find(c => c.index === MERGED_CLIP_INDEX) ?? (stored.filter(c => c.index >= 0).length === 1 ? stored.find(c => c.index >= 0) : undefined);
      if (!clip) throw new Error("ไม่พบไฟล์วิดีโอเต็ม — ต่อคลิปให้เสร็จก่อนดาวน์โหลด");
      if (!await downloadBlob(clip.blob, `ai-affiliate/${video.videoId.slice(0,8)}-shopee.mp4`)) throw new Error("เริ่มดาวน์โหลดคลิปไม่สำเร็จ กรุณาลองใหม่");
      const text = `${video.productName}\n\n${caption.value}\n\nสินค้าที่ต้องปัก: ${product.url}\nรหัสสินค้า: ${product.itemId}\nรหัสร้าน: ${product.shopId}\n\nในแอป Shopee: Live & Video → Video → โพสต์วิดีโอ → เพิ่มสินค้า → ไอคอนลิงก์ → วางลิงก์ด้านบน → นำเข้า → เพิ่ม\nหรือเลือกสินค้าที่ตรงกันจากแท็บ Affiliate เปิดป้าย AI และตรวจตะกร้าก่อนโพสต์\nการดาวน์โหลดนี้ยังไม่ได้โพสต์และไม่ได้เพิ่มสินค้าเข้าตะกร้า Shopee`;
      if (!await downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `ai-affiliate/${video.videoId.slice(0,8)}-shopee-post.txt`)) throw new Error("เริ่มดาวน์โหลดคลิปแล้ว แต่ดาวน์โหลดข้อมูลสินค้าไม่สำเร็จ กรุณาลองใหม่");
      hint.textContent = "เริ่มดาวน์โหลดคลิปและข้อมูลสินค้าแล้ว — เมื่อดาวน์โหลดเสร็จ ส่งไฟล์ MP4 เข้ามือถือเพื่อโพสต์และปักสินค้าในแอป Shopee";
    } catch (error) { hint.textContent = error instanceof Error ? error.message : String(error); }
    finally { handoff.disabled = false; }
  }); block.appendChild(handoff);
  const caption = document.createElement("textarea"); caption.value = video.caption; caption.rows = 3; caption.maxLength = 150; caption.setAttribute("aria-label", "แคปชัน Shopee ไม่เกิน 150 ตัวอักษร"); block.appendChild(caption);
  const select = document.createElement("select"); select.setAttribute("aria-label", "สินค้า Shopee สำหรับปักสินค้า");
  select.add(new Option("เลือกสินค้า Shopee สำหรับปักสินค้า", ""));
  for (const product of products) { const link = shopeeProductLink(product.sourceUrl); if (link) select.add(new Option(product.name.slice(0, 60), link.url)); }
  if (video.productShopeeUrl && !Array.from(select.options).some((option) => option.value === video.productShopeeUrl)) select.add(new Option(video.productName, video.productShopeeUrl));
  select.value = video.productShopeeUrl ?? ""; block.appendChild(select);
  const desktopTitle = document.createElement("div"); desktopTitle.className = "section-label"; desktopTitle.textContent = "โพสต์ผ่าน Chrome (เฉพาะสินค้าที่บัญชีเลือกได้ใน Seller Centre)"; block.appendChild(desktopTitle);
  const auto = document.createElement("input"); auto.type = "checkbox";
  const label = document.createElement("label"); label.className = "check"; label.append(auto, document.createTextNode(" โพสต์อัตโนมัติหลังเตรียมครบ")); block.appendChild(label);
  const button = document.createElement("button"); button.className = "btn btn-primary"; button.dataset.icon = "send"; button.textContent = "เตรียมโพสต์ Shopee"; button.disabled = video.shopeePost?.status === "posted"; block.appendChild(button);
  button.addEventListener("click", async () => {
    if (!select.value) { log("เลือกสินค้า Shopee ก่อนโพสต์"); return; }
    if (auto.checked && !confirm("ระบบจะโพสต์วิดีโอพร้อมสินค้าลงบัญชี Shopee จริง ยืนยันไหม?")) return;
    button.disabled = true;
    try {
      const result = await send<{ ok: boolean; error?: string }>({ type: "PREPARE_SHOPEE_POST", videoId: video.videoId, caption: caption.value, autoPost: auto.checked, productUrl: select.value });
      log(result.ok ? "เปิด Shopee Seller Centre แล้ว กำลังเตรียมวิดีโอ แคปชันและสินค้า" : result.error ?? "เตรียมโพสต์ไม่สำเร็จ");
    } finally { button.disabled = false; }
  });
  if (video.shopeePost) {
    const status = document.createElement("div"); status.className = "post-status"; status.dataset.tone = video.shopeePost.status === "failed" ? "danger" : video.shopeePost.status === "posted" ? "success" : "warning";
    const labels: Record<string, string> = { preparing: "กำลังเตรียมโพสต์", ready: "เตรียมครบแล้ว รอกดโพสต์", submitting: "ส่งโพสต์แล้ว กำลังรอยืนยัน", posted: "โพสต์สำเร็จ ✓", failed: "เตรียมโพสต์ไม่สำเร็จ", uncertain: "ตรวจผลโพสต์ใน Shopee ก่อนทำต่อ" };
    status.textContent = `${labels[video.shopeePost.status] ?? video.shopeePost.status}${video.shopeePost.error ? `: ${video.shopeePost.error}` : ""}`; block.appendChild(status);
  }
  if (video.shopeePost?.status !== "posted") {
    const outcomes = video.shopeePost && ["uncertain", "submitting", "preparing", "ready"].includes(video.shopeePost.status) ? [true, false] : [true];
    for (const posted of outcomes) {
      const resolve = document.createElement("button"); resolve.className = "btn btn-sm";
      resolve.textContent = posted ? "ตรวจแล้ว: คลิปเผยแพร่พร้อมตะกร้าใน Shopee แล้ว" : "ตรวจแล้ว: ยังไม่โพสต์ / ยกเลิกการเตรียม";
      resolve.addEventListener("click", async () => {
        if (!confirm(posted ? "คุณตรวจใน Shopee แล้วว่าคลิปนี้เผยแพร่และตะกร้าติดสินค้าตรงรายการแล้วใช่ไหม?" : "ตรวจใน Shopee ว่าคลิปยังไม่เผยแพร่แล้วใช่ไหม? ระบบจะปิดแท็บงานเดิมก่อนอนุญาตให้เตรียมใหม่")) return;
        const result = await send<{ ok: boolean; error?: string }>({ type: "RESOLVE_SHOPEE_POST", videoId: video.videoId, posted });
        if (result.ok) await loadLibrary(); else log(result.error ?? "บันทึกผลไม่สำเร็จ");
      }); block.appendChild(resolve);
    }
  }
  return block;
}

initLicensePanel();
