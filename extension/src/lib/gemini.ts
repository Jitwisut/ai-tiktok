/** Ported from src/lib/ai/gemini-provider.ts as a plain REST call — no @google/genai SDK, since the extension build is bare tsc with no bundler. */

import { getSettings, getApiKeyState, pickAvailableKey, markKeyCooldown } from "./store.js";

export interface ImagePart {
  base64: string;
  mimeType: string;
}

/** Hand-written OpenAPI-style JSON Schema — Gemini's responseSchema field, not a zod schema. */
export type JsonSchema = Record<string, unknown>;

export interface GenerateObjectParams {
  system: string;
  prompt: string;
  images?: ImagePart[];
  schema: JsonSchema;
}

export class GeminiError extends Error {
  status?: number;
  /** Parsed from the response's RetryInfo detail, when Google sends one. */
  retryDelayMs?: number;
}

/** No RetryInfo in the 429 body usually means the daily quota, not the per-minute one — bench the key for a while rather than hammering it again immediately. */
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function fetchImageAsBase64(imageUrl: string): Promise<ImagePart | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return { base64: btoa(binary), mimeType };
  } catch {
    return null;
  }
}

export async function loadImages(urls: string[]): Promise<ImagePart[]> {
  const loaded = await Promise.all(urls.map(fetchImageAsBase64));
  return loaded.filter((image): image is ImagePart => image !== null);
}

/**
 * Gemini returns 503 "experiencing high demand" often enough that a single
 * attempt regularly loses a user's action. 429 (rate limit) is deliberately
 * NOT retried here — that's the caller's job, by switching to a different
 * API key instead of waiting on this one.
 */
async function withRetry<R>(call: () => Promise<R>): Promise<R> {
  const delaysMs = [1000, 3000, 8000, 15000, 30000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = (err as GeminiError)?.status;
      const retriable = status === 503 || status === 500;
      if (!retriable || attempt >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

function parseRetryDelayMs(body: any): number | undefined {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return undefined;
  const retryInfo = details.find((d) => typeof d?.["@type"] === "string" && d["@type"].includes("RetryInfo"));
  const match = /^([\d.]+)s$/.exec(String(retryInfo?.retryDelay ?? ""));
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

async function callGeminiOnce(model: string, apiKey: string, params: GenerateObjectParams): Promise<unknown> {
  const parts = [
    ...(params.images ?? []).map((image) => ({
      inlineData: { data: image.base64, mimeType: image.mimeType },
    })),
    { text: params.prompt },
  ];

  return withRetry(async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: params.system }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: params.schema,
          },
        }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new GeminiError(body?.error?.message ?? `Gemini error (${res.status})`);
      err.status = res.status;
      err.retryDelayMs = parseRetryDelayMs(body);
      throw err;
    }
    return res.json();
  });
}

/**
 * Rotates across every configured Gemini API key (round-robin, skipping any
 * on cooldown) so several free-tier accounts effectively pool their quota.
 * A 429 benches that key — for its reported RetryInfo delay if Google sent
 * one, otherwise for a full day, since an un-timed 429 is almost always the
 * daily cap, not the per-minute one — and moves on to the next key. Any
 * other error is not a quota problem, so it's thrown immediately instead of
 * burning through the rest of the keys.
 */
export async function generateObject<T>(params: GenerateObjectParams): Promise<T> {
  const { geminiModel } = await getSettings();
  const model = geminiModel || "gemini-flash-latest";

  const keyCount = (await getApiKeyState()).keys.length;
  if (keyCount === 0) {
    throw new Error("ยังไม่ได้ตั้งค่า Gemini API Key ในหน้า Settings");
  }

  let lastError: Error = new Error("Gemini API key ทุกตัวติด rate limit — รอโควต้ารีเซ็ตหรือเพิ่ม key ใหม่");

  for (let attempt = 0; attempt < keyCount; attempt++) {
    const apiKey = await pickAvailableKey();
    if (!apiKey) break; // every key is on cooldown

    try {
      const response = await callGeminiOnce(model, apiKey, params);
      const text: string | undefined = (response as any)?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini ไม่ได้ส่งผลลัพธ์กลับมา");
      return JSON.parse(text) as T;
    } catch (err) {
      const status = (err as GeminiError)?.status;
      if (status === 429) {
        const cooldownMs = (err as GeminiError).retryDelayMs ?? DEFAULT_COOLDOWN_MS;
        await markKeyCooldown(apiKey, Date.now() + cooldownMs);
        lastError = err as Error;
        continue; // try the next key
      }
      throw err; // not a quota problem — rotating keys won't help
    }
  }

  throw lastError;
}
