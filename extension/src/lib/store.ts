/** chrome.storage.local-backed replacement for product.service/content.service/scene.service/video.service.ts. Single-user, so no userId scoping. */

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  currency: string | null;
  source: string;
  sourceUrl: string | null;
  images: string[];
}

export interface ProductAnalysis {
  targetCustomer: string;
  painPoints: string[];
  sellingPoints: string[];
  angles: string[];
}

export interface Scene {
  duration: number;
  description: string;
  /** Camera movement for the scene, continuing from the previous one. */
  cameraMotion?: string;
}

export interface Content {
  id: string;
  productId: string;
  style: string;
  hook: string;
  script: string;
  caption: string;
  cta: string;
  /** Short Thai text for Veo to render on screen (missing on content made before it existed). */
  onScreenText?: string;
  onScreenCta?: string;
  scenes: Scene[];
}

export type VideoStatus = "queued" | "processing" | "completed" | "cancelled" | "failed";

export interface VideoJobClip {
  index: number;
  prompt: string;
}

export interface VideoJob {
  id: string;
  contentId: string;
  status: VideoStatus;
  clips: VideoJobClip[];
  duration: number;
  aspectRatio: string;
  targetDuration: number;
  clipsReceived: number;
  errorMessage: string | null;
  createdAt: number;
  /** Set once the clips were joined into one file (library index MERGED_CLIP_INDEX). */
  mergedAt?: number | null;
  mergeError?: string | null;
  /** Last TikTok Studio posting attempt (tiktok-upload.ts). */
  tiktokPost?: { status: "preparing" | "ready" | "posted" | "failed"; at: number; error: string | null } | null;
}

export interface Settings {
  geminiModel: string;
  flowProjectUrl: string;
  /** Press TikTok's Post button after filling the form, instead of stopping for review. */
  tiktokAutoPost?: boolean;
}

/**
 * Load-balances several Gemini API keys (typically from separate Google
 * accounts, each with its own free-tier quota) round-robin, skipping any
 * key currently on cooldown from a 429. Kept separate from `settings`
 * since it churns on every request while settings only change when the
 * user edits them.
 */
export interface ApiKeyState {
  keys: string[];
  nextIndex: number;
  cooldowns: Record<string, number>; // key -> epoch ms it becomes usable again
}

interface StoreShape {
  products: Product[];
  analyses: Record<string, ProductAnalysis>;
  contents: Content[];
  videos: VideoJob[];
  settings: Settings;
  geminiKeys: ApiKeyState;
}

const DEFAULTS: StoreShape = {
  products: [],
  analyses: {},
  contents: [],
  videos: [],
  settings: { geminiModel: "gemini-flash-latest", flowProjectUrl: "" },
  geminiKeys: { keys: [], nextIndex: 0, cooldowns: {} },
};

async function getAll<K extends keyof StoreShape>(key: K): Promise<StoreShape[K]> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as StoreShape[K] | undefined) ?? DEFAULTS[key];
}

