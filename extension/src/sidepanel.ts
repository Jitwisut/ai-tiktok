// The one big UI. Runs as a real extension page (not injected into someone
// else's site), so it can use real ES module imports straight into the
// IndexedDB clip library, and talks to background.ts for everything else.

import { getClipsForVideo, MERGED_CLIP_INDEX } from "./lib/library.js";
import { CONTENT_STYLES } from "./lib/analysis-prompts.js";

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

function log(text: string) {
  const list = $("log");
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString("th-TH")} — ${text}`;
  list.prepend(line);
  while (list.children.length > 20) list.lastElementChild?.remove();
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/* ---------- tabs ---------- */

const TABS = ["products", "library", "settings"] as const;
type TabName = (typeof TABS)[number];

function showTab(name: TabName) {
  for (const tab of TABS) {
    $(`view-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).classList.toggle("active", tab === name);
  }
  if (name === "library") loadLibrary();
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
}

interface GeneratedScene {
  duration: number;
  description: string;
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

function populateStyles() {
  const select = $("style") as HTMLSelectElement;
  select.innerHTML = CONTENT_STYLES.map((s) => `<option value="${s}">${s}</option>`).join("");
}

function setCatalogStatus(text: string) {
  const el = $("catalog-status");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function updateSelectionCount() {
  const deleteBtn = $("delete-selected") as HTMLButtonElement;
  const resetBtn = $("reset-selection") as HTMLButtonElement;
  deleteBtn.textContent = `Delete (${selected.size})`;
  deleteBtn.disabled = selected.size === 0;
  resetBtn.textContent = `Reset (${selected.size})`;
}

function renderProductsTable() {
  const tbody = $("products-tbody");
  tbody.innerHTML = "";

  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:#9ca3af">ยังไม่มีข้อมูล — กด "ดึงจากหน้า TikTok" เพื่อเพิ่ม</td></tr>`;
    return;
  }

  for (const product of products) {
    const tr = document.createElement("tr");
    const priceLabel = product.price ? `฿${product.price}` : "-";
    tr.innerHTML = `
      <td><input type="checkbox" ${selected.has(product.id) ? "checked" : ""}></td>
      <td><img src="${product.images[0] ?? ""}" /></td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</td>
      <td style="white-space:nowrap;color:#d1d5db">${priceLabel}</td>
      <td style="color:#9ca3af;font-size:10px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${product.id}">${product.id}</td>
    `;
    tr.querySelector("input")?.addEventListener("change", (event) => {
      if ((event.target as HTMLInputElement).checked) selected.add(product.id);
      else selected.delete(product.id);
      updateSelectionCount();
      resetReview();
    });
    tbody.appendChild(tr);
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

function renderReview() {
  const box = $("review");
  if (!activeAnalysis && !activeContent) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const parts: string[] = [];
  if (activeAnalysis) {
    parts.push(`<div style="font-weight:700;color:#93c5fd;margin-bottom:2px">1. วิเคราะห์สินค้า</div>`);
    parts.push(`<div><b>กลุ่มเป้าหมาย:</b> ${escapeHtml(activeAnalysis.targetCustomer)}</div>`);
    parts.push(`<div><b>Pain points:</b> ${escapeHtml(activeAnalysis.painPoints.join(", "))}</div>`);
    parts.push(`<div><b>จุดขาย:</b> ${escapeHtml(activeAnalysis.sellingPoints.join(", "))}</div>`);
    parts.push(`<div><b>มุมคอนเทนต์:</b> ${escapeHtml(activeAnalysis.angles.join(", "))}</div>`);
  }
  if (activeContent) {
    parts.push(`<div style="font-weight:700;color:#93c5fd;margin:8px 0 2px">2. คอนเทนต์</div>`);
    parts.push(`<div><b>Hook:</b> ${escapeHtml(activeContent.hook)}</div>`);
    parts.push(`<div><b>Script:</b> ${escapeHtml(activeContent.script)}</div>`);
    parts.push(`<div><b>Caption:</b> ${escapeHtml(activeContent.caption)}</div>`);
    parts.push(`<div><b>CTA:</b> ${escapeHtml(activeContent.cta)}</div>`);
  }
  if (activeScenes.length) {
    parts.push(`<div style="font-weight:700;color:#93c5fd;margin:8px 0 2px">ฉาก (${activeScenes.length})</div>`);
    activeScenes.forEach((scene, i) => {
      parts.push(`<div>${i + 1}. (${scene.duration}s) ${escapeHtml(scene.description)}</div>`);
    });
  }

  box.style.display = "block";
  box.innerHTML = parts.join("");
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
    button.textContent = "1. วิเคราะห์สินค้า";
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

  const button = $("generate-scenes") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "กำลังสร้างฉาก...";
  log("กำลังสร้างคอนเทนต์และวางแผนฉาก...");

  send<{ ok: boolean; content?: GeneratedContent; scenes?: GeneratedScene[]; error?: string }>({
    type: "GENERATE_CONTENT_SCENES",
    productId,
    style,
    targetDuration,
  }).then((result) => {
    button.disabled = false;
    button.textContent = "2. สร้างฉาก";
    if (!result?.ok || !result.content) {
      log(result?.error ?? "สร้างฉากไม่สำเร็จ");
      return;
    }
    activeContent = result.content;
    activeScenes = result.scenes ?? [];
    renderReview();
    ($("create-video") as HTMLButtonElement).disabled = false;
    log(`สร้างฉากเสร็จแล้ว (${activeScenes.length} ฉาก) — ตรวจสอบด้านล่าง แล้วกด "สร้างวิดีโอ" ได้เลย`);
  });
}

function selectedRunOptions() {
  return {
    targetDuration: Number(($("duration") as HTMLSelectElement).value || 24),
    count: Number(($("repeat") as HTMLSelectElement).value || 1),
    site: (($("site") as HTMLSelectElement).value || "flow") as "aistudio" | "flow",
  };
}

function describeRun(targetDuration: number, count: number): string {
  const clips = Math.max(1, Math.round(targetDuration / 8));
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
  log(`กำลังเริ่ม: ${describeRun(targetDuration, count)}`);

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
    log('ยังไม่มีคอนเทนต์ — กด "2. สร้างฉาก" ก่อน');
    return;
  }
  startBatch(activeContent.id, $("create-video") as HTMLButtonElement, "3. สร้างวิดีโอ");
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
}

let libraryBusy = false;
let libraryActiveVideoId: string | null = null;

function libraryRow(imageUrl: string | null, title: string, subtitle: string, actionLabel: string, onAction: (button: HTMLButtonElement) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "card";
  row.innerHTML = `
    <img src="${imageUrl ?? ""}" />
    <div class="info">
      <div class="title">${escapeHtml(title)}</div>
      <div class="subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
  const button = document.createElement("button");
  button.className = "btn btn-primary";
  button.textContent = actionLabel;
  button.style.flexShrink = "0";
  button.addEventListener("click", () => onAction(button));
  row.appendChild(button);
  return row;
}

function setProgress(current: number, total: number, state: string) {
  const wrap = $("progress-wrap");
  if (!total || state === "idle") {
    wrap.style.display = "none";
    return;
  }
  const labels: Record<string, string> = {
    generating: "กำลังสร้าง",
    uploading: "กำลังอัปโหลด",
    done: "เสร็จแล้ว",
    failed: "ล้มเหลว",
    cancelled: "ยกเลิกแล้ว",
  };
  wrap.style.display = "block";
  $("progress-label").textContent = `${labels[state] ?? state} — คลิป ${current}/${total}`;
  const bar = $("progress-bar");
  bar.style.width = `${Math.round((current / Math.max(1, total)) * 100)}%`;
  bar.style.background = state === "failed" ? "#dc2626" : state === "done" ? "#16a34a" : "#2563eb";
}

function setBusy(running: boolean, videoId?: string) {
  libraryBusy = running;
  if (running && videoId) libraryActiveVideoId = videoId;
}

async function renderQueueInfo() {
  const stored = await chrome.storage.local.get("jobQueue");
  const queue = stored.jobQueue as { current: string | null; pending: unknown[] } | undefined;
  const el = $("queue-info");
  const waiting = queue?.pending.length ?? 0;
  el.textContent = waiting ? `รอคิวอีก ${waiting} วิดีโอ — จะเริ่มต่ออัตโนมัติเมื่อวิดีโอนี้เสร็จ` : "";
  el.style.display = waiting ? "block" : "none";
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
  const site = (($("site") as HTMLSelectElement).value ?? "flow") as "aistudio" | "flow";

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

function clipPlayer(blob: Blob, width: string): HTMLVideoElement {
  const videoEl = document.createElement("video");
  videoEl.src = URL.createObjectURL(blob);
  videoEl.controls = true;
  videoEl.preload = "metadata";
  videoEl.style.width = width;
  videoEl.style.borderRadius = "6px";
  videoEl.style.background = "#000";
  return videoEl;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }).then(
    () => log(`ดาวน์โหลด ${filename} แล้ว`),
    (err: unknown) => log(`ดาวน์โหลดไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`),
  );
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
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

async function renderClips() {
  const container = $("clips-list");
  const result = await send<{ ok: boolean; videos?: CompletedVideo[] }>({ type: "GET_COMPLETED_VIDEOS" });
  const videos = result?.videos ?? [];

  container.innerHTML = "";
  if (videos.length === 0) {
    container.innerHTML = `<div class="empty">ยังไม่มีคลิปที่เสร็จแล้ว</div>`;
    return;
  }

  for (const video of videos) {
    const wrap = document.createElement("div");
    wrap.className = "card";
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "stretch";
    const shape = video.clipCount > 1 ? `${video.seconds} วิ · ${video.clipCount} คลิป` : `${video.seconds} วิ · คลิปเดียว`;
    wrap.innerHTML = `<div class="title">${escapeHtml(video.productName)}</div><div class="subtitle">${escapeHtml(video.hook)} · ${shape}</div>`;

    const stored = await getClipsForVideo(video.videoId);
    const merged = stored.find((c) => c.index === MERGED_CLIP_INDEX);
    const parts = stored.filter((c) => c.index >= 0);

    if (merged) {
      const block = document.createElement("div");
      block.className = "merged-video";
      block.appendChild(clipPlayer(merged.blob, "160px"));
      const side = document.createElement("div");
      side.innerHTML = `<div class="badge">วิดีโอเต็ม ${video.seconds} วิ</div><div class="subtitle" style="white-space:normal">ต่อ ${parts.length} คลิปเป็นไฟล์เดียวแล้ว พร้อมโพสต์</div>`;
      const download = document.createElement("button");
      download.className = "btn btn-success";
      download.style.marginTop = "8px";
      download.textContent = "ดาวน์โหลดวิดีโอเต็ม";
      download.addEventListener("click", () => downloadBlob(merged.blob, `ai-affiliate/${video.videoId}-full-${video.seconds}s.mp4`));
      side.appendChild(download);
      block.appendChild(side);
      wrap.appendChild(block);
    } else if (parts.length > 1) {
      const row = document.createElement("div");
      row.style.marginTop = "8px";
      if (video.mergeError) {
        row.innerHTML = `<div class="subtitle" style="white-space:normal;color:#fbbf24;margin-bottom:6px">${escapeHtml(video.mergeError)}</div>`;
      }
      const mergeButton = document.createElement("button");
      mergeButton.className = "btn btn-primary";
      mergeButton.textContent = "ต่อเป็นวิดีโอเดียว";
      mergeButton.addEventListener("click", () => mergeVideo(video, mergeButton));
      row.appendChild(mergeButton);
      wrap.appendChild(row);
    }

    if (parts.length > 1 || !merged) {
      if (merged) {
        const label = document.createElement("div");
        label.className = "clip-parts-label";
        label.textContent = "คลิปย่อย";
        wrap.appendChild(label);
      }
      const clipRow = document.createElement("div");
      clipRow.style.display = "flex";
      clipRow.style.gap = "6px";
      clipRow.style.marginTop = "6px";
      clipRow.style.flexWrap = "wrap";
      for (const clip of parts) clipRow.appendChild(clipPlayer(clip.blob, merged ? "80px" : "110px"));
      wrap.appendChild(clipRow);
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
  jobsList.innerHTML = "";
  const jobs = jobsResult?.jobs ?? [];
  if (jobs.length === 0) {
    jobsList.innerHTML = `<div class="empty">ยังไม่มีงานที่รออยู่ — ไปที่แท็บ "สินค้า" แล้วสร้างวิดีโอ</div>`;
  } else {
    for (const job of jobs) {
      jobsList.appendChild(libraryRow(job.imageUrl, job.productName, job.hook, "สร้าง", (btn) => runJob(job, btn)));
    }
  }

  const contentsList = $("contents-list");
  contentsList.innerHTML = "";
  const contents = contentsResult?.contents ?? [];
  if (contents.length === 0) {
    contentsList.innerHTML = `<div class="empty">ยังไม่มีคอนเทนต์ที่มีฉาก — ทำขั้นตอน "สร้างฉาก" ในแท็บสินค้าก่อน</div>`;
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
  if (status) {
    const el = $("status-text");
    el.textContent = status.text;
    el.style.color = status.color;
    el.style.display = status.text ? "block" : "none";
  }

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
  if (status?.text) {
    const el = $("status-text");
    el.textContent = status.text;
    el.style.color = status.color;
    el.style.display = "block";
  }
});

renderQueueInfo();

/* ================= Settings tab ================= */

interface KeyStatus {
  key: string;
  masked: string;
  cooldownUntil: number | null;
}

function loadSettings() {
  send<{ ok: boolean; settings?: { geminiModel: string; flowProjectUrl: string } }>({
    type: "GET_SETTINGS",
  }).then((result) => {
    const settings = result?.settings;
    if (!settings) return;
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
      list.innerHTML = `<div class="empty">ยังไม่มี key — วางอย่างน้อย 1 key ด้านบนแล้วกดบันทึก</div>`;
      return;
    }
    list.innerHTML = "";
    for (const k of keys) {
      const row = document.createElement("div");
      row.className = "card";
      const onCooldown = !!k.cooldownUntil;
      row.innerHTML = `
        <div class="info">
          <div class="title" style="font-family:monospace">${escapeHtml(k.masked)}</div>
          <div class="subtitle" style="color:${onCooldown ? "#f87171" : "#4ade80"}">${onCooldown ? formatCooldown(k.cooldownUntil!) : "พร้อมใช้งาน"}</div>
        </div>
      `;
      if (onCooldown) {
        const resetBtn = document.createElement("button");
        resetBtn.className = "btn";
        resetBtn.textContent = "รีเซ็ต";
        resetBtn.style.flexShrink = "0";
        resetBtn.addEventListener("click", () => {
          send({ type: "RESET_KEY_COOLDOWN", key: k.key }).then(renderKeyStatus);
        });
        row.appendChild(resetBtn);
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
  };

  Promise.all([send({ type: "SAVE_SETTINGS", settings }), send({ type: "SAVE_API_KEYS", keys: uniqueKeys })]).then(
    () => {
      const status = $("settings-status");
      status.textContent = `บันทึกแล้ว ✓ (${uniqueKeys.length} key)`;
      status.style.display = "block";
      setTimeout(() => (status.style.display = "none"), 2000);
      renderKeyStatus();
    },
  );
});

/* ---------- boot ---------- */

populateStyles();
loadProducts();
loadSettings();
