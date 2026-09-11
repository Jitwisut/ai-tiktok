import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { GenerateObjectParams, LLMProvider } from "./types";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  async generateObject<T>({ system, prompt, schema }: GenerateObjectParams<T>): Promise<T> {
    const completion = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: prompt },
      ],
      response_format: zodResponseFormat(schema, "result"),
    });

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error("OpenAI ไม่ได้ส่งผลลัพธ์แบบมีโครงสร้างกลับมา");
    }

    return schema.parse(parsed);
  }
}
