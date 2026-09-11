import { z } from "zod";
import { videoSettingsSchema } from "@/lib/prompt-engine/types";

export const createVideoSchema = z.object({
  contentId: z.string(),
  settings: videoSettingsSchema.partial().optional(),
});
