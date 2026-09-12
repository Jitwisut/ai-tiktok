const WEB_APP_URL = "http://localhost:3000";
const VEO_MODEL_ID = "veo-3.1-fast-generate-preview";
const CLIP_SECONDS = 8;
const VEO_STUDIO_URL = `https://aistudio.google.com/prompts/new_video?model=${VEO_MODEL_ID}`;

interface AddProductMessage {
  type: "ADD_PRODUCT";
  product: {
    url: string;
    name?: string;
    description?: string;
    price?: string;
    image?: string;
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
}

interface GetPendingVideoJobMessage {
  type: "GET_PENDING_VIDEO_JOB";
}

interface RunJobFromPopupMessage {
  type: "RUN_JOB_FROM_POPUP";
  job: IncomingVideoJob;
  targetDuration?: number;
}

interface UploadVideoMessage {
  type: "UPLOAD_VIDEO";
  videoId: string;
  base64: string;
  mimeType: string;
  clipIndex?: number;
  clipTotal?: number;
}

type ExtensionMessage =
  | AddProductMessage
  | QueueVideoJobMessage
  | GetPendingVideoJobMessage
  | RunJobFromPopupMessage
  | UploadVideoMessage;

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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "ADD_PRODUCT") {
    const params = new URLSearchParams({ source: "extension", sourceUrl: message.product.url });
    if (message.product.name) params.set("name", message.product.name);
    if (message.product.description) params.set("description", message.product.description);
    if (message.product.price) params.set("price", message.product.price);
    if (message.product.image) params.set("image", message.product.image);

    chrome.tabs.create({ url: `${WEB_APP_URL}/products/new?${params.toString()}` });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "QUEUE_EXTENSION_VIDEO_JOB") {
    (async () => {
      const job = await buildJob(message.job);
      chrome.storage.local.set({ pendingVideoJob: job }, () => {
        chrome.tabs.create({ url: VEO_STUDIO_URL });
        sendResponse({ ok: true });
      });
    })();
    return true;
  }

  if (message.type === "RUN_JOB_FROM_POPUP") {
    (async () => {
      const job = await buildJob(message.job, message.targetDuration);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Already on AI Studio: drive that tab directly so the user never
      // leaves the page they are looking at.
      if (tab?.id && (tab.url ?? "").includes("aistudio.google.com")) {
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { type: "RUN_VIDEO_JOB", job });
          sendResponse(result ?? { ok: true });
        } catch {
          sendResponse({ ok: false, error: "รีเฟรชหน้า AI Studio ก่อนแล้วลองใหม่" });
        }
        return;
      }

      chrome.storage.local.set({ pendingVideoJob: job }, () => {
        chrome.tabs.create({ url: VEO_STUDIO_URL });
        sendResponse({ ok: true });
      });
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
      const { appBaseUrl, extensionToken } = await getExtensionConfig();
      if (!extensionToken) {
        sendResponse({ ok: false, error: "ยังไม่ได้ตั้งค่า Extension Token ใน Options" });
        return;
      }

      try {
        const bytes = base64ToUint8Array(message.base64);
        const query = `?clip=${message.clipIndex ?? 0}&total=${message.clipTotal ?? 1}`;
        const res = await fetch(`${appBaseUrl}/api/videos/${message.videoId}/upload${query}`, {
          method: "POST",
          headers: {
            "Content-Type": message.mimeType,
            "X-Extension-Token": extensionToken,
          },
          body: new Blob([bytes as unknown as BlobPart]),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          sendResponse({ ok: false, error: body.error ?? `อัปโหลดล้มเหลว (${res.status})` });
          return;
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "อัปโหลดล้มเหลว" });
      }
    })();
    return true;
  }
});
