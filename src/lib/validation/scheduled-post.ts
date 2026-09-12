import { z } from "zod";
import { SUPPORTED_PLATFORMS } from "@/lib/publishers";

export const createScheduledPostSchema = z.object({
  videoId: z.string(),
  platform: z.enum(SUPPORTED_PLATFORMS),
  scheduledAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
    message: "เวลาที่ตั้งต้องอยู่ในอนาคต",
  }),
  // "extension" posts are driven by the browser extension against the
  // platform's own uploader instead of going through the queue's Publisher.
  method: z.enum(["api", "extension"]).default("api"),
});

export type CreateScheduledPostInput = z.infer<typeof createScheduledPostSchema>;
