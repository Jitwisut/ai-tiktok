import { z } from "zod";

export const sceneSchema = z.object({
  duration: z.number().int().min(1).max(15),
  description: z.string(),
});

export const scenePlanResultSchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(8),
});

export type ScenePlanResult = z.infer<typeof scenePlanResultSchema>;

export const planScenesInputSchema = z.object({
  targetDuration: z.coerce.number().int().min(4).max(60).default(8),
});
