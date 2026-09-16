import { z } from "zod";

export const sceneSchema = z.object({
  duration: z.number().int().min(1).max(15),
  description: z.string(),
  /** Optional richer storyboard fields; old scene plans remain valid. */
  visual: z.string().optional(),
  cameraMotion: z.string().optional(),
  clip: z.number().int().min(0).max(3).optional(),
  dialogue: z.string().optional(),
  voiceover: z.string().optional(),
});

export const scenePlanResultSchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(12),
});

export type ScenePlanResult = z.infer<typeof scenePlanResultSchema>;

export const planScenesInputSchema = z.object({
  targetDuration: z.coerce.number().int().min(4).max(60).default(8),
});
