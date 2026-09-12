import { z } from "zod";

const veoDurations = [4, 6, 8] as const;

export const videoSettingsSchema = z.object({
  duration: z.coerce
    .number()
    .int()
    .refine((value) => veoDurations.includes(value as (typeof veoDurations)[number]), {
      message: "Veo supports video durations of 4, 6, or 8 seconds",
    })
    .default(8),
  aspectRatio: z.enum(["9:16", "16:9"]).default("9:16"),
  style: z.string().default("UGC"),
  camera: z.string().default("handheld smartphone"),
  lighting: z.string().default("natural daylight"),
  language: z.string().default("Thai"),
});

export type VideoSettings = z.infer<typeof videoSettingsSchema>;

export interface ScenePromptInput {
  position: number;
  duration: number;
  description: string;
}
