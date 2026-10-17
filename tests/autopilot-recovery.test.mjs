import test from "node:test";
import assert from "node:assert/strict";
import { createAutopilot } from "../extension/src/lib/autopilot.ts";

// Recovery paths: a video reported failed that completes anyway, and the
// extra pass over a run's failed items.
let data = {}; let effects = [];
globalThis.chrome = {
  storage: { local: {
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])),
    set: async value => { Object.assign(data, structuredClone(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  }, onChanged: { addListener() {} } },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
  tabs: { remove: async () => {} },
};
const settings = { site: "meta", platform: "tiktok", textSource: "api", targetDuration: 10, style: "UGC", postMode: "none" };
function setup(current, extra = {}) {
  data = {
    products: [{ id: "p", name: "สินค้า" }],
    videos: [{ id: "v", contentId: "c", status: "processing", clips: [], clipsReceived: 0 }],
    contents: [{ id: "c", productId: "p", caption: "แคปชัน" }],
    autopilot: {
      status: "running", mode: "batch", settings, times: [], productIds: [], poolIndex: 0, styleIndex: 0, history: [],
      startedAt: Date.now() - 1000, consecutiveFailures: 0, nextRunAt: null, message: null,
      current: current && { productId: "p", productName: "สินค้า", step: "video", leaseUntil: 0, attempts: 0, stepStartedAt: Date.now(), videoId: "v", contentId: "c", ...current },
      ...extra,
    },
  };
  effects = [];
  return createAutopilot({
    requireLicense: async () => {},
    analyzeProduct: async () => { effects.push("analyze"); },
    generateContentScenes: async () => { effects.push("content"); return { content: { id: "c", caption: "แคปชัน" } }; },
    startVideo: async () => { effects.push("render"); return "v2"; },
    prepareTikTokPost: async () => { effects.push("post"); return { ok: true }; },
    prepareShopeePost: async () => { effects.push("post"); return { ok: true }; },
    isManualJobRunning: async () => false,
    resumeVideo: async () => {},
    resumePost: async () => {},
  });
}
const flush = async pilot => { for (let n = 0; n < 5; n++) { await new Promise(r => setImmediate(r)); await pilot.tick(); } };

test("a video reported failed that completes within the grace counts as made", async () => {
  const pilot = setup({});
  data.jobProgress = { videoId: "v", state: "failed", error: "Meta AI ขัดข้อง" };
  await flush(pilot);
  assert.equal(data.autopilot.current.step, "video");
  assert.equal(data.autopilot.current.attempts, 0, "no failure counted inside the grace");
  assert.ok(data.autopilot.current.failedSeenAt);

  data.videos[0].status = "completed";
  await flush(pilot);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.deepEqual(effects, [], "nothing re-rendered");
});

test("after the grace the step fails, and a late completion of that video is adopted instead of re-rendering", async () => {
  const pilot = setup({ failedSeenAt: Date.now() - 4 * 60_000 });
  data.jobProgress = { videoId: "v", state: "failed", error: "Meta AI ขัดข้อง" };
  await flush(pilot);
  assert.equal(data.autopilot.current.attempts, 1);
  assert.equal(data.autopilot.current.videoId, undefined);
  assert.deepEqual(data.autopilot.current.earlierVideoIds, ["v"]);

  // Meta delivered after all, during the retry backoff.
  data.videos[0].status = "completed";
  data.autopilot.current.leaseUntil = 0;
  await flush(pilot);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.equal(data.autopilot.history[0].videoId, "v");
  assert.ok(!effects.includes("render"), "the late video was reused");
});

test("batch mode goes back once over failed items before stopping", async () => {
  const pilot = setup({ attempts: 1, failedSeenAt: Date.now() - 4 * 60_000 });
  data.videos[0].status = "failed";
  await flush(pilot);
  const failed = data.autopilot.history.find(h => h.status === "failed");
  assert.ok(failed, "first attempt round recorded the failure");
  assert.equal(data.autopilot.retryRound, true);
  assert.equal(data.autopilot.current?.productId, "p", "the failed product is being redone");
  assert.ok(effects.includes("analyze"));
});

test("retry round reuses a failed item's video that completed late, without a new script or render", async () => {
  const pilot = setup(null, {
    history: [{ productId: "p", productName: "สินค้า", status: "failed", videoId: "v2", otherVideoIds: ["v"], error: "x", style: "UGC", at: Date.now() }],
  });
  data.videos[0].status = "completed";
  await flush(pilot);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.equal(data.autopilot.history[0].videoId, "v");
  assert.deepEqual(effects, []);
  assert.equal(data.autopilot.status, "idle");
  assert.match(data.autopilot.message, /สำเร็จ 1 ชิ้น, ไม่สำเร็จ 0 ชิ้น/);
});

test("retry round happens only once", async () => {
  const pilot = setup(null, {
    retryRound: true,
    history: [{ productId: "p", productName: "สินค้า", status: "failed", videoId: "v", error: "x", style: "UGC", at: Date.now() }],
  });
  await flush(pilot);
  assert.equal(data.autopilot.status, "idle");
  assert.deepEqual(effects, []);
  assert.match(data.autopilot.message, /ไม่สำเร็จ 1 ชิ้น/);
});
