interface ExtractedProduct {
  url: string;
  name?: string;
  description?: string;
  price?: string;
  image?: string;
  images?: string[];
}

function getMeta(...keys: string[]): string | undefined {
  for (const key of keys) {
    const el =
      document.querySelector(`meta[property="${key}"]`) ??
      document.querySelector(`meta[name="${key}"]`);
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
 * price, and picking the minimum returned those instead. The form is
 * prefilled and editable, so a wrong guess is visible before saving.
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

function extractProduct(): ExtractedProduct {
  const priceRaw = getMeta("product:price:amount", "og:price:amount");
  const primaryImage = getMeta("og:image");

  return {
    url: window.location.href,
    name: getMeta("og:title") ?? document.title,
    description: getMeta("og:description", "description"),
    price: priceRaw?.replace(/[^0-9.]/g, "") ?? findPriceInText(),
    image: primaryImage,
    images: findProductImages(primaryImage),
  };
}

function injectButton() {
  if (document.getElementById("ai-studio-add-button")) return;

  const button = document.createElement("button");
  button.id = "ai-studio-add-button";
  button.textContent = "+ Add to AI Studio";
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

  button.addEventListener("click", () => {
    button.textContent = "กำลังเพิ่ม...";
    button.disabled = true;
    chrome.runtime.sendMessage(
      { type: "ADD_PRODUCT", product: extractProduct() },
      () => {
        button.textContent = "เพิ่มแล้ว ✓";
        setTimeout(() => {
          button.textContent = "+ Add to AI Studio";
          button.disabled = false;
        }, 2000);
      },
    );
  });

  document.body.appendChild(button);
}

injectButton();
