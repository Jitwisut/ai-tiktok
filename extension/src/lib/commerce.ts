import type { StylePlaybook } from "./style-playbooks.js";

export type PublishPlatform = "tiktok" | "shopee";
export const SHOPEE_STYLES = ["Shopee Market", "Shopee Factory", "Shopee Live", "Shopee Online"] as const;

export const SHOPEE_STYLE_LABELS = {
  "Shopee Market": { name: "ขายหน้าร้านในตลาด", description: "ผู้ขายสาธิตสินค้าบนแผงตลาด พูดเชิญชวนกระชับ เห็นสินค้าและวิธีใช้ชัด" },
  "Shopee Factory": { name: "ขายในโรงงาน / จุดแพ็กสินค้า", description: "ผู้ขายโชว์สินค้าที่โต๊ะแพ็กในฉากโรงงานสะอาด เน้นรายละเอียดสินค้า โดยไม่แต่งข้อมูลแหล่งผลิต" },
  "Shopee Live": { name: "ไลฟ์สดขายสินค้า", description: "ผู้ขายพูดกับกล้องหลังโต๊ะไลฟ์ ยกและสาธิตสินค้าพร้อมชวนกดสินค้าที่แนบ" },
  "Shopee Online": { name: "ร้านออนไลน์ขายสินค้า", description: "ผู้ขายนำเสนอสินค้าบนโต๊ะร้านออนไลน์ ฉากเรียบร้อย เห็นจุดขายและปิดการขายชัด" },
} as const;

const settings: Record<string, string> = {
  "Shopee Market": "a tidy Thai market stall with a simple product demonstration counter, softly blurred market stalls in the background, no crowds in the foreground",
  "Shopee Factory": "a clean factory-style packing area with a demonstration table, neutral boxes and shelves softly blurred in the background; this is a promotional set, not evidence of the product's manufacturer or origin",
  "Shopee Live": "a small Thai livestream sales studio, smartphone on a fixed tripod, presenter behind a demonstration table, soft frontal light, no fake live interface, viewer counts or comments",
  "Shopee Online": "a tidy Thai online shop packing and display desk, neutral shelves softly blurred in the background, soft even lighting",
};

export const SHOPEE_PLAYBOOKS: Record<string, StylePlaybook> = Object.fromEntries(SHOPEE_STYLES.map((style) => [style, {
  goal: "ขายสินค้าให้เข้าใจทันที เห็นรายละเอียดหรือวิธีใช้งานจริง แล้วชวนกดสินค้าที่แนบใน Shopee Video",
  structure: "seller's concrete opening offer → clear product demonstration → one supported selling point → who it suits → direct Shopee product CTA",
  writing: "ภาษาไทยแบบผู้ขายที่มั่นใจ ชวนซื้ออย่างเป็นธรรมชาติ เลือกจุดขายเดียวและพูดให้ครบความ ไม่อ้างประสบการณ์หรือโปรโมชั่นที่ไม่มีข้อมูลยืนยัน",
  videoDirection: `seller-led product demonstration at ${settings[style]}; open on the seller and actual product, show one simple useful interaction in close-up, end with an inviting sales gesture towards the product`,
  speechMode: "ใช้ dialogue เป็นหลัก ผู้ขายพูดกับกล้อง น้ำเสียงชัด มั่นใจ มีจังหวะให้ดูสินค้า มีผู้พูดคนเดียว",
  camera: "a steady smartphone on a tripod, clear medium framing of the seller and demonstration table",
  lighting: style === "Shopee Market" ? "soft natural daylight under a market awning" : "soft even light with accurate product colours",
  presenter: "face",
  speech: "sell",
  delivery: style === "Shopee Live" ? "a confident Thai livestream seller, lively and inviting, clear natural Thai at an unhurried pace" : "a confident approachable Thai seller, persuasive and clear, inviting customers to inspect and buy the product",
  soundBed: "natural quiet ambience appropriate to the location, very low background music below the seller's voice",
} satisfies StylePlaybook]));

export function platformForStyle(style: string, explicit?: PublishPlatform): PublishPlatform {
  return explicit ?? (SHOPEE_STYLES.includes(style as typeof SHOPEE_STYLES[number]) ? "shopee" : "tiktok");
}

export function salesContext(style: string): string {
  return settings[style] ?? "a clear product demonstration counter suitable for the product";
}

export function platformRule(platform: PublishPlatform): string {
  return platform === "shopee"
    ? "ปลายทางคือ Shopee Video: ใช้ CTA เช่น กดดูสินค้าที่แนบ หรือเลือกสินค้าด้านล่าง ห้ามพูด TikTok หรือตะกร้าเหลือง ห้ามแต่งราคา ส่วนลด ส่งฟรี ยอดขาย จำนวนคนดู สต็อกจำกัด หรืออ้างว่าเป็นโรงงานผู้ผลิตถ้าไม่มีหลักฐานจากข้อมูลสินค้า ฉากโรงงานเป็นฉากนำเสนอเท่านั้น ไม่ใส่ UI ไลฟ์ปลอม"
    : "ปลายทางคือ TikTok Shop: ชวนกดตะกร้าเหลืองด้านล่างด้วยภาษาไทยที่เป็นธรรมชาติ";
}

export interface ShopeeProductLink { shopId: string; itemId: string; url: string }

/** Canonical Thai product URLs only; shortened affiliate links must first be opened in the browser. */
export function shopeeProductLink(raw: string | null | undefined): ShopeeProductLink | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !/(^|\.)shopee\.co\.th$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:\/|$)/);
    if (!match) return null;
    return { shopId: match[1], itemId: match[2], url: `https://shopee.co.th/product/${match[1]}/${match[2]}` };
  } catch { return null; }
}

export function isShopeeSellerUrl(raw: string): boolean {
  try { const url = new URL(raw); return url.protocol === "https:" && url.hostname === "seller.shopee.co.th"; } catch { return false; }
}
