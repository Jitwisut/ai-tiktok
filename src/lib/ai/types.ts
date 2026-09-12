import type { z } from "zod";

export interface LLMImage {
  /** Raw image bytes, base64-encoded (no data: prefix). */
  base64: string;
  mimeType: string;
}

export interface GenerateObjectParams<T> {
  system?: string;
  prompt: string;
  /** Product photos to reason about, not just the text describing them. */
  images?: LLMImage[];
  schema: z.ZodType<T>;
  /** Returned verbatim (after schema validation) when LLM_PROVIDER=mock. */
  mock: T;
}

export interface LLMProvider {
  generateObject<T>(params: GenerateObjectParams<T>): Promise<T>;
}
