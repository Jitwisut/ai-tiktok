import { z } from "zod";
import { SUPPORTED_PLATFORMS } from "@/lib/publishers";

export const createScheduledPostSchema = z.object({
  videoId: z.string(),
  platform: z.enum(SUPPORTED_PLATFORMS),
  scheduledAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
    message: "เวลาที่ตั้งต้องอยู่ในอนาคต",
  }),
});

export type CreateScheduledPostInput = z.infer<typeof createScheduledPostSchema>;
