import { z } from "zod";

export const createCheckoutSchema = z.object({
  packageId: z.string(),
});
