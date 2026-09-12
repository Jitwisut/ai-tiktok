const WEB_APP_URL = "http://localhost:3000";
const VEO_MODEL_ID = "veo-3.1-fast-generate-preview";
const CLIP_SECONDS = 8;
const VEO_STUDIO_URL = `https://aistudio.google.com/prompts/new_video?model=${VEO_MODEL_ID}`;

type GenerationSite = "aistudio" | "flow";

async function siteTargetUrl(site: GenerationSite): Promise<string> {
  if (site === "aistudio") return VEO_STUDIO_URL;
  const stored = await chrome.storage.local.get("flowProjectUrl");
  return (stored.flowProjectUrl as string | undefined) || "https://flow.google.com/";
}

function siteMatchesTab(site: GenerationSite, url: string): boolean {
  return site === "aistudio"
    ? url.includes("aistudio.google.com")
    : url.includes("flow.google.com");
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
  duration: number;
  aspectRatio: string;
  imageUrl?: string | null;
}

interface QueueVideoJobMessage {
  type: "QUEUE_EXTENSION_VIDEO_JOB";
  job: IncomingVideoJob;
  site?: GenerationSite;
}

interface GetPendingVideoJobMessage {
  type: "GET_PENDING_VIDEO_JOB";
}

/**
 * Used by the in-page panel. The content script cannot fetch the app itself
 * — Flow's CSP blocks it — so the worker does it and hands back the list.
 */
interface GetPendingJobsMessage {
  type: "GET_PENDING_JOBS";
}

interface GetContentsMessage {
  type: "GET_CONTENTS";
}

