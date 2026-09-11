import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().min(1, "กรุณากรอกชื่อสินค้า").max(200),
  sourceUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().max(2000).optional(),
  price: z.coerce.number().positive().optional(),
  currency: z.string().max(10).optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
