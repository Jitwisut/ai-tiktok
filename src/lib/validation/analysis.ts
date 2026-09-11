import { z } from "zod";

export const productAnalysisSchema = z.object({
  targetCustomer: z.string(),
  painPoints: z.array(z.string()).min(1).max(6),
  sellingPoints: z.array(z.string()).min(1).max(6),
  angles: z.array(z.string()).min(1).max(6),
});

export type ProductAnalysisResult = z.infer<typeof productAnalysisSchema>;
