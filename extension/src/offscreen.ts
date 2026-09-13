// Offscreen document: the service worker has no URL.createObjectURL, and a
// data: URL of a joined video is too large to hand to chrome.downloads, so
// this page turns a library clip into a blob: URL the worker can download.

import { getClipsForVideo } from "./lib/library.js";

const BLOB_URL_TTL_MS = 5 * 60_000;

chrome.runtime.onMessage.addListener((message: { type?: string; videoId?: string; index?: number }, _sender, sendResponse) => {
  if (message.type !== "OFFSCREEN_CLIP_BLOB_URL" || !message.videoId) return;
  (async () => {
    const clip = (await getClipsForVideo(message.videoId!)).find((c) => c.index === message.index);
    if (!clip) {
      sendResponse({ ok: false, error: "ไม่พบไฟล์ในคลัง" });
      return;
    }
    const url = URL.createObjectURL(clip.blob);
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
    sendResponse({ ok: true, url });
  })().catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});
