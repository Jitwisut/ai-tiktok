/** Standalone copy of src/lib/prompt-engine/creative-quality.ts for the Chrome extension build. */
import { getStylePlaybook, speechBudget, speechBudgetUsage } from "./style-playbooks.js";

export interface CreativeContent {
  style: string;
  script: string;
}

export interface CreativeScene {
  clip?: number;
  duration: number;
  dialogue?: string | null;
  voiceover?: string | null;
}

export function contentIssues(script: string, style: string, seconds: number, clipSeconds = seconds): string[] {
  const speech = getStylePlaybook(style).speech;
  const max = speechBudget(seconds, speech)[1];
  if (speechBudgetUsage(script) > max) return [`script ใช้งบ ${speechBudgetUsage(script)} ตัวอักษรรวมเผื่อคำลงท้าย ต้องไม่เกิน ${max} ตัวอักษร เขียนใหม่ให้ครบความโดยลดจุดขาย ห้ามตัดกลางประโยค`];
  if (!script.trim() && speech !== "silent" && speech !== "light") return ["script ต้องมีบทพูดที่ครบความตามสไตล์"];
  const lines = script.split("\n").map((line) => line.trim()).filter(Boolean);
  const perClip = speechBudget(clipSeconds, speech)[1];
  if (lines.length > Math.ceil(seconds / clipSeconds) || lines.some((line) => speechBudgetUsage(line) > perClip)) {
    return [`แบ่ง script เป็นไม่เกิน ${Math.ceil(seconds / clipSeconds)} บรรทัดตาม clip แต่ละบรรทัดไม่เกิน ${perClip} ตัวอักษร เขียนแต่ละบรรทัดเป็นประโยคครบความ ไม่ตัดประโยคข้าม clip`];
  }
  return [];
}

const spokenText = (text: string) => text.replace(/[^\u0E00-\u0E7FA-Za-z0-9]/g, "");

/** Check the actual clip allocation before saving or spending video credits. */
export function sceneIssues(scenes: CreativeScene[], content: CreativeContent, clipCount: number, clipSeconds: number): string[] {
  const issues: string[] = [];
  const playbook = getStylePlaybook(content.style);
  const max = speechBudget(clipSeconds, playbook.speech)[1];
  if (scenes.some((scene) => !Number.isInteger(scene.clip) || scene.clip! < 0 || scene.clip! >= clipCount)) {
    issues.push(`clip ต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง ${clipCount - 1}`);
  }
  if (scenes.some((scene, i) => i > 0 && scene.clip! < scenes[i - 1].clip!)) issues.push("เรียงฉากตามเลข clip และลำดับการกระทำ ห้ามส่ง clip หลังมาก่อน clip แรก");
  for (let clip = 0; clip < clipCount; clip++) {
    const group = scenes.filter((scene) => scene.clip === clip);
    if (!group.length) { issues.push(`ขาดฉาก clip ${clip}`); continue; }
    if (group.length > (clipSeconds > 10 ? 4 : 2)) issues.push(`clip ${clip} มีจังหวะภาพมากเกินไป ใช้ไม่เกิน ${clipSeconds > 10 ? 4 : 2} ฉาก เน้นการกระทำหลักหนึ่งอย่าง`);
    if (group.some((scene) => !Number.isFinite(scene.duration) || scene.duration <= 0) || group.reduce((sum, scene) => sum + scene.duration, 0) !== clipSeconds) {
      issues.push(`duration ใน clip ${clip} ต้องเป็นบวกและรวม ${clipSeconds} วินาทีพอดี`);
    }
    const words = group.flatMap((scene) => [scene.dialogue?.trim(), scene.voiceover?.trim()]).filter(Boolean).join(" ");
    if (speechBudgetUsage(words) > max) issues.push(`คำพูด clip ${clip} ใช้งบ ${speechBudgetUsage(words)} ตัวอักษรรวมเผื่อคำลงท้าย ต้องไม่เกิน ${max} จัดประโยคลง clip ใหม่โดยรักษา script ครบ`);
    if (group.some((scene) => speechBudgetUsage([scene.dialogue, scene.voiceover].filter(Boolean).join(" ")) > speechBudget(scene.duration, playbook.speech)[1])) issues.push(`คำพูดบางฉากใน clip ${clip} ยาวเกินเวลาฉาก จัด duration หรือแบ่งประโยคใหม่ให้ครบความโดยรักษา script ครบ`);
    if (group.some((scene) => scene.dialogue?.trim()) && group.some((scene) => scene.voiceover?.trim())) issues.push(`clip ${clip} ใช้ dialogue หรือ voiceover เพียงแบบเดียว`);
  }
  if (playbook.presenter === "hands" && scenes.some((scene) => scene.dialogue?.trim())) issues.push("สไตล์เห็นเฉพาะมือใช้ voiceover เท่านั้น ห้ามมี dialogue");
  const actual = scenes.flatMap((scene) => [scene.dialogue ?? "", scene.voiceover ?? ""]).join(" ");
  if (spokenText(actual) !== spokenText(content.script)) issues.push("คำพูดรวมทุกฉากต้องตรงกับ script ตามลำดับ ครบทุกประโยค ไม่ซ้ำ ไม่เพิ่ม และไม่ตัดคำพูดทิ้ง");
  return issues;
}

/** Rewrites are bounded; persistent failures stop before video generation. */
export async function generateValidated<T>(
  generate: (repair?: { previous: T; issues: string[] }) => Promise<T>,
  validate: (result: T) => string[],
): Promise<T> {
  let repair: { previous: T; issues: string[] } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await generate(repair);
    const issues = validate(result);
    if (!issues.length) return result;
    repair = { previous: result, issues };
  }
  throw new Error(`AI ยังวางบทหรือฉากไม่พอดีหลังแก้สองครั้ง: ${repair!.issues.join("; ")}`);
}

export function creativeRepairPrompt<T>(repair: { previous: T; issues: string[] }): string {
  return `\nแก้คำตอบก่อนหน้าให้ผ่านเงื่อนไขต่อไปนี้ โดยยังยึดสินค้าและสไตล์เดิม:\n${repair.issues.map((issue) => `- ${issue}`).join("\n")}\nคำตอบก่อนหน้า:\n${JSON.stringify(repair.previous)}\nส่ง JSON คำตอบใหม่ครบทุกฟิลด์เพียงชุดเดียว`;
}
