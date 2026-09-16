import { z } from "zod";

const veoDurations = [4, 6, 8] as const;

const onScreenTextSchema = z
  .string()
  .trim()
  .max(24, "On-screen text must be 24 characters or fewer")
  .optional();

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
  /** Exact Thai text to show; the final prompt wraps it in standard quotes. */
  onScreenText: onScreenTextSchema,
  onScreenCta: onScreenTextSchema,
});

export type VideoSettings = z.infer<typeof videoSettingsSchema>;

export interface ScenePromptInput {
  position: number;
  duration: number;
  description: string;
  /** English visual direction for the video model. */
  visual?: string | null;
  /** Camera movement that continues from the previous beat. */
  cameraMotion?: string | null;
  /** The render clip this scene belongs to, zero-based. */
  clip?: number | null;
  /** Exact Thai line spoken by the visible person. */
  dialogue?: string | null;
  /** Exact Thai line spoken by an off-screen narrator. */
  voiceover?: string | null;
}
