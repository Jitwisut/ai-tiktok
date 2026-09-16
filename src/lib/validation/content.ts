import { z } from "zod";
import { CONTENT_STYLES } from "@/lib/prompt-engine/style-playbooks";

export { CONTENT_STYLES } from "@/lib/prompt-engine/style-playbooks";

export const contentStyleSchema = z.enum(CONTENT_STYLES);

export const ON_SCREEN_HEADLINE_MAX = 12;
export const ON_SCREEN_CTA_MAX = 10;

export const generateContentSchema = z.object({
  productId: z.string(),
  style: contentStyleSchema,
  targetDuration: z
    .union([z.literal(8), z.literal(16), z.literal(24), z.literal(32)])
    .default(24),
});

export const contentGenerationResultSchema = z.object({
  hook: z.string(),
  script: z.string(),
  caption: z.string(),
  cta: z.string(),
  /** Short Thai strings that the video prompt must copy exactly on screen. */
  onScreenText: z.string().max(ON_SCREEN_HEADLINE_MAX),
  onScreenCta: z.string().max(ON_SCREEN_CTA_MAX),
});

export type ContentGenerationResult = z.infer<typeof contentGenerationResultSchema>;

export const updateContentSchema = z.object({
  hook: z.string().min(1).optional(),
  script: z.string().min(1).optional(),
  caption: z.string().min(1).optional(),
  cta: z.string().min(1).optional(),
  onScreenText: z.string().max(ON_SCREEN_HEADLINE_MAX).optional(),
  onScreenCta: z.string().max(ON_SCREEN_CTA_MAX).optional(),
});

export type UpdateContentInput = z.infer<typeof updateContentSchema>;
