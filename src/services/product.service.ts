import { prisma } from "@/lib/db/prisma";
import type { CreateProductInput } from "@/lib/validation/product";

export function createProduct(userId: string, input: CreateProductInput) {
  return prisma.product.create({
    data: {
      userId,
      name: input.name,
      sourceUrl: input.sourceUrl || undefined,
      description: input.description,
      price: input.price,
      currency: input.currency,
      source: "manual",
    },
  });
}

export function listProducts(userId: string) {
  return prisma.product.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}
