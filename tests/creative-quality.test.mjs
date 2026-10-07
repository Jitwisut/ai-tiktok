import assert from "node:assert/strict";
import test from "node:test";
import { CONTENT_STYLES, getStylePlaybook, speechBudget } from "../extension/src/lib/style-playbooks.ts";
import { getStylePlaybook as serverPlaybook } from "../src/lib/prompt-engine/style-playbooks.ts";
import { contentIssues, sceneIssues, generateValidated } from "../extension/src/lib/creative-quality.ts";
import { buildContentPrompt, buildScenePrompt, scenePlanExample } from "../extension/src/lib/analysis-prompts.ts";
import { planClips, DEFAULT_VIDEO_SETTINGS, durationOptions, clipSecondsForSite } from "../extension/src/lib/prompt-engine.ts";
import { buildVeoPrompt } from "../src/lib/prompt-engine/prompt-builder.ts";
import { videoSettingsSchema } from "../src/lib/prompt-engine/types.ts";

// Run: node --import tsx --test tests/creative-quality.test.mjs

const product = { id: "test", name: "กระบอกน้ำ", description: "กระบอกน้ำพร้อมฝา", images: [] };
const inputScene = (text, extra = {}) => ({ position: 0, clip: 0, duration: 8, description: "สาธิตสินค้า", visual: "The hands close the lid, then hold the result", dialogue: text, ...extra });
const extensionPrompt = (style, scenes) => planClips({ productName: product.name, style, scenes, targetDuration: 8, settings: DEFAULT_VIDEO_SETTINGS })[0].prompt;
const serverPrompt = (style, scenes) => buildVeoPrompt(product.name, scenes, videoSettingsSchema.parse({ style }));

test("every supported style produces valid scenes and carries its direction through both video builders", () => {
  for (const style of CONTENT_STYLES) {
    const playbook = getStylePlaybook(style);
    assert.deepEqual(playbook, serverPlaybook(style), `${style}: shared rules diverged`);
    const example = scenePlanExample(1, 8, style);
    const script = example.scenes.flatMap((s) => [s.dialogue, s.voiceover]).filter(Boolean).join(" ");
    const content = { style, script, hook: "ภาพเปิด", cta: "ดูที่ตะกร้าได้เลย" };
    assert.deepEqual(sceneIssues(example.scenes, content, 1, 8), [], style);
    const scenes = example.scenes.map((scene, position) => ({ ...scene, position }));
    const text = extensionPrompt(style, scenes);
    const server = serverPrompt(style, scenes);
    for (const prompt of [text, server.text]) {
      assert.ok(prompt.includes(playbook.videoDirection), `${style}: video direction missing`);
      assert.ok(prompt.includes(playbook.soundBed), `${style}: sound missing`);
      assert.ok(!prompt.includes("keep talking through"), `${style}: forced continuous speech`);
    }
    const contentPrompt = buildContentPrompt(product, null, style, 8, 8, false);
    assert.deepEqual(contentIssues(contentPrompt.example.script, style, 8, 8), [], `${style}: misleading script example`);
    const scenePrompt = buildScenePrompt(product, content, 8, 8, false, null);
    assert.ok(scenePrompt.system.includes("สถานะสินค้าหรือมือเมื่อจบ"));
  }
});

test("examples cover every clip and obey budgets for all supported site durations", () => {
  for (const site of ["flow", "aistudio", "gemini", "meta"]) {
    for (const seconds of durationOptions(site)) {
      const perClip = clipSecondsForSite(site, seconds);
      const count = seconds / perClip;
      for (const style of CONTENT_STYLES) {
        const example = scenePlanExample(count, perClip, style);
        const script = example.scenes.flatMap((s) => [s.dialogue, s.voiceover]).filter(Boolean).join(" ");
        assert.deepEqual(sceneIssues(example.scenes, { style, script }, count, perClip), [], `${site}/${seconds}/${style}`);
        const clips = planClips({ productName: product.name, style, scenes: example.scenes.map((s, position) => ({ ...s, position })), targetDuration: seconds, clipSeconds: perClip, settings: DEFAULT_VIDEO_SETTINGS });
        assert.equal(clips.length, count);
      }
    }
  }
});

test("narrative and lifestyle styles are not forced into direct-to-camera seller posing", () => {
  for (const style of ["Storytelling", "Lifestyle Vlog", "Before After", "Comparison"]) {
    for (const prompt of [extensionPrompt(style, [inputScene("ลองดูนะ")]), serverPrompt(style, [inputScene("ลองดูนะ")]).text]) {
      assert.ok(!prompt.includes("holds the product up beside the face"));
      assert.ok(!prompt.includes("facing the camera (turned no more"));
    }
  }
});

test("locked camera styles stay fixed even if the storyboard requests a moving camera", () => {
  for (const style of ["Before After", "Comparison", "ASMR / Satisfying", "Demo", "Educational Tips"]) {
    const scenes = [inputScene("ลองดูนะ", { cameraMotion: "slow push-in" })];
    assert.match(extensionPrompt(style, scenes), /\[CAMERA\].*static locked-off camera/);
    const built = serverPrompt(style, scenes);
    assert.match(built.structured.scenes[0].cameraMotion, /static locked-off camera/);
  }
});

