import * as store from "./lib/store.js";
import * as gemini from "./lib/gemini.js";
import * as library from "./lib/library.js";
import * as prompts from "./lib/analysis-prompts.js";
import { DEFAULT_VIDEO_SETTINGS, CLIP_SECONDS, planClips, type PlanVariant } from "./lib/prompt-engine.js";
import { concatMp4 } from "./lib/mp4-concat.js";
import { createAutopilot } from "./lib/autopilot.js";

const VEO_MODEL_ID = "veo-3.1-fast-generate-preview";
const VEO_STUDIO_URL = `https://aistudio.google.com/prompts/new_video?model=${VEO_MODEL_ID}`;

type GenerationSite = "aistudio" | "flow";

/** Only a project page has the prompt box — Flow's home page has nothing to drive. */
const FLOW_PROJECT_URL = /^https:\/\/flow\.google\.com\/project\//;

async function siteTargetUrl(site: GenerationSite): Promise<string | null> {
  if (site === "aistudio") return VEO_STUDIO_URL;
  const { flowProjectUrl } = await store.getSettings();
  return FLOW_PROJECT_URL.test(flowProjectUrl) ? flowProjectUrl : null;
}

function siteMatchesTab(site: GenerationSite, url: string): boolean {
  return site === "aistudio" ? url.includes("aistudio.google.com") : FLOW_PROJECT_URL.test(url);
}

interface JobClip {
  index: number;
  prompt: string;
}

interface VideoJob {
  videoId: string;
  clips: JobClip[];
  duration: number;
  aspectRatio: string;
  modelId: string;
  imageBase64?: string;
  imageMimeType?: string;
}

interface IncomingVideoJob {
  videoId: string;
  clips: JobClip[];
  duration?: number;
  aspectRatio?: string;
  imageUrl?: string | null;
}

interface GetPendingJobsMessage {
  type: "GET_PENDING_JOBS";
}

interface GetContentsMessage {
  type: "GET_CONTENTS";
}

interface GetCompletedVideosMessage {
  type: "GET_COMPLETED_VIDEOS";
}

interface CreateJobMessage {
  type: "CREATE_JOB";
  contentId: string;
  targetDuration: number;
}

/** Creates `count` separate videos from one content and runs them one after another. */
interface RunBatchMessage {
  type: "RUN_BATCH";
  contentId: string;
  targetDuration: number;
  count: number;
  site: GenerationSite;
}

/** Opens TikTok Studio's upload page and has tiktok-upload.ts fill it for this video. */
interface PrepareTikTokPostMessage {
  type: "PREPARE_TIKTOK_POST";
  videoId: string;
  caption: string;
  autoPost: boolean;
  /** TikTok Shop product ID to link, or null to post without a product link. */
  productId: string | null;
}

/** Imports the logged-in TikTok account's showcase products into the product list. */
interface SyncTikTokShowcaseMessage {
  type: "SYNC_TIKTOK_SHOWCASE";
}

/** Joins an already finished video's clips into one file (for videos made before auto-join). */
interface MergeVideoMessage {
  type: "MERGE_VIDEO";
  videoId: string;
}

interface CancelJobMessage {
  type: "CANCEL_JOB";
  videoId: string;
}

interface RunJobFromPopupMessage {
  type: "RUN_JOB_FROM_POPUP";
  job: IncomingVideoJob;
  targetDuration?: number;
  site?: GenerationSite;
}

interface UploadVideoMessage {
  type: "UPLOAD_VIDEO";
  videoId: string;
  base64: string;
  mimeType: string;
  clipIndex?: number;
  clipTotal?: number;
}

/**
 * Flow serves its clips from a URL the page's CSP forbids the content script
 * from fetching, so the worker fetches it here instead — host_permissions
 * cover it and extension contexts are not bound by the page's CSP.
 */
interface FetchAndUploadMessage {
  type: "FETCH_AND_UPLOAD_VIDEO";
  videoId: string;
  url: string;
  clipIndex?: number;
  clipTotal?: number;
}

interface ScrapedTikTokProduct {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
}

interface ImportTikTokProductsMessage {
  type: "IMPORT_TIKTOK_PRODUCTS";
  products: ScrapedTikTokProduct[];
}

interface GetTikTokProductsMessage {
  type: "GET_TIKTOK_PRODUCTS";
}

interface DeleteTikTokProductsMessage {
  type: "DELETE_TIKTOK_PRODUCTS";
  ids: string[];
}

interface AddProductMessage {
  type: "ADD_PRODUCT";
  product: {
    url: string;
    name?: string;
    description?: string;
    price?: string;
    image?: string;
    images?: string[];
  };
}

/** Step 1 of the panel's review flow. */
interface AnalyzeProductMessage {
  type: "ANALYZE_PRODUCT";
  productId: string;
}

/** Step 2: generates Content + scenes, but stops short of creating a video job. */
interface GenerateContentScenesMessage {
  type: "GENERATE_CONTENT_SCENES";
  productId: string;
  style: string;
  targetDuration: number;
}

interface GetPendingVideoJobMessage {
  type: "GET_PENDING_VIDEO_JOB";
}

interface GetSettingsMessage {
  type: "GET_SETTINGS";
}

interface SaveSettingsMessage {
  type: "SAVE_SETTINGS";
  settings: Partial<store.Settings>;
}

interface GetApiKeysStatusMessage {
  type: "GET_API_KEYS_STATUS";
}

interface SaveApiKeysMessage {
  type: "SAVE_API_KEYS";
  keys: string[];
}

interface ResetKeyCooldownMessage {
  type: "RESET_KEY_COOLDOWN";
  key: string;
}

type ExtensionMessage =
  | AddProductMessage
  | GetPendingJobsMessage
  | GetContentsMessage
  | GetCompletedVideosMessage
  | CreateJobMessage
  | RunBatchMessage
  | PrepareTikTokPostMessage
  | SyncTikTokShowcaseMessage
  | MergeVideoMessage
  | CancelJobMessage
  | RunJobFromPopupMessage
  | UploadVideoMessage
  | FetchAndUploadMessage
  | ImportTikTokProductsMessage
  | GetTikTokProductsMessage
  | DeleteTikTokProductsMessage
  | AnalyzeProductMessage
  | GenerateContentScenesMessage
  | GetPendingVideoJobMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | GetApiKeysStatusMessage
  | SaveApiKeysMessage
  | ResetKeyCooldownMessage;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Asks the local planner to re-plan the job's clips when the panel picked a different length. */
