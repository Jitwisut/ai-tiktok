// Reads the product rows checked in TikTok Studio's own selection table and
// imports them into the app. TikTok Studio is a hashed-classname SPA, so
// this leans on structure (checkbox -> row -> text/image) rather than
// classnames, and skips any row it can't confidently parse instead of
// guessing.

interface ScrapedProduct {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
}

function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute("aria-checked") === "true";
}

/** Excludes a header "select all" checkbox, which is checked but not a product row. */
function findCheckedProductBoxes(): Element[] {
  const boxes = [
    ...Array.from(document.querySelectorAll('input[type="checkbox"]')),
    ...Array.from(document.querySelectorAll('[role="checkbox"]')),
  ];
  return boxes.filter(
    (el) => isChecked(el) && !el.closest("thead") && !el.closest('[role="columnheader"]'),
  );
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

function extractImage(row: HTMLElement): string | undefined {
  const img = row.querySelector("img");
  const src = img?.currentSrc || img?.src;
  return src && src.startsWith("http") ? src : undefined;
}

/** Only the current page's rows are in the DOM — selections on other pages of the list aren't seen. */
function scrapeSelectedProducts(): ScrapedProduct[] {
  const rows = new Map<HTMLElement, ScrapedProduct>();

  for (const box of findCheckedProductBoxes()) {
    const row = findRow(box);
    if (!row || rows.has(row)) continue;

    const text = row.innerText;
    const tiktokId = extractProductId(text);
    if (!tiktokId) continue; // can't identify this row confidently — skip rather than guess

    const price = extractPrice(text);
    const name = extractName(row, price, tiktokId);
    if (!name) continue;

    rows.set(row, { tiktokId, name, price, image: extractImage(row) });
  }

  return [...rows.values()];
}

function injectLoadButton() {
  if (document.getElementById("tiktok-studio-load-button")) return;

  const button = document.createElement("button");
  button.id = "tiktok-studio-load-button";
  button.textContent = "โหลดสินค้าจากตะกร้า";
  Object.assign(button.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
    padding: "10px 16px",
    borderRadius: "9999px",
    border: "none",
    background: "#111827",
    color: "#fff",
    fontFamily: "sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);

  const status = document.createElement("div");
  status.id = "tiktok-studio-load-status";
  Object.assign(status.style, {
    position: "fixed",
    bottom: "62px",
    right: "24px",
    zIndex: "2147483647",
    maxWidth: "260px",
    padding: "6px 10px",
    borderRadius: "8px",
    background: "#111827",
    color: "#f9fafb",
    fontFamily: "sans-serif",
    fontSize: "12px",
    lineHeight: "1.4",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  function showStatus(text: string) {
    status.textContent = text;
    status.style.display = "block";
  }

  button.addEventListener("click", () => {
    const products = scrapeSelectedProducts();
    if (products.length === 0) {
      showStatus("ไม่พบสินค้าที่เลือก — ติ๊กเลือกสินค้าในตารางก่อนกด");
      return;
    }

    button.disabled = true;
    button.textContent = `กำลังโหลด ${products.length} รายการ...`;

    chrome.runtime.sendMessage(
      { type: "IMPORT_TIKTOK_PRODUCTS", products },
      (result: { ok: boolean; error?: string }) => {
        button.disabled = false;
        button.textContent = "โหลดสินค้าจากตะกร้า";
        showStatus(
          result?.ok
            ? `เพิ่มแล้ว ${products.length} รายการ ✓`
            : (result?.error ?? "โหลดสินค้าไม่สำเร็จ"),
        );
      },
    );
  });

  document.body.append(button, status);
}

injectLoadButton();
