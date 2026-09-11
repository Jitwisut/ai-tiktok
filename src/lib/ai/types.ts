import type { z } from "zod";

export interface GenerateObjectParams<T> {
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Returned verbatim (after schema validation) when LLM_PROVIDER=mock. */
  mock: T;
}

export interface LLMProvider {
  generateObject<T>(params: GenerateObjectParams<T>): Promise<T>;
}
