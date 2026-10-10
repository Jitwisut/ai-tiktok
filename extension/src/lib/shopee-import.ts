import { shopeeProductLink } from "./commerce.js";

export interface ShopeeImportProduct {
  url: string;
  name: string;
  description?: string;
  price?: string;
  image?: string;
  images?: string[];
}
export interface ShopeePageResult {
  products?: ShopeeImportProduct[];
  offerUrls?: string[];
  error?: string;
}

/** Runs in the isolated world of the selected tab. Keep all DOM helpers inside
 * this function: Chrome serializes the function without its module imports. */
export function readShopeePage(): ShopeePageResult {
  const canonical = (raw: string | null | undefined): string | undefined => {
    try {
      const url = new URL(raw || "", location.href);
      if (url.protocol !== "https:" || !/^(?:www\.)?shopee\.co\.th$/i.test(url.hostname)) return;
      const ids = url.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:\/|$)/);
      return ids ? `https://shopee.co.th/product/${ids[1]}/${ids[2]}` : undefined;
    } catch { return; }
  };
  const offer = (raw: string): string | undefined => {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === "https:" && url.hostname === "affiliate.shopee.co.th" && /^\/offer\/product_offer\/\d+\/?$/.test(url.pathname)) return url.origin + url.pathname;
    } catch { /* not a product offer */ }
  };
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return el.getBoundingClientRect().width > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const text = (el: Element): string => (el as HTMLElement).innerText ?? el.textContent ?? "";
  const cleanName = (value: string | undefined): string | undefined => {
    const name = typeof value === "string" ? value.replace(/\s*[|–-]\s*Shopee(?: Thailand)?\s*$/i, "").trim() : undefined;
    return name && name.length > 2 && !/^(?:Shopee(?: Thailand)?|Shopee Affiliate Program.*|ดูสินค้า|เอา\s*ลิงก์|รายละเอียดข้อเสนอสินค้า|เข้าสู่ระบบ|Login|Sign in)$/i.test(name) ? name : undefined;
  };
  const price = (value: string): string | undefined => {
    const match = value.match(/(?:฿|THB|บาท)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const number = Number(match?.[1]?.replace(/,/g, ""));
    return Number.isFinite(number) && number > 0 ? String(number) : undefined;
  };
  const meta = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.getAttribute("content");
      if (value?.trim()) return value.trim();
    }
  };
  const images = (root: Element, primary?: string): string[] => {
    const found = new Set<string>();
    const add = (raw?: string | null) => {
      try {
        const url = new URL(raw || "", location.href);
        if (url.protocol === "https:" && raw && !/\.(?:svg|gif)(?:\?|$)/i.test(url.href)) found.add(url.href);
      } catch { /* ignore placeholders */ }
    };
    add(primary);
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
      const src = img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src");
      if (visible(img) && (img.naturalWidth >= 150 || /(?:susercontent\.com|shopee\.[^/]+)\/file\//i.test(src || ""))) add(src);
    }
    // Affiliate product photos are often rendered as CSS backgrounds.
    for (const el of [root, ...Array.from(root.querySelectorAll("div,span"))]) {
      if (!visible(el)) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg?.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/);
      if (match && /(?:susercontent\.com|shopee\.[^/]+)\/file\//i.test(match[1])) add(match[1]);
    }
    return [...found].slice(0, 8);
  };
  const scopeFor = (link: Element): Element => {
    let scope: Element = link;
    for (let depth = 0; scope.parentElement && depth < 12; depth++) {
      const next = scope.parentElement;
      if (next === document.body) break;
      const urls = new Set(Array.from(next.querySelectorAll<HTMLAnchorElement>("a[href]")).map(a => canonical(a.href)).filter(Boolean));
      if (urls.size > 1) break;
      scope = next;
      if (price(text(scope)) && images(scope).length) break;
    }
    return scope;
  };
  const nameFrom = (scope: Element, link: HTMLAnchorElement): string | undefined => {
    const direct = cleanName(link.getAttribute("title") || undefined) || cleanName(text(link)) || cleanName(scope.querySelector("img")?.getAttribute("alt") || undefined);
    if (direct) return direct;
    if (/^ดูสินค้า$/.test(text(link).trim())) {
      const preceding = cleanName(link.previousSibling?.textContent || undefined);
      if (preceding) return preceding;
    }
    const lines = text(scope).split("\n").map(s => s.trim()).filter(Boolean);
    const view = lines.findIndex(s => /^ดูสินค้า$/.test(s));
    // The detail screen places the product name immediately before ดูสินค้า.
    if (view > 0) return cleanName(lines[view - 1]);
    return cleanName(scope.querySelector("h1,h2,h3,[class*='product-name'],[class*='productName']")?.textContent || undefined);
  };

  if (location.protocol !== "https:" || !/(^|\.)shopee\.co\.th$/i.test(location.hostname)) return { error: "เปิดหน้าสินค้า Shopee หรือหน้าข้อเสนอ Shopee Affiliate ใน Chrome ก่อน" };
  const current = canonical(location.href);
  if (current) {
    const structured: Record<string, any>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, any>;
      if ([record["@type"]].flat().includes("Product")) structured.push(record);
      if (record["@graph"]) visit(record["@graph"]);
    };
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try { visit(JSON.parse(script.textContent || "")); } catch { /* malformed metadata */ }
    }
    const schema = structured.find(item => canonical(item.url || item["@id"]) === current) ?? (structured.length === 1 && !structured[0].url && !structured[0]["@id"] ? structured[0] : undefined);
    const heading = cleanName(document.querySelector("h1")?.textContent || undefined);
    const name = cleanName(schema?.name) || heading || cleanName(meta("og:title"));
    if (!name) return { error: "ยังอ่านชื่อสินค้าไม่ได้ — รอหน้าสินค้าโหลดให้ครบ หรือเข้าสู่ระบบ Shopee ก่อน" };
    const primary = meta("og:image");
    const schemaImages = [schema?.image].flat().map(value => typeof value === "string" ? value : value?.url).filter((value): value is string => typeof value === "string" && /^https:\/\//.test(value));
    const gallery = document.querySelector("[class*='product-image'],[class*='productImage'],[class*='image-gallery'],[class*='imageGallery']");
    // Metadata/gallery images belong to this item; whole-page photos may be
    // unrelated recommendations and must not become video reference images.
    const shots = [...new Set([...schemaImages, ...images(gallery ?? document.createElement("div"), primary)])].slice(0, 8);
    const priceMeta = meta("product:price:amount", "og:price:amount");
    const offerData = Array.isArray(schema?.offers) ? schema.offers[0] : schema?.offers;
    const exactPrice = priceMeta ?? offerData?.price ?? offerData?.lowPrice;
    return { products: [{ url: current, name, description: schema?.description || meta("og:description", "description"), price: exactPrice != null ? price(`฿${exactPrice}`) : price(text(document.body)), image: shots[0], images: shots }] };
  }

  // Affiliate uses Ant checkbox wrapper classes while the nested input's
  // checked property can remain false. Each offer card is itself an anchor.
  const checked = Array.from(document.querySelectorAll('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"],.ant-checkbox-wrapper-checked')).filter(el => !el.closest('thead,[role="columnheader"]'));
  const roots = checked.length ? [...new Set(checked.map(el => el.closest('tr,[role="row"],li') ?? el.closest('a[href]') ?? el.closest('[class*="card"]')).filter((el): el is Element => !!el))] : [document.body];
  const products = new Map<string, ShopeeImportProduct>();
  const offers = new Set<string>();
  for (const root of roots) {
    const links = [...(root.matches('a[href]') ? [root as HTMLAnchorElement] : []), ...Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))];
    for (const a of links) {
      if (!visible(a)) continue;
      const url = canonical(a.href);
      if (url) {
        const scope = scopeFor(a);
        const name = nameFrom(scope, a);
        if (!name) continue;
        const shots = images(scope);
        products.set(url, { url, name, price: price(text(scope)), image: shots[0], images: shots });
      } else {
        const url = offer(a.href);
        if (url) offers.add(url);
      }
    }
  }
  if (products.size || offers.size) return { products: [...products.values()], offerUrls: [...offers] };
  return { error: "ไม่พบสินค้า — เปิดหน้าสินค้าจริง หรือเมนูข้อเสนอ → ข้อเสนอผลิตภัณฑ์ใน Shopee Affiliate แล้วรอรายการโหลดก่อนกดดึง" };
}

