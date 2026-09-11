import { z } from "zod";

export const CONTENT_STYLES = [
  "UGC",
  "Review",
  "Problem Solution",
  "Storytelling",
  "Before After",
  "Unboxing",
  "Demo",
] as const;

export const contentStyleSchema = z.enum(CONTENT_STYLES);

export const generateContentSchema = z.object({
  productId: z.string(),
  style: contentStyleSchema,
});

export const contentGenerationResultSchema = z.object({
  hook: z.string(),
  script: z.string(),
  caption: z.string(),
  cta: z.string(),
});

export type ContentGenerationResult = z.infer<typeof contentGenerationResultSchema>;

export const updateContentSchema = z.object({
  hook: z.string().min(1).optional(),
  script: z.string().min(1).optional(),
  caption: z.string().min(1).optional(),
  cta: z.string().min(1).optional(),
});

export type UpdateContentInput = z.infer<typeof updateContentSchema>;
