import type { GenerateObjectParams, LLMProvider } from "./types";

/** Returns caller-supplied fixture data, still validated against the schema. */
export class MockLLMProvider implements LLMProvider {
  async generateObject<T>({ schema, mock }: GenerateObjectParams<T>): Promise<T> {
    return schema.parse(mock);
  }
}