export async function scrapeShopeeTab(tabId: number): Promise<ShopeePageResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https:\/\/(?:[a-z0-9-]+\.)*shopee\.co\.th\//i.test(tab.url)) throw new Error("เปิดหน้าสินค้า Shopee หรือหน้าข้อเสนอ Shopee Affiliate ใน Chrome ก่อน");
  // Direct injection also works on tabs opened before an extension reload.
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: readShopeePage });
  if (!result?.result) throw new Error("อ่านหน้าสินค้าไม่ได้ — รอหน้าโหลดให้ครบแล้วลองอีกครั้ง");
  return result.result;
}

export async function collectShopeeProducts(tabId: number): Promise<{ products: ShopeeImportProduct[]; warnings: string[] }> {
  const initial = await scrapeShopeeTab(tabId);
  const products = new Map((initial.products ?? []).map(product => [product.url, product]));
  const warnings: string[] = [];
  const importedIds = new Set([...products.values()].map(p => shopeeProductLink(p.url)?.itemId));
  const offers = [...new Set(initial.offerUrls ?? [])].filter(url => !importedIds.has(new URL(url).pathname.split("/").filter(Boolean).pop()));
  if (offers.length > 20) warnings.push(`หน้านี้มี ${offers.length} ข้อเสนอ ดึงครั้งละ 20 รายการ`);
  for (const url of offers.slice(0, 20)) {
    // Resolve shop/item IDs from the visible detail page, never guess a shop ID
    // or use Shopee's private APIs. Temporary tabs do not replace the user's page.
    const parsed = new URL(url);
    if (parsed.origin !== "https://affiliate.shopee.co.th" || !/^\/offer\/product_offer\/\d+\/?$/.test(parsed.pathname)) continue;
    let opened: chrome.tabs.Tab | undefined;
    try {
      opened = await chrome.tabs.create({ url, active: false });
      if (!opened.id) throw new Error("เปิดข้อเสนอไม่สำเร็จ");
      let result: ShopeePageResult | undefined;
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 700));
        try { result = await scrapeShopeeTab(opened.id); } catch { continue; }
        if (result.products?.length) break;
      }
      const expectedId = parsed.pathname.split("/").filter(Boolean).pop();
      const exact = result?.products?.filter(p => shopeeProductLink(p.url)?.itemId === expectedId) ?? [];
      if (!exact.length) throw new Error("หน้าไม่แสดงข้อมูลสินค้า หรือยังไม่ได้เข้าสู่ระบบ Affiliate");
      for (const product of exact) products.set(product.url, product);
    } catch (error) { warnings.push(`ข้อเสนอ ${parsed.pathname.split("/").pop()}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { if (opened?.id) await chrome.tabs.remove(opened.id).catch(() => {}); }
  }
  if (!products.size) throw new Error(warnings[0] || initial.error || "ไม่พบข้อมูลสินค้าที่นำเข้าได้");
  return { products: [...products.values()], warnings };
}
