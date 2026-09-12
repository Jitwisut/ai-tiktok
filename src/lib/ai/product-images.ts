import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { safeFetch } from "@/lib/net/safe-fetch";
import type { LLMImage } from "./types";

const MAX_IMAGES = 3;
const MAX_BYTES = 4 * 1024 * 1024;
const PUBLIC_DIR = path.join(process.cwd(), "public");

const EXTENSION_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function loadOne(url: string): Promise<LLMImage | null> {
  try {
    if (url.startsWith("/")) {
      // Uploaded through the app, so it lives under public/.
      const filePath = path.join(PUBLIC_DIR, url);
      if (!filePath.startsWith(PUBLIC_DIR)) return null;
      const buffer = await readFile(filePath);
      if (buffer.byteLength > MAX_BYTES) return null;
      const mimeType = EXTENSION_MIME[path.extname(url).toLowerCase()];
      if (!mimeType) return null;
      return { base64: buffer.toString("base64"), mimeType };
    }

    // Imported from a product page, so the URL is attacker-influenced.
    const response = await safeFetch(url);
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!mimeType.startsWith("image/")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return null;
    return { base64: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

/**
 * The product photo is the only thing that says what the product actually is
 * — the scraped title and description are often thin or misleading — so the
 * analysis and storyboard stages look at it rather than guessing from text.
 */
export async function loadProductImages(productId: string): Promise<LLMImage[]> {
  const images = await prisma.productImage.findMany({
    where: { productId },
    orderBy: { position: "asc" },
    take: MAX_IMAGES,
  });

  const loaded = await Promise.all(images.map((image) => loadOne(image.url)));
  return loaded.filter((image): image is LLMImage => image !== null);
}