async function replanClips(videoId: string, targetDuration: number): Promise<JobClip[] | null> {
  const video = await store.getVideo(videoId);
  if (!video) return null;
  const content = await store.getContent(video.contentId);
  if (!content) return null;
  const product = await store.getProduct(content.productId);

  const clips = planClips(
    product?.name ?? "-",
    prompts.toScenePromptInputs(content.scenes),
    DEFAULT_VIDEO_SETTINGS,
    targetDuration,
    undefined,
    { headline: content.onScreenText, cta: content.onScreenCta },
    content.style,
  );
  const mapped = clips.map((c) => ({ index: c.index, prompt: c.prompt }));
  await store.updateVideoJob(videoId, {
    clips: mapped,
    duration: clips.length * CLIP_SECONDS,
    targetDuration,
  });
  return mapped;
}

async function buildJob(incoming: IncomingVideoJob, targetDuration?: number): Promise<VideoJob> {
  const image = incoming.imageUrl ? await gemini.fetchImageAsBase64(incoming.imageUrl) : null;

  let clips = incoming.clips;
  if (targetDuration && targetDuration !== incoming.clips.length * CLIP_SECONDS) {
    clips = (await replanClips(incoming.videoId, targetDuration)) ?? clips;
  }

  return {
    videoId: incoming.videoId,
    clips,
    duration: incoming.duration ?? clips.length * CLIP_SECONDS,
    aspectRatio: incoming.aspectRatio ?? DEFAULT_VIDEO_SETTINGS.aspectRatio,
    modelId: VEO_MODEL_ID,
    imageBase64: image?.base64,
    imageMimeType: image?.mimeType,
  };
}

const SITE_TAB_PATTERNS: Record<GenerationSite, string> = {
  aistudio: "https://aistudio.google.com/*",
  flow: "https://flow.google.com/project/*",
};

const SITE_SCRIPTS: Record<GenerationSite, string[]> = {
  aistudio: ["dist/panel.js", "dist/ai-studio-automation.js"],
  flow: ["dist/panel.js", "dist/flow-automation.js"],
};

/**
 * The tab to drive: the focused tab if it is already on the site, otherwise
 * any open tab on it (the configured Flow project first). Only looking at
 * the focused tab meant a Flow tab sitting in another window was ignored
 * and a duplicate tab got opened instead.
 */
async function findSiteTab(site: GenerationSite): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && siteMatchesTab(site, active.url ?? "")) return active;

  const open = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS[site] })).filter((tab) => tab.id);
  if (site === "flow") {
    const { flowProjectUrl } = await store.getSettings();
    const configured = open.find((tab) => flowProjectUrl && tab.url?.startsWith(flowProjectUrl));
    if (configured) return configured;
  }
  return open[0];
}

/**
 * Reloading the extension orphans the content scripts in tabs that were
 * already open, so the first send finds no receiver. Inject a fresh copy and
 * try once more instead of making the user refresh the page.
 */
async function sendJobToTab(
  tabId: number,
  site: GenerationSite,
  job: VideoJob,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "RUN_VIDEO_JOB", job })) ?? { ok: true };
  } catch {
    if (site === "flow") {
      // Page-world half of the product-photo upload (see flow-file-picker.ts).
      await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/flow-file-picker.js"], world: "MAIN" });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: SITE_SCRIPTS[site] });
    return (await chrome.tabs.sendMessage(tabId, { type: "RUN_VIDEO_JOB", job })) ?? { ok: true };
  }
}

/**
 * Used by RUN_JOB_FROM_POPUP (sent after CREATE_JOB): drive an open tab on
 * the generation site if there is one, otherwise stash the job and open one.
 */
type DispatchResult = { ok: boolean; error?: string; opened?: boolean };

async function dispatchJob(job: VideoJob, site: GenerationSite): Promise<DispatchResult> {
  const tab = await findSiteTab(site);

  if (tab?.id) {
    try {
      const result = await sendJobToTab(tab.id, site, job);
      if (result.ok) await chrome.tabs.update(tab.id, { active: true });
      return result;
    } catch {
      return { ok: false, error: "รีเฟรชหน้าเว็บสร้างวิดีโอก่อนแล้วลองใหม่" };
    }
  }

  const url = await siteTargetUrl(site);
  if (!url) {
    return {
      ok: false,
      error: "ตั้งค่า Google Flow Project URL (https://flow.google.com/project/...) ในแท็บ Settings ก่อน หรือเปิดหน้าโปรเจกต์ Flow ไว้แล้วกดใหม่",
    };
  }
  await chrome.storage.local.set({ pendingVideoJob: job });
  await chrome.tabs.create({ url });
  return { ok: true, opened: true };
}

/* ---------- creating jobs ---------- */

async function createJobForContent(
  contentId: string,
  targetDuration: number,
  variant?: PlanVariant,
): Promise<{ video: store.VideoJob; clips: JobClip[]; imageUrl: string | null }> {
  const content = await store.getContent(contentId);
  if (!content) throw new Error("ไม่พบคอนเทนต์");
  if (content.scenes.length === 0) throw new Error("ต้องสร้าง Scene ก่อนจึงจะสร้างวิดีโอได้");
  const product = await store.getProduct(content.productId);
  const planned = planClips(
    product?.name ?? "-",
    prompts.toScenePromptInputs(content.scenes),
    DEFAULT_VIDEO_SETTINGS,
    targetDuration,
    variant,
    { headline: content.onScreenText, cta: content.onScreenCta },
    content.style,
  );
  const clips = planned.map((c) => ({ index: c.index, prompt: c.prompt }));
  const video = await store.createVideoJob({
    contentId: content.id,
    clips,
    duration: clips.length * CLIP_SECONDS,
    aspectRatio: DEFAULT_VIDEO_SETTINGS.aspectRatio,
    targetDuration,
  });
  return { video, clips, imageUrl: product?.images[0] ?? null };
}

