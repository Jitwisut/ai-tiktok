import test from "node:test";
import assert from "node:assert/strict";
import { createAutopilot } from "../extension/src/lib/autopilot.ts";
import { ExtensionLicenseError } from "../extension/src/lib/license-client.ts";
let data = {}; let granted = false; let effects = []; let alarms = [];
globalThis.chrome = {
  storage: { local: {
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])),
    set: async value => { Object.assign(data, structuredClone(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  }, onChanged: { addListener() {} } },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
  tabs: { remove: async () => {} },
};
const settings = { site: "flow", platform: "tiktok", textSource: "api", targetDuration: 8, style: "rotate", postMode: "none" };
function setup(step = "analyze", overrides = {}, current = {}) {
  data = { products: [{ id: "p", name: "สินค้า" }, { id: "next-product", name: "สินค้าถัดไป" }], videos: [{ id: "v", status: "processing" }], autopilot: {
    status: "running", mode: "batch", settings, times: [], productIds: ["next-product"], poolIndex: 0, styleIndex: 0, history: [], startedAt: Date.now(), consecutiveFailures: 0,
    current: { productId: "p", productName: "สินค้า", step, leaseUntil: 0, attempts: 0, stepStartedAt: Date.now(), ...(step === "video" ? { videoId: "v" } : {}), ...current },
  } };
  effects = []; alarms = []; granted = false;
  return createAutopilot({
    requireLicense: async () => { if (!granted) throw new ExtensionLicenseError("expired"); },
    analyzeProduct: async () => { effects.push("analyze"); },
    generateContentScenes: async () => { effects.push("content"); return { content: { id: "c", caption: "caption" } }; },
    startVideo: async () => { effects.push("render"); return "v"; },
    prepareTikTokPost: async () => { effects.push("post"); return { ok: true }; },
    prepareShopeePost: async () => { effects.push("post"); return { ok: true }; },
    isManualJobRunning: async () => false,
    resumeVideo: async () => { effects.push("resume-video"); data.jobProgress = { videoId: "v", state: "generating" }; },
    resumePost: async () => { effects.push("resume-post"); },
    ...overrides,
  });
}
const flush = async pilot => { for (let n = 0; n < 5; n++) { await new Promise(r => setImmediate(r)); await pilot.tick(); } };
test("expired scheduled/resumed worker pauses without failing, skipping or starting the next step", async () => {
  const pilot = setup(); await flush(pilot);
  assert.equal(data.autopilot.status, "paused"); assert.equal(data.autopilot.current.step, "analyze");
  assert.equal(data.autopilot.current.attempts, 0); assert.deepEqual(data.autopilot.productIds, ["next-product"]);
  assert.deepEqual(effects, []); assert.deepEqual(data.autopilot.history, []);
  await assert.rejects(pilot.handleMessage({ type: "AUTOPILOT_RESUME" }), { code: "expired" });
  assert.equal(data.autopilot.status, "paused");
  await pilot.handleMessage({ type: "AUTOPILOT_STOP" }); assert.equal(data.autopilot.status, "idle");
});
test("expiry between post validation and preparation keeps the post retryable on resume", async () => {
  let checks = 0;
  const pilot = setup("post", {
    requireLicense: async () => { checks++; },
    prepareTikTokPost: async () => { throw new ExtensionLicenseError("expired"); },
  });
  data.autopilot.current.videoId = "v";
  await flush(pilot);
  assert.equal(data.autopilot.status, "paused");
  assert.equal(data.autopilot.current.postRequestedAt, undefined);
  assert.equal(data.autopilot.current.attempts, 0);
  assert.ok(checks > 0);
});
test("TikTok submission timeout pauses instead of automatically retrying publication", async () => {
  const pilot = setup("post", {}, { videoId: "v", postRequestedAt: Date.now() - 60 * 60 * 1000 });
  data.videos[0].tiktokPost = { status: "submitting", at: Date.now() - 60 * 60 * 1000 };
  await flush(pilot);
  assert.equal(data.autopilot.status, "paused");
  assert.equal(data.videos[0].tiktokPost.status, "uncertain");
  assert.equal(data.autopilot.current.attempts, 0);
  assert.deepEqual(effects, []);
});
test("expiry while video is submitted still collects completion but blocks next product", async () => {
  const pilot = setup("video"); await flush(pilot); assert.equal(data.autopilot.status, "running");
  data.videos[0].status = "completed"; await flush(pilot);
  assert.equal(data.autopilot.history[0].status, "made");
  assert.equal(data.autopilot.current.productId, "next-product");
  assert.equal(data.autopilot.status, "paused");
  assert.deepEqual(effects, []);
});
test("partial multi-clip video stays attached to current item and resumes explicitly", async () => {
  const pilot = setup("video"); data.jobProgress = { videoId: "v", state: "paused", error: "สิทธิ์ใช้งาน: หมดอายุ" };
  await flush(pilot); assert.equal(data.autopilot.status, "paused"); assert.equal(data.autopilot.current.videoId, "v");
  granted = true; await pilot.handleMessage({ type: "AUTOPILOT_RESUME" }); await flush(pilot);
  assert.deepEqual(effects, ["resume-video"]); assert.equal(data.autopilot.current.videoId, "v");
  assert.equal(data.autopilot.status, "running");
});
test("direct start requires online validation even before writing run state", async () => {
  const pilot = setup(); await flush(pilot); await pilot.handleMessage({ type: "AUTOPILOT_STOP" });
  await assert.rejects(pilot.handleMessage({ type: "AUTOPILOT_START", settings, productIds: ["p"] }), { code: "expired" });
  assert.equal(data.autopilot.status, "idle"); assert.deepEqual(effects, []);
});