interface CreateJobMessage {
  type: "CREATE_JOB";
  contentId: string;
  targetDuration: number;
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

type ExtensionMessage =
  | AddProductMessage
  | QueueVideoJobMessage
  | GetPendingVideoJobMessage
  | GetPendingJobsMessage
  | GetContentsMessage
  | CreateJobMessage
  | CancelJobMessage
  | RunJobFromPopupMessage
  | UploadVideoMessage
  | FetchAndUploadMessage
  | ImportTikTokProductsMessage;

async function getExtensionConfig() {
  const stored = await chrome.storage.local.get(["appBaseUrl", "extensionToken"]);
  return {
    appBaseUrl: (stored.appBaseUrl as string | undefined) || WEB_APP_URL,
    extensionToken: (stored.extensionToken as string | undefined) || "",
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Fetched from the background worker (not the content script) because it
 * has host_permissions for the app's origin and isn't subject to
 * aistudio.google.com's page CSP — the resulting bytes travel to the
 * content script as base64 via chrome.storage instead.
 */
async function fetchImageAsBase64(
  imageUrl: string,
  appBaseUrl: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const absoluteUrl = imageUrl.startsWith("http") ? imageUrl : `${appBaseUrl}${imageUrl}`;
    const res = await fetch(absoluteUrl);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();
    return { base64: arrayBufferToBase64(buffer), mimeType };
  } catch {
    return null;
  }
}

/** Asks the app to re-plan the job's clips when the popup picked a length. */
async function replanClips(
  videoId: string,
  targetDuration: number,
  appBaseUrl: string,
  extensionToken: string,
): Promise<JobClip[] | null> {
  try {
    const res = await fetch(`${appBaseUrl}/api/videos/extension/${videoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Extension-Token": extensionToken },
      body: JSON.stringify({ targetDuration }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { clips: JobClip[] };
    return body.clips ?? null;
  } catch {
    return null;
  }
}

async function buildJob(incoming: IncomingVideoJob, targetDuration?: number): Promise<VideoJob> {
  const { appBaseUrl, extensionToken } = await getExtensionConfig();
  const image = incoming.imageUrl ? await fetchImageAsBase64(incoming.imageUrl, appBaseUrl) : null;

  let clips = incoming.clips;
  if (targetDuration && targetDuration !== incoming.clips.length * CLIP_SECONDS) {
    clips = (await replanClips(incoming.videoId, targetDuration, appBaseUrl, extensionToken)) ?? clips;
  }

  return {
    videoId: incoming.videoId,
    clips,
    duration: incoming.duration,
    aspectRatio: incoming.aspectRatio,
    modelId: VEO_MODEL_ID,
    imageBase64: image?.base64,
    imageMimeType: image?.mimeType,
  };
}

async function callApp(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; error?: string }> {
  const { appBaseUrl, extensionToken } = await getExtensionConfig();
  if (!extensionToken) {
    return { ok: false, status: 0, body: {}, error: "ยังไม่ได้ตั้งค่า Extension Token ในหน้า Settings" };
  }
  try {
    const res = await fetch(`${appBaseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Extension-Token": extensionToken,
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: res.ok,
      status: res.status,
      body,
      error: res.ok ? undefined : ((body.error as string) ?? `ผิดพลาด (${res.status})`),
    };
  } catch {
    return { ok: false, status: 0, body: {}, error: `เชื่อมต่อ ${appBaseUrl} ไม่ได้` };
  }
}

async function postClipToApp(
  videoId: string,
  body: BodyInit,
  mimeType: string,
  clipIndex: number,
  clipTotal: number,
): Promise<{ ok: boolean; error?: string }> {
  const { appBaseUrl, extensionToken } = await getExtensionConfig();
  if (!extensionToken) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า Extension Token ใน Options" };
  }

  const query = `?clip=${clipIndex}&total=${clipTotal}`;
  const res = await fetch(`${appBaseUrl}/api/videos/${videoId}/upload${query}`, {
    method: "POST",
    headers: { "Content-Type": mimeType, "X-Extension-Token": extensionToken },
    body,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    return { ok: false, error: errorBody.error ?? `อัปโหลดล้มเหลว (${res.status})` };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "ADD_PRODUCT") {
    const params = new URLSearchParams({ source: "extension", sourceUrl: message.product.url });
    if (message.product.name) params.set("name", message.product.name);
    if (message.product.description) params.set("description", message.product.description);
    if (message.product.price) params.set("price", message.product.price);
    if (message.product.image) params.set("image", message.product.image);
    // Extra shots ride along so the analysis has more than one angle to look at.
    if (message.product.images?.length) params.set("images", message.product.images.join("|"));

    chrome.tabs.create({ url: `${WEB_APP_URL}/products/new?${params.toString()}` });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "QUEUE_EXTENSION_VIDEO_JOB") {
    (async () => {
      const site = message.site ?? "aistudio";
      const job = await buildJob(message.job);
      const url = await siteTargetUrl(site);
      chrome.storage.local.set({ pendingVideoJob: job }, () => {
        chrome.tabs.create({ url });
        sendResponse({ ok: true });
      });
    })();
    return true;
  }

  if (message.type === "RUN_JOB_FROM_POPUP") {
    (async () => {
      const site = message.site ?? "aistudio";
      const job = await buildJob(message.job, message.targetDuration);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Already on the generation site: drive that tab directly so the user
      // never leaves the page they are looking at.
      if (tab?.id && siteMatchesTab(site, tab.url ?? "")) {
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { type: "RUN_VIDEO_JOB", job });
          sendResponse(result ?? { ok: true });
        } catch {
          sendResponse({ ok: false, error: "รีเฟรชหน้าเว็บสร้างวิดีโอก่อนแล้วลองใหม่" });
        }
        return;
      }

      const url = await siteTargetUrl(site);
      chrome.storage.local.set({ pendingVideoJob: job }, () => {
        chrome.tabs.create({ url });
        sendResponse({ ok: true });
      });
    })();
    return true;
  }

  if (message.type === "GET_PENDING_JOBS") {
    (async () => {
      const { appBaseUrl, extensionToken } = await getExtensionConfig();
      if (!extensionToken) {
        sendResponse({ ok: false, error: "ยังไม่ได้ตั้งค่า Extension Token ในหน้า Settings" });
        return;
      }
      try {
        const res = await fetch(`${appBaseUrl}/api/videos/extension/pending`, {
          headers: { "X-Extension-Token": extensionToken },
        });
        if (!res.ok) {
          sendResponse({ ok: false, error: `โหลดงานไม่สำเร็จ (${res.status})` });
          return;
        }
        const body = (await res.json()) as { jobs: unknown[] };
        sendResponse({ ok: true, jobs: body.jobs ?? [], appBaseUrl });
      } catch {
        sendResponse({ ok: false, error: `เชื่อมต่อ ${appBaseUrl} ไม่ได้` });
      }
    })();
    return true;
  }

  if (message.type === "GET_CONTENTS") {
    (async () => {
      const result = await callApp("/api/contents/extension");
      sendResponse(
        result.ok ? { ok: true, contents: result.body.contents ?? [] } : { ok: false, error: result.error },
      );
    })();
    return true;
  }

  if (message.type === "CREATE_JOB") {
    (async () => {
      const result = await callApp("/api/contents/extension", {
        method: "POST",
        body: JSON.stringify({
          contentId: message.contentId,
          targetDuration: message.targetDuration,
        }),
      });
      sendResponse(result.ok ? { ok: true, ...result.body } : { ok: false, error: result.error });
    })();
    return true;
  }

  if (message.type === "CANCEL_JOB") {
    (async () => {
      await chrome.storage.local.remove(["activeFlowJob", "pendingVideoJob"]);
      await chrome.storage.local.set({
        jobProgress: { videoId: message.videoId, current: 0, total: 0, state: "cancelled", at: Date.now() },
      });
      const result = await callApp(`/api/videos/extension/${message.videoId}/cancel`, {
        method: "POST",
      });
      sendResponse(result.ok ? { ok: true } : { ok: false, error: result.error });
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

  if (message.type === "UPLOAD_VIDEO") {
    (async () => {
      try {
        const bytes = base64ToUint8Array(message.base64);
        sendResponse(
          await postClipToApp(
            message.videoId,
            new Blob([bytes as unknown as BlobPart]),
            message.mimeType,
            message.clipIndex ?? 0,
            message.clipTotal ?? 1,
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
      const result = await callApp("/api/products/extension", {
        method: "POST",
        body: JSON.stringify({ products: message.products }),
      });
      sendResponse(result.ok ? { ok: true, ...result.body } : { ok: false, error: result.error });
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
          await postClipToApp(
            message.videoId,
            blob,
            "video/mp4",
            message.clipIndex ?? 0,
            message.clipTotal ?? 1,
          ),
        );
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว" });
      }
    })();
    return true;
  }
});