async function setAll<K extends keyof StoreShape>(key: K, value: StoreShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

function newId(): string {
  return crypto.randomUUID();
}

/* ---------- settings ---------- */

export async function getSettings(): Promise<Settings> {
  return getAll("settings");
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await setAll("settings", next);
  return next;
}

/* ---------- gemini API keys (round-robin + cooldown) ---------- */

export async function getApiKeyState(): Promise<ApiKeyState> {
  return getAll("geminiKeys");
}

/** Replaces the key list. Cooldowns for keys that still exist are kept; dropped keys' cooldowns are discarded. */
export async function saveApiKeys(keys: string[]): Promise<ApiKeyState> {
  const current = await getApiKeyState();
  const keySet = new Set(keys);
  const cooldowns: Record<string, number> = {};
  for (const [key, until] of Object.entries(current.cooldowns)) {
    if (keySet.has(key)) cooldowns[key] = until;
  }
  const next: ApiKeyState = { keys, nextIndex: 0, cooldowns };
  await setAll("geminiKeys", next);
  return next;
}

/** Round-robins across keys not currently on cooldown; returns null if every key is benched. */
export async function pickAvailableKey(): Promise<string | null> {
  const state = await getApiKeyState();
  if (state.keys.length === 0) return null;

  const now = Date.now();
  for (let i = 0; i < state.keys.length; i++) {
    const idx = (state.nextIndex + i) % state.keys.length;
    const key = state.keys[idx];
    if ((state.cooldowns[key] ?? 0) <= now) {
      state.nextIndex = (idx + 1) % state.keys.length;
      await setAll("geminiKeys", state);
      return key;
    }
  }
  return null;
}

export async function markKeyCooldown(key: string, until: number): Promise<void> {
  const state = await getApiKeyState();
  if (!state.keys.includes(key)) return;
  state.cooldowns[key] = until;
  await setAll("geminiKeys", state);
}

export async function clearKeyCooldown(key: string): Promise<void> {
  const state = await getApiKeyState();
  delete state.cooldowns[key];
  await setAll("geminiKeys", state);
}

/* ---------- products ---------- */

export async function listProducts(): Promise<Product[]> {
  const products = await getAll("products");
  return [...products].sort((a, b) => b.id.localeCompare(a.id));
}

export async function getProduct(productId: string): Promise<Product | null> {
  const products = await getAll("products");
  return products.find((p) => p.id === productId) ?? null;
}

export async function createProduct(input: {
  name: string;
  description?: string | null;
  price?: number | null;
  currency?: string | null;
  source?: string;
  sourceUrl?: string | null;
  images?: string[];
}): Promise<Product> {
  const products = await getAll("products");
  const product: Product = {
    id: newId(),
    name: input.name,
    description: input.description ?? null,
    price: input.price ?? null,
    currency: input.currency ?? null,
    source: input.source ?? "manual",
    sourceUrl: input.sourceUrl ?? null,
    images: input.images ?? [],
  };
  products.push(product);
  await setAll("products", products);
  return product;
}

export async function deleteProducts(ids: string[]): Promise<number> {
  const idSet = new Set(ids);
  const products = await getAll("products");
  const remaining = products.filter((p) => !idSet.has(p.id));
  const removed = products.length - remaining.length;
  await setAll("products", remaining);

  // Cascade: analyses and contents (and their videos) tied to a deleted product are dead weight otherwise.
  const analyses = await getAll("analyses");
  for (const id of ids) delete analyses[id];
  await setAll("analyses", analyses);

  const contents = await getAll("contents");
  const deadContentIds = new Set(contents.filter((c) => idSet.has(c.productId)).map((c) => c.id));
  await setAll(
    "contents",
    contents.filter((c) => !idSet.has(c.productId)),
  );
  if (deadContentIds.size) {
    const videos = await getAll("videos");
    await setAll(
      "videos",
      videos.filter((v) => !deadContentIds.has(v.contentId)),
    );
  }

  return removed;
}

/** TikTok product IDs round-trip through sourceUrl so re-import is idempotent. */
export async function importTikTokProducts(
  items: { tiktokId: string; name: string; price?: number; image?: string; images?: string[]; description?: string }[],
): Promise<Product[]> {
  const products = await getAll("products");
  const results: Product[] = [];

  for (const item of items) {
    const sourceUrl = `https://www.tiktok.com/tiktokstudio/product/${item.tiktokId}`;
    const images = item.images?.length ? item.images : item.image ? [item.image] : [];
    const existing = products.find((p) => p.sourceUrl === sourceUrl);
    if (existing) {
      // Re-importing refreshes what the shop may have changed, without touching the product's id.
      existing.price = item.price ?? existing.price;
      if (images.length) existing.images = images;
      existing.description = item.description ?? existing.description;
      results.push(existing);
      continue;
    }
    const product: Product = {
      id: newId(),
      name: item.name,
      description: item.description ?? null,
      price: item.price ?? null,
      currency: "THB",
      source: "tiktok",
      sourceUrl,
      images,
    };
    products.push(product);
    results.push(product);
  }

  await setAll("products", products);
  return results;
}

/* ---------- analysis ---------- */

export async function getAnalysis(productId: string): Promise<ProductAnalysis | null> {
  const analyses = await getAll("analyses");
  return analyses[productId] ?? null;
}

export async function saveAnalysis(productId: string, analysis: ProductAnalysis): Promise<void> {
  const analyses = await getAll("analyses");
  analyses[productId] = analysis;
  await setAll("analyses", analyses);
}

/* ---------- contents ---------- */

export async function listContentsWithScenes(): Promise<(Content & { productName: string; imageUrl: string | null })[]> {
  const [contents, products] = await Promise.all([getAll("contents"), getAll("products")]);
  return contents
    .filter((c) => c.scenes.length > 0)
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 20)
    .map((c) => {
      const product = products.find((p) => p.id === c.productId);
      return { ...c, productName: product?.name ?? "-", imageUrl: product?.images[0] ?? null };
    });
}