/* ---------- running several videos in a row ---------- */

interface QueuedJob {
  videoId: string;
  site: GenerationSite;
}

/** `current` is the queued video now running; the next one starts when it reports done/failed. */
interface JobQueue {
  current: string | null;
  pending: QueuedJob[];
}

const QUEUE_START_DELAY_MS = 4_000;
const QUEUE_BUSY_RETRIES = 6;
const QUEUE_BUSY_RETRY_MS = 5_000;

async function getJobQueue(): Promise<JobQueue> {
  const stored = await chrome.storage.local.get("jobQueue");
  return (stored.jobQueue as JobQueue | undefined) ?? { current: null, pending: [] };
}

async function setJobQueue(queue: JobQueue): Promise<void> {
  if (!queue.current && queue.pending.length === 0) await chrome.storage.local.remove("jobQueue");
  else await chrome.storage.local.set({ jobQueue: queue });
}

async function jobFromStore(videoId: string): Promise<VideoJob | null> {
  const video = await store.getVideo(videoId);
  if (!video) return null;
  const content = await store.getContent(video.contentId);
  const product = content ? await store.getProduct(content.productId) : null;
  return buildJob({
    videoId: video.id,
    clips: video.clips,
    duration: video.duration,
    aspectRatio: video.aspectRatio,
    imageUrl: product?.images[0] ?? null,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let queueAdvancing = false;

/**
 * Starts the next queued video once `finishedVideoId` (the one running) is
 * over. The generation tab only clears its "job running" flag a moment after
 * it reports done, so a "busy" answer is retried rather than treated as a failure.
 */
async function advanceJobQueue(finishedVideoId: string) {
  if (queueAdvancing) return;
  queueAdvancing = true;
  try {
    let queue = await getJobQueue();
    if (queue.current !== finishedVideoId) return;

    while (queue.pending.length) {
      const [next, ...rest] = queue.pending;
      queue = { current: next.videoId, pending: rest };
      await setJobQueue(queue);

      await sleep(QUEUE_START_DELAY_MS);
      const job = await jobFromStore(next.videoId);
      let result: DispatchResult = { ok: false, error: "ไม่พบงานในคิว" };
      for (let attempt = 0; job && attempt < QUEUE_BUSY_RETRIES; attempt++) {
        result = await dispatchJob(job, next.site);
        if (result.ok || !/มีงานกำลังทำอยู่/.test(result.error ?? "")) break;
        await sleep(QUEUE_BUSY_RETRY_MS);
      }
      if (result.ok) return;

      await store.updateVideoJob(next.videoId, { status: "failed", errorMessage: result.error ?? "เริ่มงานในคิวไม่สำเร็จ" });
      queue = await getJobQueue();
    }
    await setJobQueue({ current: null, pending: [] });
  } finally {
    queueAdvancing = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const progress = changes.jobProgress?.newValue as { videoId?: string; state?: string } | undefined;
  if (!progress?.videoId || (progress.state !== "done" && progress.state !== "failed")) return;
  void advanceJobQueue(progress.videoId);
});

/* ---------- TikTok Studio posting ---------- */

const TIKTOK_CAPTION_EDITOR = '[data-e2e="caption_container"] .public-DraftEditor-content';
const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=creator_center";
const TIKTOK_CLAIM_STALE_MS = 10 * 60_000;

interface PendingTikTokPost {
  tabId: number;
  at: number;
  job: { videoId: string; caption: string; autoPost: boolean; aiLabel: boolean; fileName: string; productId: string | null };
}

interface ShowcaseProduct {
  tiktokId: string;
  name: string;
  price?: number;
  image?: string;
  images?: string[];
  description?: string;
}

/**
 * Runs inside a tiktok.com tab: TikTok Studio's own product picker reads this
 * endpoint with the page's cookies, which the worker can't send cross-site.
 * Must be self-contained — it is serialized into the page by executeScript.
 */
async function fetchShowcaseInPage(): Promise<{ ok: boolean; products?: ShowcaseProduct[]; error?: string }> {
  const count = 20;
  const products: ShowcaseProduct[] = [];
  for (let offset = 0; offset < 1000; offset += count) {
    const res = await fetch(
      `https://shop.tiktok.com/api/v1/streamer_desktop/showcase_product/list?offset=${offset}&count=${count}`,
      { credentials: "include" },
    );
    if (!res.ok) return { ok: false, error: `TikTok ตอบกลับ ${res.status}` };
    const body = await res.json();
    if (body.code !== 0) return { ok: false, error: body.message || `TikTok ตอบกลับ code ${body.code}` };
    const page = (body.data?.products ?? []) as any[];
    for (const item of page) {
      const urls = (item.images ?? []).map((img: any) => img?.thumb_url_list?.[0]).filter(Boolean) as string[];
      const cover = item.cover?.thumb_url_list?.[0] as string | undefined;
      const price = Number(String(item.format_available_price ?? "").replace(/[^0-9.]/g, ""));
      const details = [
        item.seller_info?.shop_name ? `ร้าน: ${item.seller_info.shop_name}` : "",
        item.category_info?.name ? `หมวด: ${item.category_info.name}` : "",
        item.affiliate_info?.commission_with_currency ? `ค่าคอม: ${item.affiliate_info.commission_with_currency}` : "",
      ].filter(Boolean);
      products.push({
        tiktokId: String(item.product_id),
        name: String(item.title ?? ""),
        price: Number.isFinite(price) && price > 0 ? price : undefined,
        image: cover ?? urls[0],
        images: [...new Set([cover, ...urls].filter(Boolean) as string[])].slice(0, 5),
        description: details.join(" · ") || undefined,
      });
    }
    if (page.length < count || products.length >= (body.data?.total ?? 0)) break;
  }
  return { ok: true, products };
}

const PRODUCT_DETAIL_MAX_IMAGES = 8;

/**
 * Full product details from the public TikTok Shop product page, which embeds
 * them as JSON (__MODERN_ROUTER_DATA__): the gallery, the seller's
 * description, specs, variants, sales and rating. The slug in the URL is
 * ignored by TikTok, so "x" stands in for it. TikTok sometimes answers with a
 * captcha page instead; callers then keep the showcase list's summary.
 */
async function fetchTikTokProductDetail(tiktokId: string): Promise<{ name: string; images: string[]; description: string; price?: number } | null> {
  const res = await fetch(`https://shop.tiktok.com/th/pdp/x/${tiktokId}`, { credentials: "omit" });
  if (!res.ok) return null;
  const html = await res.text();
  const json = html.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) return null;

  let info: any = null;
  const find = (node: any, depth: number) => {
    if (info || depth > 16 || !node || typeof node !== "object") return;
    if (node.product_model?.images && String(node.product_model.product_id) === tiktokId) {
      info = node;
      return;
    }
    for (const value of Object.values(node)) find(value, depth + 1);
  };
  find(JSON.parse(json), 0);
  if (!info) return null;

  const model = info.product_model;
  const images = ((model.images ?? []) as any[])
    .map((img) => img?.url_list?.[0])
    .filter(Boolean)
    .slice(0, PRODUCT_DETAIL_MAX_IMAGES) as string[];

  let descriptionText: string[] = [];
  try {
    descriptionText = (JSON.parse(model.description ?? "[]") as any[])
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => String(block.text).trim());
  } catch {
    // description is sometimes plain text rather than blocks
    if (typeof model.description === "string") descriptionText = [model.description];
  }

  const specs = ((model.product_properties ?? []) as any[])
    .map((p) => `${p.property_name}: ${(p.property_values ?? []).map((v: any) => v.property_value_name).join(", ")}`)
    .filter((line) => !line.endsWith(": "));
  const variants = ((model.sale_properties ?? []) as any[]).map(
    (p) => `${p.property_name}: ${(p.property_values ?? []).map((v: any) => v.property_value_name).join(", ")}`,
  );
  const minPrice = info.promotion_model?.promotion_product_price?.min_price;
  const priceValue = Number(String(minPrice?.sale_price_decimal ?? minPrice?.real_price?.price_str ?? "").replace(/[^0-9.]/g, ""));
  const facts = [
    info.seller_model?.shop_name ? `ร้าน: ${info.seller_model.shop_name}` : "",
    model.sold_count ? `ขายแล้ว: ${model.sold_count} ชิ้น` : "",
    info.review_model?.product_overall_score
      ? `คะแนนรีวิว: ${info.review_model.product_overall_score} (${info.review_model.product_review_count} รีวิว)`
      : "",
  ].filter(Boolean);

  const description = [
    descriptionText.join("\n"),
    specs.length ? `สเปก:\n${specs.join("\n")}` : "",
    variants.length ? `ตัวเลือก:\n${variants.join("\n")}` : "",
    facts.join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: String(model.name ?? ""),
    images,
    description,
    price: Number.isFinite(priceValue) && priceValue > 0 ? priceValue : undefined,
  };
}

/** Merges a showcase row with the product page's details; the summary survives if the page can't be read. */
async function withProductDetail(item: ShowcaseProduct): Promise<ShowcaseProduct & { detailed: boolean }> {
  const detail = await fetchTikTokProductDetail(item.tiktokId).catch(() => null);
  if (!detail) return { ...item, detailed: false };
  return {
    ...item,
    name: item.name || detail.name,
    price: item.price ?? detail.price,
    image: detail.images[0] ?? item.image,
    images: detail.images.length ? detail.images : item.images,
    // The showcase summary carries the commission, which the product page doesn't.
    description: [detail.description, item.description].filter(Boolean).join("\n"),
    detailed: true,
  };
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

async function syncTikTokShowcase(): Promise<{ ok: boolean; added?: number; total?: number; detailed?: number; error?: string }> {
  let [tab] = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
  let opened = false;
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: "https://www.tiktok.com/tiktokstudio", active: false });
    opened = true;
    await waitForTabComplete(tab.id!);
  }
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: fetchShowcaseInPage });
    const result = injection?.result as Awaited<ReturnType<typeof fetchShowcaseInPage>> | undefined;
    if (!result?.ok || !result.products) {
      return { ok: false, error: `ดึงสินค้าไม่สำเร็จ: ${result?.error ?? "ไม่ได้ผลลัพธ์"} — ตรวจว่า login TikTok ใน Chrome นี้แล้ว` };
    }
    const detailed = await Promise.all(result.products.map(withProductDetail));
    const before = (await store.listProducts()).length;
    await store.importTikTokProducts(detailed);
    const after = (await store.listProducts()).length;
    return { ok: true, added: after - before, total: result.products.length, detailed: detailed.filter((p) => p.detailed).length };
  } finally {
    if (opened) chrome.tabs.remove(tab.id!).catch(() => {});
  }
}

