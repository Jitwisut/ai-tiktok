import { z } from "zod";

export const videoSettingsSchema = z.object({
  duration: z.coerce.number().int().min(4).max(60).default(8),
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
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
