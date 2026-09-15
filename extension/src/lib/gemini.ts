/** Ported from src/lib/ai/gemini-provider.ts as a plain REST call — no @google/genai SDK, since the extension build is bare tsc with no bundler. */

import { getSettings, getApiKeyState, pickAvailableKey, markKeyCooldown, recordKeyError, maskKey } from "./store.js";

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

/** A key whose project is denied or whose key is invalid won't recover on its own; bench it until the user resets it. */
const BROKEN_KEY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Failures that belong to one key rather than the request: a denied or
 * suspended project (403 "Your project has been denied access"), or a key
 * that is invalid, expired or has the API disabled (400/403 naming the key).
 */
function isBrokenKeyError(err: GeminiError): boolean {
  if (err.status === 403) return true;
  return err.status === 400 && /api key|API_KEY/i.test(err.message);
}

/**
 * `fetch()` here has no built-in timeout, and an MV3 service worker can be
 * killed mid-request (idle timer, or Chrome reclaiming it) without the
 * pending `await` ever resolving or rejecting — the call just hangs
 * forever with no error, which is what stalled autopilot at "วิเคราะห์สินค้า"
 * with no error logged. An AbortController turns that into an error the
 * caller (autopilot's retry/skip logic) can actually react to.
 */
const GEMINI_FETCH_TIMEOUT_MS = 90_000;

/**
 * Chrome also shuts the worker down when a fetch() response takes more than
 * 30 seconds, or after 30 seconds with no events or extension API calls —
 * which a thinking model writing a script, or withRetry's 15–30s back-off,
 * easily hits. The worker dies silently, the step never finishes, and
 * autopilot only retries once its lease runs out (minutes later, from
 * scratch). A cheap extension API call every 20 seconds resets that idle timer
 * for as long as the Gemini call is in flight.
 */
export async function keepWorkerAlive<R>(work: () => Promise<R>): Promise<R> {
  const ping = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  try {
    return await work();
  } finally {
    clearInterval(ping);
  }
}

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
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
          signal: controller.signal,
        },
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new GeminiError(`Gemini ไม่ตอบสนองภายใน ${GEMINI_FETCH_TIMEOUT_MS / 1000} วินาที — เครือข่ายอาจมีปัญหา ลองใหม่อีกครั้ง`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

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
 * daily cap, not the per-minute one — and moves on to the next key. A key
 * that is broken (denied project, invalid key) is benched until reset and
 * recorded, so the settings tab can show which one it is. Any other error is
 * not about the key, so it's thrown immediately — with the key it was using
 * named in the message.
 */
export function generateObject<T>(params: GenerateObjectParams): Promise<T> {
  return keepWorkerAlive(() => generateObjectOnKeys<T>(params));
}

async function generateObjectOnKeys<T>(params: GenerateObjectParams): Promise<T> {
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
      await recordKeyError(apiKey, null);
      return JSON.parse(text) as T;
    } catch (err) {
      const geminiErr = err as GeminiError;
      const tagged = new GeminiError(`${geminiErr?.message ?? String(err)} [key ${maskKey(apiKey)}]`);
      tagged.status = geminiErr?.status;
      tagged.retryDelayMs = geminiErr?.retryDelayMs;

      if (geminiErr?.status === 429) {
        const cooldownMs = geminiErr.retryDelayMs ?? DEFAULT_COOLDOWN_MS;
        await markKeyCooldown(apiKey, Date.now() + cooldownMs);
        lastError = tagged;
        continue; // try the next key
      }
      if (geminiErr instanceof GeminiError && isBrokenKeyError(geminiErr)) {
        await recordKeyError(apiKey, { status: geminiErr.status, message: geminiErr.message, at: Date.now() });
        await markKeyCooldown(apiKey, Date.now() + BROKEN_KEY_COOLDOWN_MS);
        lastError = tagged;
        continue; // this key is dead — the others may still work
      }
      throw tagged; // not a key problem — rotating keys won't help
    }
  }

  throw lastError;
}

/** One tiny request with a specific key — for the settings tab's "ทดสอบ" button. */
export async function testApiKey(apiKey: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { geminiModel } = await getSettings();
  const model = geminiModel || "gemini-flash-latest";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 8 } }),
      signal: controller.signal,
    });
    if (res.ok) {
      await recordKeyError(apiKey, null);
      return { ok: true, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    const message: string = body?.error?.message ?? `Gemini error (${res.status})`;
    if (res.status !== 429) await recordKeyError(apiKey, { status: res.status, message, at: Date.now() });
    return { ok: false, status: res.status, error: message };
  } catch (err) {
    return { ok: false, error: (err as Error)?.name === "AbortError" ? "หมดเวลา" : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
