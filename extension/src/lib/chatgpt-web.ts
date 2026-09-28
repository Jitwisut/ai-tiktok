/** Run the same structured text prompts in a dedicated signed-in ChatGPT tab. */

import { keepWorkerAlive, type GenerateObjectParams } from "./gemini.js";
import { buildRepairPrompt, buildWebPrompt, parseReply } from "./gemini-web.js";

const CHATGPT_URL = "https://chatgpt.com/";
const TEXT_TAB_KEY = "chatgptTextTabId";
const SESSION_KEY = "chatgptTextSession";
const SESSION_MAX_AGE_MS = 60 * 60_000;
const PAGE_LOAD_TIMEOUT_MS = 45_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;

interface TextPromptResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface ChatSession {
  productId: string;
  url: string;
  startedAt: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let queue: Promise<unknown> = Promise.resolve();

export function generateObjectOnChatGPT<T>(params: GenerateObjectParams, productId: string): Promise<T> {
  const run = queue.then(() => keepWorkerAlive(() => askChatGPT<T>(params, productId)));
  queue = run.catch(() => {});
  return run;
}

async function askChatGPT<T>(params: GenerateObjectParams, productId: string): Promise<T> {
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tabId: number | undefined;
  try {
    tabId = await openChat(productId);
    const first = await sendPrompt(tabId, buildWebPrompt(params, { multiline: true }), params.images ?? []);
    await rememberChat(tabId, productId);
    try {
      return parseReply<T>(first, params.schema, "ChatGPT");
    } catch (err) {
      const retry = await sendPrompt(tabId, buildRepairPrompt(params, (err as Error).message, { multiline: true }), []);
      await rememberChat(tabId, productId);
      return parseReply<T>(retry, params.schema, "ChatGPT");
    }
  } finally {
    if (previous?.id && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

async function openChat(productId: string): Promise<number> {
  const saved = await chrome.storage.local.get([TEXT_TAB_KEY, SESSION_KEY]);
  const stored = saved[TEXT_TAB_KEY] as number | undefined;
  const session = saved[SESSION_KEY] as ChatSession | undefined;
  const existing = stored ? await chrome.tabs.get(stored).catch(() => undefined) : undefined;
  const reuse = !!(existing?.id && existing.url?.startsWith(CHATGPT_URL) &&
    session?.productId === productId &&
    Date.now() - session.startedAt < SESSION_MAX_AGE_MS &&
    (session.url === existing.url || session.url === CHATGPT_URL));
  let tabId: number;
  if (existing?.id && existing.url?.startsWith(CHATGPT_URL)) {
    tabId = existing.id;
    await chrome.tabs.update(tabId, reuse ? { active: true } : { url: CHATGPT_URL, active: true });
  } else {
    const created = await chrome.tabs.create({ url: CHATGPT_URL, active: true });
    tabId = created.id!;
  }
  if (!reuse) {
    await chrome.storage.local.set({ [SESSION_KEY]: { productId, url: CHATGPT_URL, startedAt: Date.now() } satisfies ChatSession });
  }
  await chrome.storage.local.set({ [TEXT_TAB_KEY]: tabId });
  await sleep(1500);
  const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new Error("แท็บ ChatGPT ถูกปิดระหว่างทำงาน");
    if (tab.status === "complete") return tabId;
    await sleep(500);
  }
  throw new Error("เปิดหน้า ChatGPT ไม่ขึ้นภายในเวลาที่กำหนด — ตรวจอินเทอร์เน็ตหรือการล็อกอิน");
}

async function rememberChat(tabId: number, productId: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url?.startsWith(CHATGPT_URL)) return;
  const saved = await chrome.storage.local.get(SESSION_KEY);
  const session = saved[SESSION_KEY] as ChatSession | undefined;
  if (session?.productId === productId) {
    await chrome.storage.local.set({ [SESSION_KEY]: { ...session, url: tab.url } satisfies ChatSession });
  }
}

async function sendPrompt(tabId: number, prompt: string, images: GenerateObjectParams["images"]): Promise<string> {
  const message = { type: "RUN_CHATGPT_TEXT_PROMPT", prompt, images };
  let result: TextPromptResult | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await withTimeout(chrome.tabs.sendMessage(tabId, message) as Promise<TextPromptResult>, REPLY_TIMEOUT_MS);
      break;
    } catch (err) {
      const notReady = /Receiving end does not exist|Could not establish connection/i.test(String(err));
      if (!notReady || attempt >= 10) throw new Error(`คุยกับหน้า ChatGPT ไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(1000);
    }
  }
  if (!result?.ok || !result.text) throw new Error(result?.error ?? "ChatGPT ไม่ได้ตอบกลับ");
  return result.text;
}

function withTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("รอคำตอบจาก ChatGPT นานเกินไป")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
