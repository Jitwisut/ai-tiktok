/**
 * The same generateObject contract as gemini.ts, answered by the Gemini web
 * app (gemini.google.com/app) in the user's signed-in browser instead of an
 * API key. The worker opens a fresh chat in its own tab, the content script
 * (gemini-automation.ts, RUN_TEXT_PROMPT) types the prompt and reads the
 * reply, and the JSON is parsed and checked here — the web app has no
 * responseSchema, so nothing else guarantees the shape.
 */

import { keepWorkerAlive, type GenerateObjectParams, type JsonSchema } from "./gemini.js";

const GEMINI_APP_URL = "https://gemini.google.com/app?hl=th";
/** The tab this module drives — never the /videos tab a Gemini video job runs in. */
const TEXT_TAB_KEY = "geminiTextTabId";
const PAGE_LOAD_TIMEOUT_MS = 45_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;

interface TextPromptResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One chat at a time: the prompts share a tab, and each call starts a new chat in it.
let queue: Promise<unknown> = Promise.resolve();

export function generateObjectOnWeb<T>(params: GenerateObjectParams): Promise<T> {
  const run = queue.then(() => keepWorkerAlive(() => askGemini<T>(params)));
  queue = run.catch(() => {});
  return run;
}

async function askGemini<T>(params: GenerateObjectParams): Promise<T> {
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = await openFreshChat();
  try {
    const first = await sendPrompt(tabId, { prompt: buildWebPrompt(params), images: params.images ?? [], newChat: true });
    try {
      return parseReply<T>(first, params.schema);
    } catch (err) {
      // Ask again from scratch, not as a follow-up: a short "fix your JSON"
      // in the same chat was answered as if the question and schema had
      // never been sent. A fresh chat with the whole prompt always has them.
      const retryTabId = await openFreshChat();
      const retry = await sendPrompt(retryTabId, {
        prompt: `${buildWebPrompt(params)} • หมายเหตุ: ครั้งก่อนตอบมาใช้ไม่ได้ (${(err as Error).message}) — เขียน JSON ครั้งเดียวให้จบ ห้ามเริ่มเขียนใหม่กลางคำตอบ`,
        images: params.images ?? [],
        newChat: true,
      });
      return parseReply<T>(retry, params.schema);
    }
  } finally {
    // Give the user back the tab they were on (the side panel, Flow, …).
    if (previous?.id && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

/**
 * The composer turns typed newlines into lost text or stray blank lines, so
 * the prompt goes in as one line with its rules separated by " • ".
 */
function buildWebPrompt(params: GenerateObjectParams): string {
  return [
    params.system,
    params.prompt,
    `รูปแบบคำตอบ: ตอบเป็น JSON ก้อนเดียวในบล็อกโค้ด \`\`\`json เท่านั้น ห้ามมีคำอธิบายหรือข้อความอื่นก่อนหรือหลัง ใช้ชื่อฟิลด์ภาษาอังกฤษตรงตาม JSON Schema นี้ และใส่ครบทุกฟิลด์ที่ required: ${JSON.stringify(params.schema)}`,
  ]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" • ");
}

async function openFreshChat(): Promise<number> {
  const stored = (await chrome.storage.local.get(TEXT_TAB_KEY))[TEXT_TAB_KEY] as number | undefined;
  const existing = stored ? await chrome.tabs.get(stored).catch(() => undefined) : undefined;

  let tabId: number;
  if (existing?.id && existing.url?.startsWith("https://gemini.google.com/")) {
    tabId = existing.id;
    // Active while it works: a hidden tab's timers are throttled and its send button may not respond.
    await chrome.tabs.update(tabId, { url: GEMINI_APP_URL, active: true });
  } else {
    const created = await chrome.tabs.create({ url: GEMINI_APP_URL, active: true });
    tabId = created.id!;
    await chrome.storage.local.set({ [TEXT_TAB_KEY]: tabId });
  }
  await waitForLoad(tabId);
  return tabId;
}

async function waitForLoad(tabId: number) {
  const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
  // The tab still reports the old page as complete right after update(), so let navigation begin first.
  await sleep(1500);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new Error("แท็บ Gemini ถูกปิดระหว่างทำงาน");
    if (tab.status === "complete") return;
    await sleep(500);
  }
  throw new Error("เปิดหน้า Gemini ไม่ขึ้นภายในเวลาที่กำหนด — เช็คอินเทอร์เน็ตหรือการล็อกอิน Gemini");
}

async function sendPrompt(
  tabId: number,
  request: { prompt: string; images: GenerateObjectParams["images"]; newChat: boolean },
): Promise<string> {
  const message = { type: "RUN_TEXT_PROMPT", ...request };
  // The content script registers at document_idle, a moment after the load completes.
  let result: TextPromptResult | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await withTimeout(chrome.tabs.sendMessage(tabId, message) as Promise<TextPromptResult>, REPLY_TIMEOUT_MS);
      break;
    } catch (err) {
      const notReady = /Receiving end does not exist|Could not establish connection/i.test(String(err));
      if (!notReady || attempt >= 10) throw new Error(`คุยกับหน้า Gemini ไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(1000);
    }
  }
  if (!result?.ok || !result.text) throw new Error(result?.error ?? "Gemini ไม่ได้ตอบกลับ");
  return result.text;
}

function withTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("รอคำตอบจาก Gemini นานเกินไป")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function parseReply<T>(text: string, schema: JsonSchema): T {
  const candidates = jsonCandidates(text);
  if (candidates.length === 0) throw new Error(`Gemini ไม่ได้ตอบเป็น JSON: "${text.slice(0, 120)}"`);
  let lastError: Error | undefined;
  for (const value of candidates) {
    try {
      return conform(value, schema, "") as T;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("JSON ที่ Gemini ตอบมาอ่านไม่ได้");
}

/**
 * Every complete JSON object in the reply, newest first. Gemini sometimes
 * stops partway through and starts the answer again inside the same code
 * block ("…"clip": 0,```json { …"), so the text as a whole never parses but
 * the restarted copy does. Tries each "{" that opens a line (or follows a
 * fence) up to the last "}", and forgives trailing commas.
 */
function jsonCandidates(text: string): unknown[] {
  const end = text.lastIndexOf("}");
  if (end < 0) return [];
  const starts: number[] = [];
  for (let i = 0; i < end; i++) {
    if (text[i] !== "{") continue;
    const before = text.slice(Math.max(0, i - 8), i);
    if (i === 0 || /(^|\n)[ \t]*$/.test(before) || /```(json)?\s*$/i.test(before)) starts.push(i);
  }
  const found: unknown[] = [];
  for (const start of starts.reverse()) {
    for (const body of [text.slice(start, end + 1), text.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1")]) {
      try {
        found.push(JSON.parse(body));
        break;
      } catch {
        // not a complete object from here
      }
    }
  }
  return found;
}

/**
 * Checks the reply against the schema the API would have enforced: required
 * fields present, arrays and objects where expected. Numbers written as
 * strings ("3") are converted, since the web app often quotes them.
 */
function conform(value: unknown, schema: JsonSchema, path: string): unknown {
  const type = schema.type as string | undefined;
  const where = path || "คำตอบ";
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} ต้องเป็น object`);
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (record[key] === undefined || record[key] === null) throw new Error(`ขาดฟิลด์ ${path ? `${path}.` : ""}${key}`);
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (record[key] !== undefined && record[key] !== null) record[key] = conform(record[key], sub, path ? `${path}.${key}` : key);
    }
    return record;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${where} ต้องเป็น array`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${where} มีน้อยกว่า ${schema.minItems} รายการ`);
    const items = schema.items as JsonSchema | undefined;
    return items ? value.map((item, i) => conform(item, items, `${path}[${i}]`)) : value;
  }
  if (type === "integer" || type === "number") {
    const n = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${where} ต้องเป็นตัวเลข`);
    return type === "integer" ? Math.round(n) : n;
  }
  if (type === "string") return typeof value === "string" ? value : String(value);
  return value;
}
