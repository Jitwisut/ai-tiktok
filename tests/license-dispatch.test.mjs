import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
let data = { licenseStatus: { ok: true, expiresAt: "2099-01-01" } };
let identity = { installationId: randomUUID(), token: "revoked-token" };
let listener; let requests = 0; let tabEffects = 0; let active = false;
// Only the private licensing vault is needed: a denied action must never open the clip library.
globalThis.indexedDB = { open(name) {
  assert.equal(name, "affiliate-license-vault");
  const request = {};
  queueMicrotask(() => { request.result = { transaction() {
    const tx = { objectStore: () => ({
      get() { const read = {}; queueMicrotask(() => { read.result = identity; read.onsuccess(); }); return read; },
      put(value) { identity = value; queueMicrotask(() => tx.oncomplete()); },
    }) }; return tx;
  } }; request.onsuccess(); });
  return request;
} };
globalThis.chrome = {
  runtime: { id: "extension-test", getURL: path => `chrome-extension://extension-test/${path}`, getManifest: () => ({ content_scripts: [] }), onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: {
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])),
    set: async value => { Object.assign(data, structuredClone(value)); }, remove: async () => {},
  }, onChanged: { addListener() {} } },
  alarms: { onAlarm: { addListener() {} }, clear: async () => {}, create: async () => {} },
  tabs: { query: async () => [], create: async () => { tabEffects++; }, update: async () => { tabEffects++; } },
};
globalThis.fetch = async (url, options) => { requests++; assert.equal(url, "http://localhost:3000/api/licenses/validate"); assert.equal(JSON.parse(options.body).token, "revoked-token"); return active ? Response.json({ ok: true, status: "active", serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }) : Response.json({ ok: false, code: "expired" }, { status: 403 }); };
await import("../extension/src/background.ts");
function dispatch(type, extra = {}, sender = { id: "extension-test", url: "chrome-extension://extension-test/sidepanel.html" }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${type}`)), 1000);
    listener({ type, ...extra }, sender, response => { clearTimeout(timeout); resolve(response); });
  });
}
const paid = ["FETCH_SHOPEE_PRODUCTS", "IMPORT_SHOPEE_PRODUCTS", "ADD_PRODUCT", "RUN_JOB_FROM_POPUP", "ANALYZE_PRODUCT", "GENERATE_CONTENT_SCENES", "CREATE_JOB", "RUN_BATCH", "IMPORT_TIKTOK_PRODUCT_DETAILS", "SYNC_TIKTOK_SHOWCASE", "PREPARE_SHOPEE_POST", "PREPARE_TIKTOK_POST", "CLAIM_SHOPEE_POST", "GET_SHOPEE_POST_FILE", "SHOPEE_TYPE_CAPTION", "SHOPEE_POST_SUBMITTING", "CLAIM_TIKTOK_POST", "GET_TIKTOK_POST_FILE", "TIKTOK_TYPE_CAPTION", "TIKTOK_POST_SUBMITTING", "TRUSTED_CLICK", "IMPORT_TIKTOK_PRODUCTS", "AUTOPILOT_START", "AUTOPILOT_RESUME", "TEST_API_KEY"];
test("every paid direct message validates online and cannot bypass with a modified local status", async () => {
  for (const type of paid) {
    data.licenseStatus = { ok: true, status: "active", expiresAt: "2099-01-01" };
    const result = await dispatch(type);
    assert.equal(result.ok, false, type); assert.equal(result.code, "expired", type);
  }
  assert.equal(requests, paid.length); assert.equal(tabEffects, 0);
  assert.equal(JSON.stringify(data).includes("revoked-token"), false);
});
test("library/catalog reads are available after expiration without a server request", async () => {
  data.products = []; const before = requests;
  const response = await dispatch("GET_TIKTOK_PRODUCTS"); assert.equal(response.ok, true); assert.deepEqual(response.products, []);
  assert.equal(requests, before);
});
test("web content scripts cannot activate keys or initiate durable resume", async () => {
  const sender = { id: "extension-test", url: "https://flow.google.com/project/123", tab: { id: 10 } };
  for (const type of ["LICENSE_ACTIVATE", "LICENSE_RESUME_WORK"]) {
    const before = requests; const result = await dispatch(type, { key: "AAS_should_not_be_forwarded" }, sender);
    assert.equal(result.ok, false); assert.equal(result.error, "not allowed"); assert.equal(requests, before);
  }
});
test("TikTok submission belongs to one task tab, duplicates are denied, and results remain free after expiry", async () => {
  active = true;
  data.videos = [{ id: "post-video", status: "completed", tiktokPost: { status: "ready", at: Date.now() } }];
  data["tiktokPostTab:post-video"] = 10;
  const sender = { id: "extension-test", url: "https://www.tiktok.com/tiktokstudio/upload", tab: { id: 10, url: "https://www.tiktok.com/tiktokstudio/upload" } };
  const wrong = await dispatch("TIKTOK_POST_SUBMITTING", { videoId: "post-video" }, { ...sender, tab: { ...sender.tab, id: 11 } });
  assert.equal(wrong.ok, false);
  const results = await Promise.all([dispatch("TIKTOK_POST_SUBMITTING", { videoId: "post-video" }, sender), dispatch("TIKTOK_POST_SUBMITTING", { videoId: "post-video" }, sender)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(data.videos[0].tiktokPost.status, "submitting");
  active = false; const before = requests;
  const completed = await dispatch("TIKTOK_POST_RESULT", { videoId: "post-video", status: "posted" }, sender);
  assert.equal(completed.ok, true); assert.equal(data.videos[0].tiktokPost.status, "posted"); assert.equal(requests, before);
});