test("ASMR keeps product sounds and suppresses legacy speech in both text and structured output", () => {
  const scenes = [inputScene("ประโยคเก่าที่ไม่ควรพูด", { voiceover: "อีกประโยคเก่า" })];
  const server = serverPrompt("ASMR / Satisfying", scenes);
  for (const prompt of [server.text, extensionPrompt("ASMR / Satisfying", scenes)]) {
    assert.ok(!prompt.includes("ประโยคเก่า"));
    assert.match(prompt, /No dialogue or narration/);
    assert.match(prompt, /no music/);
  }
  assert.equal(server.structured.scenes[0].dialogue, undefined);
  assert.equal(server.structured.scenes[0].voiceover, undefined);
  assert.ok(contentIssues("พูด", "ASMR / Satisfying", 8).length);
});

test("overlong single lines and hook-plus-CTA combinations are rejected without dropping words", () => {
  const max = speechBudget(8, "sell")[1];
  const cases = [
    [inputScene("ก".repeat(max + 1))],
    [inputScene("ก".repeat(35), { duration: 4 }), inputScene("ข".repeat(35), { position: 1, duration: 4 })],
  ];
  for (const scenes of cases) {
    assert.throws(() => extensionPrompt("UGC", scenes), /เกินงบ/);
    assert.throws(() => serverPrompt("UGC", scenes), /เกินงบ/);
  }
  const lines = ["เปิดฝาได้ง่ายนะ", "พกน้ำสะดวกขึ้น", "ดูที่ตะกร้าได้เลย"];
  const scenes = lines.map((line, position) => inputScene(line, { position, duration: 8 / 3 }));
  for (const prompt of [extensionPrompt("UGC", scenes), serverPrompt("UGC", scenes).text]) {
    for (const line of lines) assert.ok(prompt.includes(line), `${line} was dropped`);
  }
});

test("multi-clip scripts must use complete lines that fit an individual clip", () => {
  const long = "ก".repeat(90);
  assert.ok(contentIssues(long, "UGC", 16, 8).length);
  assert.deepEqual(contentIssues(`${"ก".repeat(45)}\n${"ข".repeat(45)}`, "UGC", 16, 8), []);
});

test("scene validation catches missing time, repeated or lost speech and mixed speakers", () => {
  const content = { style: "UGC", script: "ลองดูนะ ดูที่ตะกร้าได้เลย" };
  assert.deepEqual(sceneIssues([inputScene(content.script)], content, 1, 8), []);
  assert.ok(sceneIssues([inputScene(content.script)], content, 2, 8).some((s) => s.includes("ขาดฉาก")));
  assert.ok(sceneIssues([inputScene(content.script, { duration: 3 })], content, 1, 8).some((s) => s.includes("duration")));
  assert.ok(sceneIssues([inputScene("ลองดูนะ")], content, 1, 8).some((s) => s.includes("ตรงกับ script")));
  assert.ok(sceneIssues([inputScene(content.script), inputScene(content.script)], content, 1, 8).some((s) => s.includes("ตรงกับ script")));
  assert.ok(sceneIssues([inputScene("ลองดูนะ", { voiceover: "ดูที่ตะกร้าได้เลย" })], content, 1, 8).some((s) => s.includes("เพียงแบบเดียว")));
});

test("speaker gender changes cannot push an accepted line over its speaking budget", () => {
  const max = speechBudget(8, "sell")[1];
  assert.ok(contentIssues(`${"ก".repeat(max - 4)} ค่ะ`, "UGC", 8).length);
  const script = `${"ก".repeat(max - 6)} ค่ะ`;
  assert.deepEqual(contentIssues(script, "UGC", 8), []);
  for (const presenter of ["male", "female"]) {
    assert.doesNotThrow(() => planClips({ productName: product.name, style: "UGC", scenes: [inputScene(script)], targetDuration: 8, presenter, settings: DEFAULT_VIDEO_SETTINGS }));
  }
});

test("scene order and per-scene speech time are validated before rendering", () => {
  const content = { style: "UGC", script: "ลองดูนะ ดูที่ตะกร้าได้เลย" };
  const reversed = [inputScene("ลองดูนะ", { clip: 1 }), inputScene("ดูที่ตะกร้าได้เลย", { clip: 0 })];
  assert.ok(sceneIssues(reversed, content, 2, 8).some((s) => s.includes("เรียงฉาก")));
  const rushed = [inputScene(content.script, { duration: 1 }), inputScene("", { duration: 7 })];
  assert.ok(sceneIssues(rushed, content, 1, 8).some((s) => s.includes("เวลาฉาก")));
});

test("hands-only styles narrate legacy dialogue consistently in text and structured output", () => {
  const text = "ดูวิธีใช้ตรงนี้นะ";
  const built = serverPrompt("Demo", [inputScene(text)]);
  assert.equal(built.structured.scenes[0].dialogue, undefined);
  assert.equal(built.structured.scenes[0].voiceover, text);
  assert.match(built.text, /off-screen narrator/);
  assert.match(extensionPrompt("Demo", [inputScene(text)]), /off-screen narrator/);
});

test("invalid AI responses are rewritten with feedback before a usable result is returned", async () => {
  let calls = 0;
  const result = await generateValidated(async (repair) => {
    calls++;
    if (!repair) return { script: "ก".repeat(100) };
    assert.equal(repair.previous.script.length, 100);
    assert.ok(repair.issues[0].includes("ไม่เกิน"));
    return { script: "ดูที่ตะกร้าได้เลย" };
  }, (value) => contentIssues(value.script, "UGC", 8));
  assert.equal(calls, 2);
  assert.equal(result.script, "ดูที่ตะกร้าได้เลย");
});

test("persistent invalid responses stop after two rewrites", async () => {
  let calls = 0;
  await assert.rejects(generateValidated(async () => { calls++; return { script: "ก".repeat(100) }; }, (value) => contentIssues(value.script, "UGC", 8)), /หลังแก้สองครั้ง/);
  assert.equal(calls, 3);
});
