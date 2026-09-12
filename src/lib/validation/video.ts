import { z } from "zod";
import { videoSettingsSchema } from "@/lib/prompt-engine/types";

export const createVideoSchema = z.object({
  contentId: z.string(),
  settings: videoSettingsSchema.partial().optional(),
  // Longer than one Veo render (8s) means several clips joined together.
  targetDuration: z
    .union([z.literal(8), z.literal(16), z.literal(24), z.literal(32)])
    .optional(),
});