export async function getContent(contentId: string): Promise<Content | null> {
  const contents = await getAll("contents");
  return contents.find((c) => c.id === contentId) ?? null;
}

export async function createContent(input: {
  productId: string;
  style: string;
  hook: string;
  script: string;
  caption: string;
  cta: string;
  onScreenText?: string;
  onScreenCta?: string;
}): Promise<Content> {
  const contents = await getAll("contents");
  const content: Content = { id: newId(), scenes: [], ...input };
  contents.push(content);
  await setAll("contents", contents);
  return content;
}

export async function setScenes(contentId: string, scenes: Scene[]): Promise<void> {
  const contents = await getAll("contents");
  const content = contents.find((c) => c.id === contentId);
  if (!content) return;
  content.scenes = scenes;
  await setAll("contents", contents);
}

/* ---------- videos ---------- */

type VideoWithInfo = VideoJob & {
  productName: string;
  hook: string;
  caption: string;
  imageUrl: string | null;
  /** Set when the product came from TikTok, so its video can carry a product link. */
  productTikTokId: string | null;
};

export function tiktokIdFromSourceUrl(sourceUrl: string | null | undefined): string | null {
  return sourceUrl?.match(/^https:\/\/www\.tiktok\.com\/tiktokstudio\/product\/(\d+)$/)?.[1] ?? null;
}

async function listVideosWithInfo(filter: (v: VideoJob) => boolean): Promise<VideoWithInfo[]> {
  const [videos, contents, products] = await Promise.all([getAll("videos"), getAll("contents"), getAll("products")]);
  return videos
    .filter(filter)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((v) => {
      const content = contents.find((c) => c.id === v.contentId);
      const product = content ? products.find((p) => p.id === content.productId) : undefined;
      return {
        ...v,
        productName: product?.name ?? "-",
        hook: content?.hook ?? "",
        caption: content?.caption ?? "",
        imageUrl: product?.images[0] ?? null,
        productTikTokId: tiktokIdFromSourceUrl(product?.sourceUrl),
      };
    });
}

export async function listPendingVideoJobs(): Promise<VideoWithInfo[]> {
  return listVideosWithInfo((v) => v.status === "queued" || v.status === "processing");
}

export async function listCompletedVideos(): Promise<VideoWithInfo[]> {
  return listVideosWithInfo((v) => v.status === "completed");
}

export async function getVideo(videoId: string): Promise<VideoJob | null> {
  const videos = await getAll("videos");
  return videos.find((v) => v.id === videoId) ?? null;
}

export async function createVideoJob(input: {
  contentId: string;
  clips: VideoJobClip[];
  duration: number;
  aspectRatio: string;
  targetDuration: number;
}): Promise<VideoJob> {
  const videos = await getAll("videos");
  const video: VideoJob = {
    id: newId(),
    contentId: input.contentId,
    status: "queued",
    clips: input.clips,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    targetDuration: input.targetDuration,
    clipsReceived: 0,
    errorMessage: null,
    createdAt: Date.now(),
  };
  videos.push(video);
  await setAll("videos", videos);
  return video;
}

export async function updateVideoJob(videoId: string, patch: Partial<VideoJob>): Promise<VideoJob | null> {
  const videos = await getAll("videos");
  const video = videos.find((v) => v.id === videoId);
  if (!video) return null;
  Object.assign(video, patch);
  await setAll("videos", videos);
  return video;
}
