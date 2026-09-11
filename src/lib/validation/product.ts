import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().min(1, "กรุณากรอกชื่อสินค้า").max(200),
  sourceUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().max(2000).optional(),
  price: z.coerce.number().positive().optional(),
  currency: z.string().max(10).optional(),
  source: z.enum(["manual", "extension", "url"]).optional(),
  images: z.array(z.string().url()).max(5).optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  price: z.coerce.number().positive().optional(),
  currency: z.string().max(10).optional(),
  category: z.string().max(100).optional(),
  sellerName: z.string().max(200).optional(),
});

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const importProductSchema = z.object({
  url: z.string().url(),
});
