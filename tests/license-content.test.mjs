import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ExtensionLicenseError, isLicenseFailure } from "../extension/src/lib/license-client.ts";

// Execute the actual automation functions with provider/UI boundaries stubbed.
function load(file, name, globals) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../extension/src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(found, name);
  const context = vm.createContext({ Error, ...globals });
  vm.runInContext(ts.transpileModule(found.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context[name];
}
const denial = () => { throw new Error("สิทธิ์ใช้งาน: หมดอายุ"); };
const job = { videoId: "v", modelId: "veo", clips: [{ index: 0 }, { index: 1 }], caption: "", productId: null };
for (const provider of ["flow", "gemini", "studio"]) {
  test(`${provider}: an already submitted clip is saved after expiry, next clip pauses, reload preserves index`, async () => {
    let granted = true; let nextIndex = 0; let renders = 0; let uploads = 0; let cleared = false;
    const guard = async () => { if (!granted) denial(); };
    const generate = async () => { renders++; granted = false; return provider === "gemini" ? { src: "clip" } : "clip"; };
    const upload = async () => { uploads++; return { ok: true }; };
    const save = async (_job, index) => { nextIndex = index; };
    const common = { extensionRequireLicense: guard };
    const globals = provider === "flow" ? {
      ...common, flowIsCancelled: () => false, flowShowBanner() {}, flowReportProgress() {},
      flowClearActiveJob: async () => { cleared = true; }, flowGenerateClip: generate, flowUploadClip: upload, flowSaveActiveJob: save,
    } : provider === "gemini" ? {
      ...common, geminiCancelled: false, geminiShowBanner() {}, geminiReportProgress() {},
      geminiClearActiveJob: async () => { cleared = true; }, geminiGenerateClip: generate, geminiUploadClip: upload, geminiSaveActiveJob: save,
    } : {
      ...common, studioCancelled: false, findStopButton: () => false, ensureModelSelected: async () => true,
      showBanner() {}, reportProgress() {}, generateClip: generate, uploadClip: upload, captureLastFrame: async () => null,
      chrome: { storage: { local: { set: async data => { nextIndex = data.activeStudioJob.nextClipIndex; }, remove: async () => { cleared = true; } } } },
    };
    const file = provider === "studio" ? "ai-studio-automation.ts" : `${provider}-automation.ts`;
    const name = provider === "studio" ? "runJob" : `${provider}RunJob`;
    await assert.rejects(load(file, name, globals)(job, 0), /สิทธิ์ใช้งาน:/);
    assert.equal(renders, 1); assert.equal(uploads, 1); assert.equal(nextIndex, 1); assert.equal(cleared, false);
    // A fresh context represents a reloaded provider tab while still expired.
    await assert.rejects(load(file, name, globals)(job, nextIndex), /สิทธิ์ใช้งาน:/);
    assert.equal(renders, 1); assert.equal(uploads, 1);
  });
}
for (const [file, name] of [["gemini-automation.ts", "geminiSubmit"], ["meta-automation.ts", "metaSubmit"], ["tiktok-upload.ts", "ttRunPost"]]) {
  test(`${name} rejects direct provider submission when online validation denies it`, async () => {
    await assert.rejects(load(file, name, { extensionRequireLicense: async () => denial() })(job), /สิทธิ์ใช้งาน:/);
  });
}
test("Shopee direct preparation reports a license pause without upload or failed-job result", async () => {
  let pauses = 0;
  const run = load("shopee-upload.ts", "spRun", {
    extensionRequireLicense: async () => denial(),
    extensionReportLicensePause: async (id, error) => { assert.equal(id, "v"); assert.match(error.message, /สิทธิ์ใช้งาน:/); pauses++; return true; },
    spStatus() {}, spSend: async () => assert.fail("expired preparation must not read video or report failure"),
  });
  await run(job); assert.equal(pauses, 1);
});
test("ChatGPT send cannot be initiated directly when license expires after prompt preparation", async () => {
  let clicks = 0;
  const run = load("chatgpt-automation.ts", "run", {
    running: false, waitFor: async read => read(), composer: () => ({}), writePrompt: async () => true,
    assistantMessages: () => [], userMessageCount: () => 0, sendButton: () => ({ click: () => { clicks++; } }),
    extensionRequireLicense: async () => denial(),
  });
  const result = await run({ prompt: "test" }); assert.equal(result.ok, false); assert.match(result.error, /สิทธิ์ใช้งาน:/); assert.equal(clicks, 0);
});
test("Batch expiry after selecting the next video preserves that video and the remaining queue", async () => {
  let queue = { current: "finished", pending: [{ videoId: "next", site: "flow" }, { videoId: "last", site: "flow" }] };
  let progress;
  const advance = load("background.ts", "advanceJobQueue", {
    queueAdvancing: false, QUEUE_START_DELAY_MS: 0, QUEUE_BUSY_RETRIES: 1,
    getJobQueue: async () => structuredClone(queue), setJobQueue: async value => { queue = structuredClone(value); },
    requireLicense: async () => {}, sleep: async () => {}, jobFromStore: async () => ({ videoId: "next" }),
    dispatchJob: async () => { throw new ExtensionLicenseError("expired"); }, isLicenseFailure,
    store: { getVideo: async id => ({ id, status: "queued", clipsReceived: 0, clips: [{ index: 0 }] }), updateVideoJob: async () => assert.fail("must not fail the queued video") },
    chrome: { storage: { local: { set: async value => { if (value.jobProgress) progress = value.jobProgress; } } } },
  });
  await advance("finished");
  assert.equal(queue.current, "next"); assert.equal(queue.pending[0].videoId, "last");
  assert.equal(progress.videoId, "next"); assert.equal(progress.state, "paused");
});
