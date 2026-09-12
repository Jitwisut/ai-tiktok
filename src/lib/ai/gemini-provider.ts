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
    this.model = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
  }

  async generateObject<T>({ system, prompt, images, schema }: GenerateObjectParams<T>): Promise<T> {
    const parts = [
      ...(images ?? []).map((image) => ({
        inlineData: { data: image.base64, mimeType: image.mimeType },
      })),
      { text: prompt },
    ];

    const response = await this.withRetry(() =>
      this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseSchema: z.toJSONSchema(schema),
        },
      }),
    );

    const text = response.text;
    if (!text) {
      throw new Error("Gemini ไม่ได้ส่งผลลัพธ์กลับมา");
    }

    return schema.parse(JSON.parse(text));
  }

  /**
   * Gemini returns 503 "experiencing high demand" often enough that a single
   * attempt regularly loses a user's action. Overload and rate limiting are
   * both worth waiting out; anything else is a real error and rethrown.
   */
  private async withRetry<R>(call: () => Promise<R>): Promise<R> {
    const delaysMs = [1000, 3000, 8000, 15000, 30000, 45000];

    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const retriable = status === 429 || status === 503 || status === 500;
        if (!retriable || attempt >= delaysMs.length) throw err;

        // Rate-limit responses say how long to wait; prefer that over guessing.
        const asked = /retry in ([\d.]+)s/i.exec(String((err as Error)?.message ?? ""));
        const askedMs = asked ? Math.ceil(Number(asked[1]) * 1000) : 0;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(delaysMs[attempt], askedMs)),
        );
      }
    }
  }
}
