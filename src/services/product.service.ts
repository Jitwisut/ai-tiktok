import { prisma } from "@/lib/db/prisma";
import type { CreateProductInput, UpdateProductInput } from "@/lib/validation/product";
import { UrlImporter } from "@/lib/importers/url-importer";
import { storage } from "@/lib/storage/local-storage";

export function createProduct(
  userId: string,
  input: CreateProductInput & { source?: string; images?: string[] },
) {
  return prisma.product.create({
    data: {
      userId,
      name: input.name,
      sourceUrl: input.sourceUrl || undefined,
      description: input.description,
      price: input.price,
      currency: input.currency,
      source: input.source ?? "manual",
      images: input.images?.length
        ? { create: input.images.map((url, position) => ({ url, position })) }
        : undefined,
    },
    include: { images: true },
  });
}

export function listProducts(userId: string) {
  return prisma.product.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { images: { orderBy: { position: "asc" }, take: 1 } },
  });
}

export function getProduct(userId: string, productId: string) {
  return prisma.product.findFirst({
    where: { id: productId, userId },
    include: { images: { orderBy: { position: "asc" } } },
  });
}

export async function updateProduct(
  userId: string,
  productId: string,
  input: UpdateProductInput,
) {
  const { count } = await prisma.product.updateMany({
    where: { id: productId, userId },
    data: input,
  });
  return count > 0;
}

export async function deleteProduct(userId: string, productId: string) {
  const { count } = await prisma.product.deleteMany({
    where: { id: productId, userId },
  });
  return count > 0;
}

export async function deleteProducts(userId: string, productIds: string[]) {
  const { count } = await prisma.product.deleteMany({
    where: { id: { in: productIds }, userId },
  });
  return count;
}

export async function addProductImage(
  userId: string,
  productId: string,
  file: File,
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, userId },
    select: { id: true },
  });
  if (!product) return null;

  const { url } = await storage.upload(file, `products/${productId}`);
  const lastImage = await prisma.productImage.findFirst({
    where: { productId },
    orderBy: { position: "desc" },
  });

  return prisma.productImage.create({
    data: { productId, url, position: (lastImage?.position ?? -1) + 1 },
  });
}

export async function deleteProductImage(
  userId: string,
  productId: string,
  imageId: string,
) {
  const { count } = await prisma.productImage.deleteMany({
    where: { id: imageId, productId, product: { userId } },
  });
  return count > 0;
}

export async function importTikTokProducts(
  userId: string,
  products: { tiktokId: string; name: string; price?: number; image?: string }[],
) {
  const results = [];
  for (const item of products) {
    const sourceUrl = `https://www.tiktok.com/tiktokstudio/product/${item.tiktokId}`;
    const existing = await prisma.product.findFirst({
      where: { userId, sourceUrl },
      include: { images: { orderBy: { position: "asc" }, take: 1 } },
    });
    if (existing) {
      results.push(existing);
      continue;
    }

    results.push(
      await createProduct(userId, {
        name: item.name,
        sourceUrl,
        price: item.price,
        currency: "THB",
        source: "tiktok",
        images: item.image ? [item.image] : undefined,
      }),
    );
  }
  return results;
}

export async function importProductFromUrl(userId: string, url: string) {
  const importer = new UrlImporter();
  const data = await importer.import(url);

  return createProduct(userId, {
    name: data.name,
    sourceUrl: data.sourceUrl,
    description: data.description,
    price: data.price,
    currency: data.currency,
    source: "url",
    images: data.images,
  });
}
