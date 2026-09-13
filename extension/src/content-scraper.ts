// Passive content script — no visible UI. Replaces content.ts's floating
// "+ Add to AI Studio" button and products-panel.ts's scraping logic. All
// control now lives in the side panel, which messages this script to read
// whatever page is currently active.

interface ExtractedProduct {
  url: string;
  name?: string;
  description?: string;
  price?: string;
  image?: string;
  images?: string[];
}

interface ScrapedTikTokProduct {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
}

/* ---------- single-page extraction (og:meta) ---------- */

function getMeta(...keys: string[]): string | undefined {
  for (const key of keys) {
    const el = document.querySelector(`meta[property="${key}"]`) ?? document.querySelector(`meta[name="${key}"]`);
    const content = el?.getAttribute("content");
    if (content) return content;
  }
  return undefined;
}

/**
 * Falls back to the rendered page when a shop omits price metadata — TikTok
 * Shop publishes og:title and og:image but no price tag, so the number only
 * exists as text. Takes the first amount rather than the smallest: a page
 * carries instalment figures and shipping fees that are smaller than the
 * price, and picking the minimum returned those instead.
 */
function findPriceInText(): string | undefined {
  const match = document.body.innerText.match(/(?:฿|บาท|THB)\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : undefined;
}

/** Product shots only — skips icons, avatars and other page furniture. */
function findProductImages(primary: string | undefined): string[] {
  const seen = new Set<string>();
  const images: string[] = [];

  if (primary) {
    seen.add(primary);
    images.push(primary);
  }

  for (const img of Array.from(document.querySelectorAll("img"))) {
    if (images.length >= 3) break;
    const src = img.currentSrc || img.src;
    if (!src || !src.startsWith("http") || seen.has(src)) continue;
    if (img.naturalWidth < 300 || img.naturalHeight < 300) continue;
    seen.add(src);
    images.push(src);
  }

  return images;
}

/**
 * "+ เพิ่มจากหน้านี้" only makes sense on an actual product page. Without
 * this, pointing it at a Google/Bing search results page silently extracts
 * that page's own title ("ส้ม - ค้นหาด้วย Google") and thumbnail as if they
 * were the product — the AI then dutifully writes ad copy for whatever that
 * title says, which looks like a bad analysis but is really bad input.
 */
const SEARCH_RESULTS_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo)\.[a-z.]+$/i;
const SEARCH_TITLE_SUFFIX = /[-–—]\s*(ค้นหาด้วย google|google search|search results?|bing)\s*$/i;

function looksLikeSearchResultsPage(): boolean {
  if (SEARCH_RESULTS_HOSTS.test(window.location.hostname) && /\/search/i.test(window.location.pathname)) {
    return true;
  }
  return SEARCH_TITLE_SUFFIX.test(document.title);
}

function extractProduct(): ExtractedProduct | { error: string } {
  if (looksLikeSearchResultsPage()) {
    return { error: "หน้านี้เป็นหน้าผลการค้นหา ไม่ใช่หน้าสินค้า — เปิดหน้าสินค้าจริงก่อนแล้วลองใหม่" };
  }

  const priceRaw = getMeta("product:price:amount", "og:price:amount");
  const primaryImage = getMeta("og:image");
  const name = getMeta("og:title") ?? document.title;

  if (!name.trim()) {
    return { error: "อ่านชื่อสินค้าจากหน้านี้ไม่ได้" };
  }

  return {
    url: window.location.href,
    name,
    description: getMeta("og:description", "description"),
    price: priceRaw?.replace(/[^0-9.]/g, "") ?? findPriceInText(),
    image: primaryImage,
    images: findProductImages(primaryImage),
  };
}

/* ---------- checked-row scraping (TikTok Shop/Studio product tables) ---------- */

function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute("aria-checked") === "true";
}

/** Excludes a header "select all" checkbox. */
function findCheckedProductBoxes(): Element[] {
  const boxes = [
    ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
    ...Array.from(document.querySelectorAll('[role="checkbox"]')),
  ];
  return boxes.filter((el) => isChecked(el) && !el.closest("thead") && !el.closest('[role="columnheader"]'));
}

function findRow(box: Element): HTMLElement | null {
  return (
    (box.closest("tr") as HTMLElement | null) ??
    (box.closest('[role="row"]') as HTMLElement | null) ??
    (box.closest("li") as HTMLElement | null)
  );
}

function extractPrice(text: string): number | undefined {
  const match = text.match(/(?:฿|บาท|THB)\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

/** TikTok product IDs run well into the double digits — long enough that a price or count won't collide. */
function extractProductId(text: string): string | undefined {
  return text.match(/\b\d{13,}\b/)?.[0];
}

function extractName(row: HTMLElement, price: number | undefined, productId: string): string | undefined {
  const lines = row.innerText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.includes(productId)) continue;
    if (price !== undefined && line.includes(String(price))) continue;
    if (/^[฿$]?[\d,.]+$/.test(line)) continue;
    if (line.length < 4) continue;
    return line;
  }
  return row.querySelector("img")?.getAttribute("alt") || undefined;
}

function extractRowImage(row: HTMLElement): string | undefined {
  const img = row.querySelector("img");
  const src = img?.currentSrc || img?.src;
  return src && src.startsWith("http") ? src : undefined;
}

/** Only the current page's rows are in the DOM — selections on other pages of a paginated list aren't seen. */
function scrapeSelectedProducts(): ScrapedTikTokProduct[] {
  const rows = new Map<HTMLElement, ScrapedTikTokProduct>();

  for (const box of findCheckedProductBoxes()) {
    const row = findRow(box);
    if (!row || rows.has(row)) continue;

    const text = row.innerText;
    const tiktokId = extractProductId(text);
    if (!tiktokId) continue; // can't identify this row confidently — skip rather than guess

    const price = extractPrice(text);
    const name = extractName(row, price, tiktokId);
    if (!name) continue;

    rows.set(row, { tiktokId, name, price, image: extractRowImage(row) });
  }

  return [...rows.values()];
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === "EXTRACT_PRODUCT") {
    sendResponse(extractProduct());
    return;
  }
  if (message?.type === "SCRAPE_CHECKED_PRODUCTS") {
    sendResponse(scrapeSelectedProducts());
    return;
  }
});
