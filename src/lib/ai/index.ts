import type { LLMProvider } from "./types";
import { MockLLMProvider } from "./mock-provider";
import { OpenAIProvider } from "./openai-provider";
import { GeminiProvider } from "./gemini-provider";

export type { LLMProvider, GenerateObjectParams } from "./types";

let cached: LLMProvider | undefined;

export function getLLMProvider(): LLMProvider {
  if (cached) return cached;

  const provider = process.env.LLM_PROVIDER ?? "mock";

  switch (provider) {
    case "openai":
      cached = new OpenAIProvider();
      break;
    case "gemini":
      cached = new GeminiProvider();
      break;
    case "mock":
      cached = new MockLLMProvider();
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }

  return cached;
}
