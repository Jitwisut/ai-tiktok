import { safeFetch } from "@/lib/net/safe-fetch";
import type { ProductData, ProductImporter } from "./types";

function extractMeta(html: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const match = html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
        "i",
      ),
    );
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function extractTitle(html: string): string | undefined {
  return html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
}

export class UrlImporter implements ProductImporter {
  source = "url";

  async import(url: string): Promise<ProductData> {
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AIAffiliateStudio/1.0)" },
    });

    if (!res.ok) {
      throw new Error(`ไม่สามารถดึงข้อมูลจาก URL ได้ (${res.status})`);
    }

    const html = await res.text();

    const name =
      extractMeta(html, "og:title") ?? extractTitle(html) ?? "สินค้าไม่มีชื่อ";
    const description = extractMeta(html, "og:description", "description");
    const image = extractMeta(html, "og:image");
    const priceRaw = extractMeta(
      html,
      "product:price:amount",
      "og:price:amount",
    );
    const currency = extractMeta(
      html,
      "product:price:currency",
      "og:price:currency",
    );

    const price = priceRaw ? Number(priceRaw.replace(/[^0-9.]/g, "")) : undefined;

    return {
      name: name.slice(0, 200),
      description: description?.slice(0, 2000),
      price: Number.isFinite(price) ? price : undefined,
      currency,
      images: image ? [image] : [],
      sourceUrl: url,
    };
  }
}
