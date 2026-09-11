import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { GenerateObjectParams, LLMProvider } from "./types";

export class GeminiProvider implements LLMProvider {
  private client: GoogleGenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.client = new GoogleGenAI({ apiKey });
    this.model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  }

  async generateObject<T>({ system, prompt, schema }: GenerateObjectParams<T>): Promise<T> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseSchema: z.toJSONSchema(schema),
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error("Gemini ไม่ได้ส่งผลลัพธ์กลับมา");
    }

    return schema.parse(JSON.parse(text));
  }
}