/** The file to post: the joined video when there is one, otherwise the only clip. */
async function postableClip(videoId: string): Promise<library.StoredClip | null> {
  const clips = await library.getClipsForVideo(videoId);
  const merged = clips.find((c) => c.index === library.MERGED_CLIP_INDEX);
  if (merged) return merged;
  const parts = clips.filter((c) => c.index >= 0);
  if (parts.length === 1) return parts[0];
  if (parts.length > 1) {
    const result = await mergeVideoClips(videoId);
    if (!result.ok) return null;
    return (await library.getClipsForVideo(videoId)).find((c) => c.index === library.MERGED_CLIP_INDEX) ?? null;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Types into the focused element of a tab through the DevTools protocol, so
 * the page receives real input events. TikTok's DraftJS caption editor
 * mangles synthetic input (duplicated hashtags, a crash on the next edit).
 */
async function typeIntoTab(tabId: number, text: string, isMac: boolean, editorSelector: string): Promise<void> {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  const send = (method: string, params: { [key: string]: unknown }) => chrome.debugger.sendCommand(target, method, params);
  const press = async (key: string, code: string, keyCode: number, extra: { [key: string]: unknown } = {}) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, ...extra });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  };
  try {
    // When the side panel (or another window) holds keyboard focus, the page
    // isn't focused and TikTok's DraftJS editor throws the typed text away —
    // autopilot runs hit this while the user watched the panel. Make the page
    // behave as focused and put the caret in the editor with a real click.
    await send("Page.bringToFront", {});
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const located = (await send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(editorSelector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(12, r.height / 2) }; })()`,
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number } | null } } | undefined;
    const point = located?.result?.value;
    if (!point) throw new Error("ไม่พบช่องคำอธิบาย");
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    await press("a", "KeyA", 65, { modifiers: isMac ? 4 : 2, commands: ["selectAll"] });
    await press("Backspace", "Backspace", 8);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // A hashtag at the end of a line leaves its suggestion list open, and Enter would pick a suggestion.
        if (/#[^\s#]+$/.test(lines[i - 1])) await send("Input.insertText", { text: " " });
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
      if (lines[i]) await send("Input.insertText", { text: lines[i] });
    }
    // Same reason as above, for a caption that ends on a hashtag.
    if (/#[^\s#]+$/.test(text)) await send("Input.insertText", { text: " " });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function analyzeProduct(productId: string): Promise<store.ProductAnalysis> {
  const product = await store.getProduct(productId);
  if (!product) throw new Error("ไม่พบสินค้า");
  const images = await gemini.loadImages(product.images);
  const { system, prompt } = prompts.buildAnalysisPrompt(product, images.length > 0);
  const analysis = await gemini.generateObject<store.ProductAnalysis>({
    system,
    prompt,
    images,
    schema: prompts.PRODUCT_ANALYSIS_SCHEMA,
  });
  await store.saveAnalysis(product.id, analysis);
  return analysis;
}

async function generateContentScenes(
  productId: string,
  style: string,
  targetDuration: number,
): Promise<{ content: store.Content; scenes: store.Scene[] }> {
  const product = await store.getProduct(productId);
  if (!product) throw new Error("ไม่พบสินค้า");
  const analysis = await store.getAnalysis(product.id);
  const images = await gemini.loadImages(product.images);

  const contentPrompt = prompts.buildContentPrompt(product, analysis, style, images.length > 0);
  const contentResult = await gemini.generateObject<{
    hook: string;
    script: string;
    caption: string;
    cta: string;
    onScreenText?: string;
    onScreenCta?: string;
  }>({ ...contentPrompt, images, schema: prompts.CONTENT_GENERATION_SCHEMA });

  const content = await store.createContent({
    productId: product.id,
    style,
    hook: contentResult.hook,
    script: contentResult.script,
    caption: contentResult.caption,
    cta: contentResult.cta,
    // Short is what actually renders as legible Thai in Veo — anything longer
    // that Gemini writes despite the prompt's instruction is dropped rather
    // than risking garbled text on screen.
    onScreenText: prompts.cleanOnScreenText(contentResult.onScreenText, 12),
    onScreenCta: prompts.cleanOnScreenText(contentResult.onScreenCta, 10),
  });

  const scenePrompt = prompts.buildScenePrompt(product, contentResult.script, targetDuration, images.length > 0);
  const sceneResult = await gemini.generateObject<{ scenes: store.Scene[] }>({
    ...scenePrompt,
    images,
    schema: prompts.SCENE_PLAN_SCHEMA,
  });
  await store.setScenes(content.id, sceneResult.scenes);
  return { content, scenes: sceneResult.scenes };
}

async function prepareTikTokPost(
  videoId: string,
  caption: string,
  autoPost: boolean,
  productId: string | null,
): Promise<{ ok: boolean; error?: string; tabId?: number }> {
  const video = await store.getVideo(videoId);
  if (!video || video.status !== "completed") return { ok: false, error: "วิดีโอนี้ยังไม่เสร็จ" };
  const clip = await postableClip(videoId);
  if (!clip) return { ok: false, error: "ไม่พบไฟล์วิดีโอในคลัง (หรือต่อคลิปไม่สำเร็จ)" };

  // Store the job before the page loads, so its content script always finds it.
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const pending: PendingTikTokPost = {
    tabId: tab.id!,
    at: Date.now(),
    job: {
      videoId,
      caption,
      autoPost,
      aiLabel: true,
      fileName: `${videoId.slice(0, 8)}-${clip.index === library.MERGED_CLIP_INDEX ? "full" : "clip"}.mp4`,
      productId,
    },
  };
  await chrome.storage.local.set({ pendingTikTokPost: pending });
  await chrome.tabs.update(tab.id!, { url: TIKTOK_UPLOAD_URL });
  await store.updateVideoJob(videoId, { tiktokPost: { status: "preparing", at: Date.now(), error: null } });
  return { ok: true, tabId: tab.id };
}

/* ---------- autopilot ---------- */

const autopilot = createAutopilot({
  analyzeProduct,
  generateContentScenes,
  async startVideo(contentId, targetDuration, site) {
    const { video, clips, imageUrl } = await createJobForContent(contentId, targetDuration);
    const job = await buildJob({
      videoId: video.id,
      clips,
      duration: video.duration,
      aspectRatio: video.aspectRatio,
      imageUrl,
    });
    const result = await dispatchJob(job, site);
    if (!result.ok) {
      await store.updateVideoJob(video.id, { status: "cancelled", errorMessage: result.error ?? null });
      throw new Error(result.error ?? "เริ่มสร้างวิดีโอไม่สำเร็จ");
    }
    return video.id;
  },
  prepareTikTokPost,
  async isManualJobRunning() {
    const queue = await getJobQueue();
    if (queue.current || queue.pending.length) return true;
    // A single video started from the panel isn't queued, but it still holds the Flow tab.
    const { jobProgress } = await chrome.storage.local.get("jobProgress");
    const progress = jobProgress as { state?: string; at?: number } | undefined;
    return Boolean(
      progress && (progress.state === "generating" || progress.state === "uploading") && Date.now() - (progress.at ?? 0) < 20 * 60_000,
    );
  },
});

/* ---------- joining clips into one video ---------- */

let offscreenReady: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
  offscreenReady ??= (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Create a blob: URL so the joined video can be saved with chrome.downloads",
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

async function downloadLibraryFile(videoId: string, index: number, filename: string): Promise<void> {
  await ensureOffscreenDocument();
  const result = (await chrome.runtime.sendMessage({ type: "OFFSCREEN_CLIP_BLOB_URL", videoId, index })) as
    | { ok: boolean; url?: string; error?: string }
    | undefined;
  if (!result?.ok || !result.url) throw new Error(result?.error ?? "สร้างลิงก์ดาวน์โหลดไม่สำเร็จ");
  await chrome.downloads.download({ url: result.url, filename, saveAs: false });
}

type MergeResult = { ok: boolean; seconds?: number; error?: string; warning?: string };

async function mergeVideoClips(videoId: string): Promise<MergeResult> {
  const video = await store.getVideo(videoId);
  if (!video) return { ok: false, error: "ไม่พบงาน" };
  const clips = (await library.getClipsForVideo(videoId)).filter((c) => c.index >= 0);
  if (clips.length < 2) return { ok: false, error: "ต้องมีอย่างน้อย 2 คลิปจึงจะต่อได้" };
  if (clips.length < video.clips.length) {
    return { ok: false, error: `คลิปในคลังยังไม่ครบ (${clips.length}/${video.clips.length})` };
  }

  let seconds: number;
  try {
    const merged = concatMp4(await Promise.all(clips.map((c) => c.blob.arrayBuffer())));
    await library.putClip(videoId, library.MERGED_CLIP_INDEX, new Blob([merged as BlobPart], { type: "video/mp4" }), "video/mp4");
    seconds = clips.length * CLIP_SECONDS;
    await store.updateVideoJob(videoId, { mergedAt: Date.now(), mergeError: null });
  } catch (err) {
    const error = `ต่อคลิปไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`;
    await store.updateVideoJob(videoId, { mergeError: error });
    return { ok: false, error };
  }

  try {
    await downloadLibraryFile(videoId, library.MERGED_CLIP_INDEX, `ai-affiliate/${videoId}-full-${seconds}s.mp4`);
    return { ok: true, seconds };
  } catch (err) {
    // The joined video is in the library either way; only the file copy failed.
    return { ok: true, seconds, warning: `ดาวน์โหลดไฟล์ไม่สำเร็จ (${err instanceof Error ? err.message : String(err)}) — กดดาวน์โหลดจากแท็บคลังแทน` };
  }
}

/**
 * Saves a finished clip locally (IndexedDB for in-panel preview,
 * chrome.downloads for a real file) and advances the job's status.
 * `downloadUrl` must be something chrome.downloads.download() can fetch
 * itself — a data: URL or a plain http(s) URL. `URL.createObjectURL()` is
 * not available in an extension service worker (no document), so callers
 * must not pass a blob: URL here.
 */
async function saveClip(
  videoId: string,
  clipIndex: number,
  clipTotal: number,
  blob: Blob,
  mimeType: string,
  downloadUrl: string,
): Promise<{ ok: boolean; error?: string; merged?: MergeResult }> {
  try {
    await library.putClip(videoId, clipIndex, blob, mimeType);

    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    await chrome.downloads.download({
      url: downloadUrl,
      filename: `ai-affiliate/${videoId}-clip-${clipIndex}.${ext}`,
      saveAs: false,
    });

    const video = await store.getVideo(videoId);
    const clipsReceived = (video?.clipsReceived ?? 0) + 1;
    const done = clipsReceived >= clipTotal;
    await store.updateVideoJob(videoId, {
      clipsReceived,
      status: done ? "completed" : "processing",
    });
    // A multi-clip video is one advert — hand back a single file, not parts.
    if (done && clipTotal > 1) return { ok: true, merged: await mergeVideoClips(videoId) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "บันทึกคลิปไม่สำเร็จ" };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // Dev bridge only (dev-bridge.ts, localhost pages): picks up a rebuilt
  // dist without a trip to chrome://extensions.
  if ((message as { type: string }).type === "DEV_RELOAD_EXTENSION") {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(sender.url ?? "")) {
      sendResponse({ ok: false, error: "not allowed" });
      return;
    }
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 200);
    return;
  }

  if (message.type === "ADD_PRODUCT") {
    (async () => {
      const product = await store.createProduct({
        name: message.product.name || message.product.url,
        description: message.product.description,
        price: message.product.price ? Number(message.product.price) : undefined,
        source: "extension",
        sourceUrl: message.product.url,
        images: message.product.images?.length ? message.product.images : message.product.image ? [message.product.image] : [],
      });
      sendResponse({ ok: true, product });
    })();
    return true;
  }

  if (message.type === "RUN_JOB_FROM_POPUP") {
    (async () => {
      try {
        const site = message.site ?? "aistudio";
        const job = await buildJob(message.job, message.targetDuration);
        sendResponse(await dispatchJob(job, site));
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "เริ่มสร้างวิดีโอไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if (message.type === "ANALYZE_PRODUCT") {
    (async () => {
      try {
        sendResponse({ ok: true, analysis: await analyzeProduct(message.productId) });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "วิเคราะห์สินค้าไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if (message.type === "GENERATE_CONTENT_SCENES") {
    (async () => {
      try {
        const { content, scenes } = await generateContentScenes(message.productId, message.style, message.targetDuration);
        sendResponse({
          ok: true,
          content: {
            id: content.id,
            hook: content.hook,
            script: content.script,
            caption: content.caption,
            cta: content.cta,
          },
          scenes,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "สร้างคอนเทนต์ไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if (message.type === "GET_PENDING_JOBS") {
    (async () => {
      const jobs = await store.listPendingVideoJobs();
      sendResponse({
        ok: true,
        jobs: jobs.map((j) => ({
          videoId: j.id,
          productName: j.productName,
          hook: j.hook,
          clips: j.clips,
          imageUrl: j.imageUrl,
          duration: j.duration,
          aspectRatio: j.aspectRatio,
        })),
      });
    })();
    return true;
  }

  if (message.type === "GET_CONTENTS") {
    (async () => {
      const contents = await store.listContentsWithScenes();
      sendResponse({
        ok: true,
        contents: contents.map((c) => ({
          contentId: c.id,
          productName: c.productName,
          hook: c.hook,
          sceneCount: c.scenes.length,
          imageUrl: c.imageUrl,
        })),
      });
    })();
    return true;
  }

  if (message.type === "GET_COMPLETED_VIDEOS") {
    (async () => {
      const videos = await store.listCompletedVideos();
      sendResponse({
        ok: true,
        videos: videos.map((v) => ({
          videoId: v.id,
          productName: v.productName,
          hook: v.hook,
          imageUrl: v.imageUrl,
          clipCount: v.clips.length,
          seconds: v.clips.length * CLIP_SECONDS,
          mergedAt: v.mergedAt ?? null,
          mergeError: v.mergeError ?? null,
          caption: v.caption,
          productTikTokId: v.productTikTokId,
          tiktokPost: v.tiktokPost ?? null,
        })),
      });
    })();
    return true;
  }

  if (message.type === "CREATE_JOB") {
    (async () => {
      try {
        const { video, clips, imageUrl } = await createJobForContent(message.contentId, message.targetDuration);
        sendResponse({
          ok: true,
          video: { id: video.id },
          clips,
          duration: video.duration,
          aspectRatio: video.aspectRatio,
          imageUrl,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "สร้างงานไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if ((message as { type: string }).type.startsWith("AUTOPILOT_")) {
    autopilot
      .handleMessage(message as unknown as { type: string })
      .then((response) => sendResponse(response ?? { ok: false, error: "unknown autopilot command" }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (message.type === "RUN_BATCH") {
    (async () => {
      try {
        if (await autopilot.isBusy()) {
          sendResponse({ ok: false, error: "ระบบอัตโนมัติกำลังใช้ Flow อยู่ — หยุดชั่วคราวในแท็บอัตโนมัติก่อน" });
          return;
        }
        const queue = await getJobQueue();
        const running = queue.current ? await store.getVideo(queue.current) : null;
        if (queue.current && running?.status !== "queued" && running?.status !== "processing") {
          // Left behind by a run whose tab was closed or never reported back.
          await setJobQueue({ current: null, pending: [] });
        } else if (queue.current || queue.pending.length) {
          sendResponse({ ok: false, error: "มีงานในคิวอยู่แล้ว — รอให้เสร็จหรือกดยกเลิกก่อน" });
          return;
        }
        const count = Math.min(10, Math.max(1, Math.round(message.count || 1)));
        const created = [];
        for (let i = 0; i < count; i++) {
          created.push(await createJobForContent(message.contentId, message.targetDuration, { index: i, total: count }));
        }

        const [first, ...rest] = created;
        await setJobQueue({
          current: rest.length ? first.video.id : null,
          pending: rest.map((c) => ({ videoId: c.video.id, site: message.site })),
        });
        const job = await buildJob({
          videoId: first.video.id,
          clips: first.clips,
          duration: first.video.duration,
          aspectRatio: first.video.aspectRatio,
          imageUrl: first.imageUrl,
        });
        const result = await dispatchJob(job, message.site);
        if (!result.ok) {
          // Nothing started, so don't leave the rest waiting on a job that never runs.
          await setJobQueue({ current: null, pending: [] });
          for (const c of created) await store.updateVideoJob(c.video.id, { status: "cancelled", errorMessage: result.error ?? null });
        }
        sendResponse({ ...result, videoIds: created.map((c) => c.video.id) });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "สร้างงานไม่สำเร็จ" });
      }
    })();
    return true;
  }

  // From the "+ AI Studio" buttons injected into TikTok Studio's product picker (tiktok-upload.ts).
  if ((message as { type: string }).type === "IMPORT_TIKTOK_PRODUCT_DETAILS") {
    (async () => {
      try {
        const { products: rows } = message as unknown as { products: ShowcaseProduct[] };
        const detailed = await Promise.all(rows.map(withProductDetail));
        const imported = await store.importTikTokProducts(detailed);
        sendResponse({
          ok: true,
          products: imported.map((p, i) => ({
            name: p.name,
            images: p.images.length,
            detailed: detailed[i].detailed,
          })),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "เพิ่มสินค้าไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if (message.type === "SYNC_TIKTOK_SHOWCASE") {
    (async () => {
      try {
        sendResponse(await syncTikTokShowcase());
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "ดึงสินค้าไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if (message.type === "PREPARE_TIKTOK_POST") {
    (async () => {
      try {
        sendResponse(await prepareTikTokPost(message.videoId, message.caption, message.autoPost, message.productId));
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "เปิดหน้าโพสต์ TikTok ไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if ((message as { type: string }).type === "CLAIM_TIKTOK_POST") {
    (async () => {
      const stored = await chrome.storage.local.get("pendingTikTokPost");
      const pending = stored.pendingTikTokPost as PendingTikTokPost | undefined;
      // Only the tab opened for this post may take it — not some other Studio tab the user has open.
      if (!pending || pending.tabId !== sender.tab?.id || Date.now() - pending.at > TIKTOK_CLAIM_STALE_MS) {
        sendResponse({ job: null });
        return;
      }
      await chrome.storage.local.remove("pendingTikTokPost");
      sendResponse({ job: pending.job });
    })();
    return true;
  }

  if ((message as { type: string }).type === "GET_TIKTOK_POST_FILE") {
    (async () => {
      try {
        const clip = await postableClip((message as unknown as { videoId: string }).videoId);
        if (!clip) {
          sendResponse({ ok: false, error: "ไม่พบไฟล์วิดีโอในคลัง" });
          return;
        }
        const bytes = new Uint8Array(await clip.blob.arrayBuffer());
        sendResponse({ ok: true, base64: bytesToBase64(bytes), mimeType: clip.mimeType || "video/mp4" });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "อ่านไฟล์วิดีโอไม่สำเร็จ" });
      }
    })();
    return true;
  }

  if ((message as { type: string }).type === "TIKTOK_TYPE_CAPTION") {
    (async () => {
      const { caption, isMac } = message as unknown as { caption: string; isMac: boolean };
      if (!sender.tab?.id || !/^https:\/\/www\.tiktok\.com\/tiktokstudio\//.test(sender.tab.url ?? "")) {
        sendResponse({ ok: false, error: "not allowed" });
        return;
      }
      try {
        await typeIntoTab(sender.tab.id, caption, isMac, TIKTOK_CAPTION_EDITOR);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if ((message as { type: string }).type === "TIKTOK_POST_RESULT") {
    (async () => {
      const { videoId, status, error } = message as unknown as { videoId: string; status: "ready" | "posted" | "failed"; error?: string };
      await store.updateVideoJob(videoId, { tiktokPost: { status, at: Date.now(), error: error ?? null } });
      sendResponse({ ok: true });
      // Autopilot opens one upload tab per post; once it's published the tab has done its job.
      if (status === "posted" && sender.tab?.id && (await autopilot.ownsVideo(videoId))) {
        const tabId = sender.tab.id;
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 8000);
      }
    })();
    return true;
  }

  if (message.type === "MERGE_VIDEO") {
    (async () => {
      sendResponse(await mergeVideoClips(message.videoId));
    })();
    return true;
  }

  if (message.type === "CANCEL_JOB") {
    (async () => {
      // The side panel's CANCEL_RUNNING_JOB goes through runtime.sendMessage,
      // which never reaches content scripts — so the automation loop in the
      // generation tab kept submitting prompts after a cancel. Tell the tabs.
      const generationTabs = await chrome.tabs.query({ url: Object.values(SITE_TAB_PATTERNS) });
      await Promise.all(
        generationTabs
          .filter((tab) => tab.id)
          .map((tab) => chrome.tabs.sendMessage(tab.id!, { type: "CANCEL_RUNNING_JOB" }).catch(() => {})),
      );

      // Cancelling stops the whole run, not just the video on screen.
      const queue = await getJobQueue();
      for (const queued of queue.pending) {
        await store.updateVideoJob(queued.videoId, { status: "cancelled", errorMessage: "ยกเลิกโดยผู้ใช้" });
      }
      await setJobQueue({ current: null, pending: [] });

      const existing = await store.getVideo(message.videoId);
      if (existing?.status === "completed") {
        sendResponse({ ok: false, error: "วิดีโอนี้สร้างเสร็จแล้ว ยกเลิกไม่ได้" });
        return;
      }
      await chrome.storage.local.remove(["activeFlowJob", "pendingVideoJob"]);
      await chrome.storage.local.set({
        jobProgress: { videoId: message.videoId, current: 0, total: 0, state: "cancelled", at: Date.now() },
      });
      await library.deleteClipsForVideo(message.videoId);
      const video = await store.updateVideoJob(message.videoId, {
        status: "cancelled",
        errorMessage: "ยกเลิกโดยผู้ใช้",
      });
      sendResponse(video ? { ok: true } : { ok: false, error: "ไม่พบงาน" });
    })();
    return true;
  }

  if (message.type === "GET_PENDING_VIDEO_JOB") {
    (async () => {
      const stored = await chrome.storage.local.get("pendingVideoJob");
      const job = (stored.pendingVideoJob as VideoJob | undefined) ?? null;
      // Clear before responding so a second asker can't claim the same job.
      if (job) await chrome.storage.local.remove("pendingVideoJob");
      sendResponse({ job });
    })();
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    (async () => {
      sendResponse({ ok: true, settings: await store.getSettings() });
    })();
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    (async () => {
      sendResponse({ ok: true, settings: await store.saveSettings(message.settings) });
    })();
    return true;
  }

  if (message.type === "GET_API_KEYS_STATUS") {
    (async () => {
      const state = await store.getApiKeyState();
      const now = Date.now();
      sendResponse({
        ok: true,
        keys: state.keys.map((key) => ({
          key,
          masked: key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key,
          cooldownUntil: state.cooldowns[key] && state.cooldowns[key] > now ? state.cooldowns[key] : null,
        })),
      });
    })();
    return true;
  }

  if (message.type === "SAVE_API_KEYS") {
    (async () => {
      const state = await store.saveApiKeys(message.keys);
      sendResponse({ ok: true, count: state.keys.length });
    })();
    return true;
  }

  if (message.type === "RESET_KEY_COOLDOWN") {
    (async () => {
      await store.clearKeyCooldown(message.key);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "UPLOAD_VIDEO") {
    (async () => {
      try {
        const bytes = base64ToUint8Array(message.base64);
        sendResponse(
          await saveClip(
            message.videoId,
            message.clipIndex ?? 0,
            message.clipTotal ?? 1,
            new Blob([bytes as unknown as BlobPart], { type: message.mimeType }),
            message.mimeType,
            `data:${message.mimeType};base64,${message.base64}`,
          ),
        );
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว" });
      }
    })();
    return true;
  }

  if (message.type === "IMPORT_TIKTOK_PRODUCTS") {
    (async () => {
      const products = await store.importTikTokProducts(message.products);
      sendResponse({ ok: true, products });
    })();
    return true;
  }

  if (message.type === "GET_TIKTOK_PRODUCTS") {
    (async () => {
      sendResponse({ ok: true, products: await store.listProducts() });
    })();
    return true;
  }

  if (message.type === "DELETE_TIKTOK_PRODUCTS") {
    (async () => {
      const count = await store.deleteProducts(message.ids);
      sendResponse({ ok: true, count });
    })();
    return true;
  }

  if (message.type === "FETCH_AND_UPLOAD_VIDEO") {
    (async () => {
      try {
        const res = await fetch(message.url, { credentials: "include" });
        if (!res.ok) {
          sendResponse({ ok: false, error: `ดึงไฟล์วิดีโอไม่สำเร็จ (${res.status})` });
          return;
        }
        const blob = await res.blob();
        sendResponse(
          await saveClip(
            message.videoId,
            message.clipIndex ?? 0,
            message.clipTotal ?? 1,
            blob,
            "video/mp4",
            message.url,
          ),
        );
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว" });
      }
    })();
    return true;
  }
});

/**
 * Makes the toolbar icon open the side panel directly. With this set,
 * chrome.action.onClicked never fires for the icon click — the side panel
 * API consumes it instead, per Chrome's documented pattern for MV3 side
 * panels (there is no reliable way to call sidePanel.open() reactively from
 * an onClicked listener across all Chrome versions).
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
