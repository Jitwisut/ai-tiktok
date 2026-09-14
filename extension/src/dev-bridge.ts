// Dev-only bridge for localhost test pages. NOT registered in manifest.json by
// default — any localhost page could drive jobs through it. To test, add a
// content_scripts entry { matches: ["http://localhost/*"], js: ["dist/dev-bridge.js"] }
// temporarily, and remove it again before loading the extension for real use.
// Browser automation cannot open or click the side panel — Chrome keeps
// chrome-extension:// pages off-limits to it — so this relays the exact
// messages the side panel sends, letting a local test page drive the whole
// create → Flow → library chain through the real background worker.
// NOTE: shares one global scope with content-scraper.ts, so names are prefixed.

const DEV_BRIDGE_ALLOWED = new Set([
  "GET_CONTENTS",
  "GET_PENDING_JOBS",
  "GET_COMPLETED_VIDEOS",
  "GET_SETTINGS",
  "CREATE_JOB",
  "RUN_BATCH",
  "MERGE_VIDEO",
  "PREPARE_TIKTOK_POST",
  "AUTOPILOT_START",
  "AUTOPILOT_GET_STATE",
  "AUTOPILOT_PAUSE",
  "AUTOPILOT_RESUME",
  "AUTOPILOT_STOP",
  "AUTOPILOT_SKIP_CURRENT",
  "SYNC_TIKTOK_SHOWCASE",
  "GET_TIKTOK_PRODUCTS",
  "RUN_JOB_FROM_POPUP",
  "CANCEL_JOB",
  "DEV_RELOAD_EXTENSION",
]);

const DEV_BRIDGE_STATE_KEYS = ["jobLog", "jobProgress", "jobStatusText", "activeFlowJob", "pendingVideoJob", "videos", "jobQueue", "pendingTikTokPost", "settings", "autopilot"];

function devBridgeReply(id: unknown, response: unknown) {
  window.postMessage({ __aiAffiliateDevResponse: true, id, response }, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as { __aiAffiliateDevRequest?: boolean; id?: unknown; message?: { type?: string } };
  if (data?.__aiAffiliateDevRequest !== true) return;

  const { id, message } = data;

  // After the extension is reloaded, the copy of this script already running
  // in an open localhost tab is orphaned: chrome.* calls then throw
  // synchronously ("Extension context invalidated") instead of rejecting,
  // which surfaced as an uncaught error on chrome://extensions. Answer the
  // page with a normal failure instead.
  const fail = (err: unknown) =>
    devBridgeReply(id, {
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)} — รีเฟรชหน้านี้หลังรีโหลดส่วนขยาย`,
    });
  if (!chrome.runtime?.id) {
    fail("ส่วนขยายถูกโหลดใหม่");
    return;
  }

  try {
    // Read-only view of the job state the side panel renders from storage.
    if (message?.type === "GET_JOB_STATE") {
      chrome.storage.local.get(DEV_BRIDGE_STATE_KEYS).then((state) => devBridgeReply(id, { ok: true, state }), fail);
      return;
    }

    if (!message?.type || !DEV_BRIDGE_ALLOWED.has(message.type)) {
      devBridgeReply(id, { ok: false, error: `message type not allowed: ${message?.type}` });
      return;
    }

    chrome.runtime.sendMessage(message).then((response) => devBridgeReply(id, response), fail);
  } catch (err) {
    fail(err);
  }
});
