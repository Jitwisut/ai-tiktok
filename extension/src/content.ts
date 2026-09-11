interface ExtractedProduct {
  url: string;
  name?: string;
  description?: string;
  price?: string;
  image?: string;
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

function extractProduct(): ExtractedProduct {
  const priceRaw = getMeta("product:price:amount", "og:price:amount");
  return {
    url: window.location.href,
    name: getMeta("og:title") ?? document.title,
    description: getMeta("og:description", "description"),
    price: priceRaw?.replace(/[^0-9.]/g, ""),
    image: getMeta("og:image"),
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
