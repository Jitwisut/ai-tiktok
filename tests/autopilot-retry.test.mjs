import test from "node:test";
import assert from "node:assert/strict";
import { createAutopilot } from "../extension/src/lib/autopilot.ts";

// The history's "ลองใหม่" button: a failed item goes back to the queue and
// keeps the script and scenes it already has.
let data = {}; let effects = []; let contentGate = null;
globalThis.chrome = {
  storage: { local: {
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])),
    set: async value => { Object.assign(data, structuredClone(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  }, onChanged: { addListener() {} } },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
  tabs: { remove: async () => {} },
};
const settings = { site: "flow", platform: "tiktok", textSource: "api", targetDuration: 8, style: "UGC", postMode: "none" };
const failedAt = Date.now() - 60_000;
function setup(status = "idle", videoStatus = "failed", tweak = () => {}) {
  data = {
    products: [{ id: "p", name: "สินค้า" }],
    videos: [{ id: "v", contentId: "c", status: videoStatus, clips: [], clipsReceived: 0 }],
    contents: [{ id: "c", productId: "p", caption: "แคปชัน" }],
    autopilot: {
      status, mode: "batch", settings, times: [], productIds: [], poolIndex: 0, styleIndex: 0, current: null,
      startedAt: Date.now() - 120_000, consecutiveFailures: 0, nextRunAt: null, message: null, retryRound: true,
      history: [{ platform: "tiktok", productId: "p", productName: "สินค้า", videoId: "v", contentId: "c", status: "failed", error: "สร้างวิดีโอ: หาไฟล์ไม่เจอ", style: "Demo", at: failedAt }],
    },
  };
  effects = [];
  tweak(data);
  return createAutopilot({
    requireLicense: async () => {},
    analyzeProduct: async () => { effects.push("analyze"); },
    generateContentScenes: async (productId, style, d, site, source, resumeContentId) => {
      effects.push(`content:${style}:${resumeContentId}`);
      if (contentGate) await contentGate;
      return { content: { id: resumeContentId ?? "new", caption: "แคปชัน" } };
    },
    startVideo: async () => { effects.push("render"); data.videos.push({ id: "v2", contentId: "c", status: "completed", clips: [], clipsReceived: 0 }); return "v2"; },
    prepareTikTokPost: async () => ({ ok: true }),
    prepareShopeePost: async () => ({ ok: true }),
    isManualJobRunning: async () => false,
    resumeVideo: async () => {},
    resumePost: async () => {},
  });
}
const flush = async pilot => { for (let n = 0; n < 6; n++) { await new Promise(r => setImmediate(r)); await pilot.tick(); } };
const retry = pilot => pilot.handleMessage({ type: "AUTOPILOT_RETRY", productId: "p", at: failedAt });

test("retrying a finished run's failed item reuses its script, renders once, then goes back to idle", async () => {
  const pilot = setup();
  const result = await retry(pilot);
  assert.equal(result.ok, true);
  assert.equal(data.autopilot.history[0].retried, true);
  await flush(pilot);
  assert.ok(effects.includes("content:Demo:c"), `script and style kept: ${effects}`);
  assert.equal(effects.filter((e) => e === "render").length, 1);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.equal(data.autopilot.status, "idle", "the old queue is not restarted");
  assert.equal(data.autopilot.retryOnly, false);
});

test("a failed video that completed late is adopted instead of rendering again", async () => {
  const pilot = setup("idle", "completed");
  await retry(pilot);
  await flush(pilot);
  assert.deepEqual(effects, []);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.equal(data.autopilot.history[0].videoId, "v");
});

test("a retry is queued once, and stopping drops it so the row can be retried again", async () => {
  const pilot = setup("paused");
  await retry(pilot);
  assert.equal((await retry(pilot)).ok, false);
  assert.equal(data.autopilot.retries.length, 1);
  assert.equal(data.autopilot.status, "paused");
  await pilot.handleMessage({ type: "AUTOPILOT_STOP" });
  assert.deepEqual(data.autopilot.retries, []);
  assert.equal(data.autopilot.history[0].retried, false);
});

test("a retry pressed while another product is mid-step is not overwritten when that step saves", async () => {
  let release; contentGate = new Promise((r) => { release = r; });
  // The pilot starts working on "q" as soon as it is created.
  const pilot = setup("running", "failed", (d) => {
    d.products.push({ id: "q", name: "อีกชิ้น" });
    // The failed row is from an earlier run, so this run does not retry it on its own.
    Object.assign(d.autopilot, { productIds: ["q"], retryRound: false, startedAt: Date.now() - 1000 });
  });
  for (let n = 0; n < 200 && !effects.some((e) => e.startsWith("content")); n++) await new Promise((r) => setImmediate(r));
  assert.ok(effects.some((e) => e.startsWith("content")), `the step is waiting on the chat app: ${effects}`);
  assert.equal((await retry(pilot)).ok, true);
  release(); contentGate = null;
  await flush(pilot);
  const stored = data.autopilot;
  const row = stored.history.find((h) => h.productId === "p" && h.at === failedAt);
  assert.equal(row.retried, true, "row stays marked");
  assert.ok(stored.retries.length === 1 || effects.includes("content:Demo:c"), `retry kept or already run: ${effects}`);
});

test("rows saved before the script id was kept find it through their video; other platforms are refused", async () => {
  const pilot = setup();
  delete data.autopilot.history[0].contentId;
  await retry(pilot);
  assert.equal(data.autopilot.retries?.[0]?.contentId ?? data.autopilot.history[0].contentId, "c");

  const other = setup();
  data.autopilot.history[0].platform = "shopee";
  assert.equal((await retry(other)).ok, false);
});
