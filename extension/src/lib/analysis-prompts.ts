/** Ported from src/services/{analysis,content,scene}.service.ts + src/lib/validation/*.ts — same prompts, hand-written JSON Schema instead of zod (no zod dependency in the extension). */

import type { JsonSchema } from "./gemini.js";
import type { Product, ProductAnalysis, Scene } from "./store.js";

export const CONTENT_STYLES = [
  "UGC",
  "Review",
  "Problem Solution",
  "Storytelling",
  "Before After",
  "Unboxing",
  "Demo",
] as const;

export const PRODUCT_ANALYSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    targetCustomer: { type: "string" },
    painPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
    sellingPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
    angles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
  },
  required: ["targetCustomer", "painPoints", "sellingPoints", "angles"],
};

export const CONTENT_GENERATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hook: { type: "string" },
    script: { type: "string" },
    caption: { type: "string" },
    cta: { type: "string" },
    onScreenText: { type: "string" },
    onScreenCta: { type: "string" },
  },
  required: ["hook", "script", "caption", "cta", "onScreenText", "onScreenCta"],
};

/** Longest overlay Veo is asked to render; the prompt and cleanOnScreenText share these so they cannot drift apart. */
export const ON_SCREEN_HEADLINE_MAX = 12;
export const ON_SCREEN_CTA_MAX = 10;

/** Veo renders long or mixed-script overlay text badly; keep what it's asked to show short and Thai-only. */
export function cleanOnScreenText(text: string | undefined, maxChars: number): string | undefined {
  const cleaned = (text ?? "")
    .replace(/[^\u0E00-\u0E7F0-9\s!?]/g, "") // Thai letters, digits, spaces, ! ?
    .replace(/\s+/g, " ")
    .replace(/\s+([!?])/g, "$1")
    .trim();
  if (!cleaned || !/[\u0E00-\u0E7F]/.test(cleaned)) return undefined;
  return Array.from(cleaned).length <= maxChars ? cleaned : undefined;
}

/** Veo renders at most 8 seconds per generation, so scripts and storyboards are planned in 8-second blocks. */
const BLOCK_SECONDS = 8;

/**
 * Rough Thai speaking budget per 8-second block, in characters (vowel and
 * tone marks included). Leaves room for the visual hook and product beats so
 * Veo is not forced to rush the line.
 */
export const THAI_CHARS_PER_BLOCK = 45;

function blockCount(targetDuration: number): number {
  return Math.max(1, Math.round(targetDuration / BLOCK_SECONDS));
}

/** Rotates through the analysis angles so repeated generations for a product tell different stories. */
export function pickAngle(analysis: ProductAnalysis | null, generationIndex: number): string | undefined {
  const angles = analysis?.angles?.filter((a) => a.trim()) ?? [];
  return angles.length ? angles[generationIndex % angles.length] : undefined;
}

/** Story beats each length has room for — an 8-second video cannot carry a 32-second structure. */
const SCRIPT_STRUCTURE: Record<number, string> = {
  1: "hook สั้นมาก + จุดขายหลัก 1 ข้อ + CTA สั้น",
  2: "hook + จุดขาย/การใช้งาน 2 จังหวะ + CTA",
  3: "hook + ปัญหา/บริบท + สาธิตการใช้งาน + ประโยชน์ + CTA",
  4: "hook + บริบท + สาธิตการใช้งาน + ประโยชน์ 2-3 ข้อ + สรุป + CTA",
};

/** Default speech mode per style; the storyboard may still mix modes where it fits. */
const STYLE_SPEECH_MODE: Record<string, string> = {
  UGC: "ส่วนใหญ่เป็น dialogue (คนในภาพพูดกับกล้องแบบเป็นกันเอง)",
  Review: "dialogue เป็นหลัก แทรก voiceover ได้บางช่วง",
  "Problem Solution": "ผสม dialogue และ voiceover",
  Storytelling: "voiceover เป็นหลัก (เล่าเรื่องจากนอกจอ)",
  "Before After": "voiceover เป็นหลัก",
  Unboxing: "dialogue สั้นๆ แบบรีแอคชั่นระหว่างแกะกล่อง",
  Demo: "voiceover เป็นหลัก หรือพูดน้อยที่สุด",
};

export const SCENE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    castOptions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          person: { type: "string" },
          setting: { type: "string" },
        },
        required: ["person", "setting"],
      },
    },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          clip: { type: "integer", minimum: 0, maximum: 3 },
          duration: { type: "integer", minimum: 1, maximum: 8 },
          description: { type: "string" },
          visual: { type: "string" },
          cameraMotion: { type: "string" },
          dialogue: { type: "string" },
          voiceover: { type: "string" },
        },
        required: ["clip", "duration", "description", "visual", "cameraMotion", "dialogue", "voiceover"],
      },
    },
  },
  required: ["castOptions", "scenes"],
};

export function buildAnalysisPrompt(product: Product, hasImages: boolean) {
  return {
    system: [
      "คุณเป็นนักการตลาดที่เชี่ยวชาญด้าน affiliate marketing วิเคราะห์สินค้าแล้วตอบเป็น JSON ตาม schema เท่านั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปเป็นหลักว่าสินค้าคืออะไร ใช้ทำอะไร เพราะชื่อและรายละเอียดที่ดึงมาจากหน้าเว็บมักไม่ครบหรือคลาดเคลื่อน",
      "ห้ามแต่งสรรพคุณที่ไม่สอดคล้องกับประเภทสินค้าที่เห็นจริง",
      "เชี่ยวชาญ TikTok Shop affiliate marketing ในไทยโดยเฉพาะ เข้าใจว่าคนไทยดูคลิปสั้นแล้วตัดสินใจกดซื้อผ่านตะกร้าเหลืองภายในไม่กี่วินาที",
      "ตอบทุกฟิลด์เป็นภาษาไทยล้วน แม้ชื่อหรือรายละเอียดสินค้าจะเป็นภาษาอังกฤษ",
      "ห้ามเขียน painPoints หรือ sellingPoints ที่เป็นคำกว้างทั่วไปซึ่งใช้ได้กับสินค้าทุกชนิด เช่น \"คุณภาพดี\" \"ราคาคุ้มค่า\" \"ใช้งานง่าย\" — ทุกข้อต้องอ้างอิงรายละเอียดที่จับต้องได้ของสินค้าชิ้นนี้จริงๆ เช่น วัสดุ ขนาด สี ฟีเจอร์ วิธีใช้",
      "angles ให้คิดจากมุมที่คนไทยบน TikTok มักหยุดดูจริง เช่น ปัญหาที่เจอบ่อยในชีวิตประจำวัน, รีวิวแบบจริงใจไม่โอเว่อร์, เปรียบเทียบก่อน-หลัง, unboxing ที่มีจังหวะเซอร์ไพรส์",
      "ห้ามระบุ painPoints, sellingPoints หรือ angles ที่เป็นการอ้างสรรพคุณทางการแพทย์ การรักษาโรค หรือผลลัพธ์ที่รับประกัน 100% แม้ชื่อหรือคำอธิบายสินค้าจะใช้คำเหล่านั้นก็ตาม — ให้ปรับเป็นมุมด้านความรู้สึกหรือประสบการณ์การใช้งานแทน",
    ].join("\n"),
    prompt: [
      hasImages ? "วิเคราะห์สินค้านี้จากรูปที่แนบมา ประกอบกับข้อมูลด้านล่าง:" : "วิเคราะห์สินค้านี้:",
      `ชื่อ: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      `ราคา: ${product.price ?? "-"} ${product.currency ?? ""}`,
    ].join("\n"),
  };
}

export function buildContentPrompt(
  product: Product,
  analysis: ProductAnalysis | null,
  style: string,
  targetDuration: number,
  hasImages: boolean,
  angle?: string,
) {
  const blocks = blockCount(targetDuration);
  const seconds = blocks * BLOCK_SECONDS;
  const speechChars = blocks * THAI_CHARS_PER_BLOCK;

  return {
    system: [
      "คุณเป็นนักเขียนสคริปต์ TikTok affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยที่เป็นธรรมชาติ กระชับ เหมาะกับวิดีโอสั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปว่าสินค้าคืออะไร และพูดถึงประโยชน์ที่ตรงกับสินค้าประเภทนั้นจริงๆ",
      "hook ต้องดึงความสนใจได้ภายใน 1-2 วินาทีแรก เลือกใช้เทคนิคอย่างใดอย่างหนึ่ง: ตั้งคำถามที่กลุ่มเป้าหมายอยากรู้คำตอบ, พูดถึงปัญหาที่เจอบ่อยแบบเจาะจง, หรือประโยคที่ทำให้อยากรู้ว่าเกิดอะไรขึ้นต่อ ห้ามขึ้นต้นด้วยการแนะนำตัวหรือแนะนำสินค้าตรงๆ เช่น \"วันนี้จะมารีวิว...\" \"สวัสดีค่ะวันนี้...\"",
      "script คือคำพูดทั้งหมดที่จะได้ยินในวิดีโอ (ทั้งคนในภาพพูดและเสียงบรรยาย) เรียงตามลำดับเวลา ขึ้นต้นด้วย hook และจบด้วย CTA เขียนแบบพูดปากเปล่า ประโยคสั้น ไม่ใช่บทความ",
      "script ต้องพูดจบได้จริงภายในความยาววิดีโอที่กำหนด โดยไม่ต้องเร่งพูด และเหลือเวลาให้ภาพโชว์สินค้าและรีแอคชั่นด้วย — ห้ามเขียนยาวเกินงบตัวอักษรที่กำหนด",
      "caption ต้องมีโครงสร้าง: บรรทัดแรกเป็น hook สั้นที่ทำให้คนหยุดเลื่อน ตามด้วยจุดขายสั้นๆ 1 ประโยค แล้วปิดท้ายด้วยแฮชแท็ก 4-6 อัน ผสมระหว่างแฮชแท็กกว้าง (หมวดสินค้า) กับแฮชแท็กเจาะจง (ชื่อ/ประเภทสินค้า) ห้ามใช้แฮชแท็กที่ไม่เกี่ยวข้องเพื่อหวังยอดวิว",
      "cta ให้ใช้ภาษาที่คนไทยบน TikTok Shop คุ้นเคย เช่น ชวนกดตะกร้าเหลืองด้านล่าง หรือชวนแชทสอบถาม ห้ามใช้คำที่ฟังดูยัดเยียดหรือเร่งรัดเกินไป",
      "ห้ามเขียน hook, script, caption หรือ cta ที่มีการอ้างสรรพคุณทางการแพทย์ (เช่น รักษาโรค ต้านมะเร็ง ลดความเสี่ยงโรค), การรับประกันผลลัพธ์แบบเกินจริง (เช่น \"ได้ผล 100%\" \"หายขาด\"), หรือถ้อยคำที่อาจถูกมองว่าหลอกลวงผู้บริโภค — เน้นประสบการณ์การใช้งานจริงและความรู้สึกแทนเสมอ",
    ].join("\n"),
    prompt: [
      hasImages ? "รูปสินค้าจริงแนบมา ให้ยึดตามรูป" : "",
      `สร้างคอนเทนต์สไตล์ "${style}" สำหรับสินค้านี้:`,
      `ชื่อสินค้า: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      analysis
        ? [
            `กลุ่มเป้าหมาย: ${analysis.targetCustomer}`,
            `Pain points: ${analysis.painPoints.join(", ")}`,
            `จุดขาย: ${analysis.sellingPoints.join(", ")}`,
          ].join("\n")
        : "",
      angle
        ? `มุมการขายที่เลือก: "${angle}" — สร้าง hook, script และ CTA ทั้งหมดรอบมุมนี้ ห้ามเปลี่ยนไปใช้มุมอื่นกลางคลิป`
        : "",
      `ความยาววิดีโอ: ${seconds} วินาที (${blocks} ช่วง ช่วงละ ${BLOCK_SECONDS} วินาที)`,
      `โครงเรื่องที่เหมาะกับความยาวนี้: ${SCRIPT_STRUCTURE[Math.min(blocks, 4)]}`,
      `งบคำพูด: script รวมทั้งหมดไม่เกินประมาณ ${speechChars} ตัวอักษรไทย (นับสระและวรรณยุกต์ด้วย) หรือไม่เกิน 1-2 ประโยคสั้นต่อ ${BLOCK_SECONDS} วินาที`,
      "ต้องการ hook (ประโยคเปิดที่ดึงดูด), script (บทพูดเต็ม), caption (แคปชันโพสต์), cta (call to action)",
      `และ onScreenText: ข้อความพาดหัวที่กลั่นมาจาก hook หรือจุดขายหลัก ให้เห็นแวบเดียวแล้วเข้าใจทันที ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ — ควรเป็นคำเดียวหรือวลีสั้นมาก ไม่เกิน ${ON_SCREEN_HEADLINE_MAX} ตัวอักษรรวมสระและวรรณยุกต์ (ยิ่งสั้นยิ่งเรนเดอร์เป็นภาษาไทยได้แม่นยำขึ้น) ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น "สบายสุด" "ยืดเยอะ"`,
      `และ onScreenCta: ข้อความชวนกดตะกร้าเหลืองซื้อตอนท้าย ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ ไม่เกิน ${ON_SCREEN_CTA_MAX} ตัวอักษรรวมสระและวรรณยุกต์ ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น "กดเลย" "สั่งเลย"`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export interface ScenePlanContent {
  style: string;
  hook: string;
  script: string;
  cta: string;
  angle?: string;
  onScreenText?: string;
  onScreenCta?: string;
}

export function buildScenePrompt(
  product: Product,
  content: ScenePlanContent,
  targetDuration: number,
  hasImages: boolean,
) {
  const blocks = blockCount(targetDuration);
  const lastBlock = blocks - 1;

  return {
    system: [
      "คุณเป็น storyboard artist สำหรับวิดีโอ TikTok affiliate ตอบเป็น JSON ตาม schema เท่านั้น",
      `โมเดลสร้างวิดีโอเรนเดอร์ได้ครั้งละ ${BLOCK_SECONDS} วินาที วิดีโอจึงถูกสร้างเป็นช่วง (clip) ช่วงละ ${BLOCK_SECONDS} วินาทีแยกกัน แล้วนำมาต่อเป็นวิดีโอเดียว ให้วางแผนฉากตามช่วงเหล่านี้โดยตรง`,
      `แต่ละฉากต้องระบุ clip (เลขช่วงเริ่มจาก 0) และ duration — ฉากใน clip เดียวกันต้องมี duration รวมกันเท่ากับ ${BLOCK_SECONDS} วินาทีพอดี ใช้ 1-3 ฉากต่อ clip`,
      "ภายใน clip เดียวกัน กล้องถ่ายต่อเนื่องเป็นเทคเดียว ไม่มีการตัดภาพ ฉากใน clip เดียวกันคือจังหวะต่อเนื่องของการกระทำ (เช่น หยิบสินค้า → เปิดฝา → ลองใช้) ที่เปลี่ยนระยะภาพได้ด้วยการเคลื่อนกล้องเท่านั้น",
      "ข้าม clip เรื่องต้องเดินหน้า: แต่ละ clip มีการกระทำใหม่ที่ต่างจาก clip ก่อนหน้าชัดเจน ห้ามโชว์สินค้าซ้ำๆ แบบเดิมหรือทำการกระทำเดิมซ้ำ แต่ยังเป็นคนเดิม ชุดเดิม สถานที่เดิม แสงเดิม",
      "clip ที่ไม่ใช่ช่วงสุดท้ายต้องจบด้วยท่าทางหรือการเคลื่อนไหวที่นิ่งและต่อได้ และ clip ถัดไปต้องเริ่มจากท่านั้น",
      "เรียงเรื่องให้เดินหน้า เช่น เห็นปัญหา → หยิบสินค้ามาใช้ → เห็นผลลัพธ์ และใช้การเล่าเรื่องด้วยภาพ ไม่ใช่ให้คนถือสินค้ายื่นเข้ากล้องทุกฉาก",
      "description: สรุปภาพของฉากเป็นภาษาไทยสั้นๆ (ใช้แสดงให้ผู้ใช้ตรวจ)",
      "visual: บรรยายสิ่งที่เห็นในเฟรมเป็นภาษาอังกฤษอย่างเป็นรูปธรรม (ท่าทาง การใช้สินค้า ระยะภาพ) เพราะจะส่งให้โมเดลสร้างวิดีโอโดยตรง ห้ามมีตัวอักษรไทยใน visual — เรียกคนในภาพว่า \"the person\" ห้ามระบุเพศ อายุ หรือหน้าตาใน visual เพราะลุคของคนถูกกำหนดแยกไว้ใน castOptions",
      "cameraMotion: การเคลื่อนกล้องเป็นภาษาอังกฤษสั้นๆ ที่ต่อจากฉากก่อนหน้าอย่างลื่นไหล เช่น \"continue the slow push-in, then tilt down to the product\" ห้ามตัดภาพกระโดด",
      "dialogue: ประโยคภาษาไทยที่คนในภาพพูดในฉากนั้น / voiceover: ประโยคภาษาไทยที่เสียงบรรยายนอกจอพูด — ฉากหนึ่งใช้อย่างใดอย่างหนึ่ง อีกช่องให้เป็นสตริงว่าง หรือว่างทั้งคู่ถ้าเป็นฉากภาพล้วน",
      "นำ script มาแบ่งใส่ dialogue/voiceover ตามลำดับ ใช้คำตามต้นฉบับ ทุกประโยคต้องปรากฏครั้งเดียวเท่านั้น ห้ามตัด hook หรือ CTA ทิ้ง ห้ามแต่งประโยคพูดเพิ่ม",
      `คำพูดต้องพูดจบได้ในเวลาของฉาก: ประมาณไม่เกิน ${Math.round(THAI_CHARS_PER_BLOCK / BLOCK_SECONDS)} ตัวอักษรไทยต่อ 1 วินาที และรวมไม่เกินประมาณ ${THAI_CHARS_PER_BLOCK} ตัวอักษรต่อ clip ห้ามใส่ประโยคยาวในฉาก 1-2 วินาที ถ้าเป็น dialogue ให้เห็นหน้าคนพูดตอนเริ่มพูด`,
      "castOptions: เสนอ 3 ลุคที่ต่างกันชัดเจนสำหรับวิดีโอนี้ เป็นภาษาอังกฤษ แต่ละลุคมี person (เช่น \"Thai woman in her mid-20s, shoulder-length black hair, plain beige oversized T-shirt\" หรือ \"hands only, short clean nails\" ถ้าสินค้าเหมาะกับการถ่ายแค่มือ) และ setting (สถานที่ เวลา ทิศทางแสง เช่น \"bright minimal bedroom desk by a window, late-morning daylight from the left\") ทุกลุคต้องใช้ได้กับทุกฉากที่วางไว้ (ถ้ามีฉากที่มี dialogue หรือเห็นหน้าคน ห้ามเสนอลุคแบบเห็นแค่มือ) และสมเหตุสมผลกับสินค้า ไม่ต้องบรรยายรูปร่างหน้าตาละเอียดเกินจำเป็น",
      "ถ้ามีรูปสินค้าแนบมา ให้บรรยายสินค้าตามหน้าตาจริงในรูป (รูปทรง สี วัสดุ) และให้ฉากเป็นการใช้งานที่สมเหตุสมผลกับสินค้าประเภทนั้นจริงๆ",
      "ห้ามใส่ฉากที่ไม่เข้ากับประเภทสินค้า เช่น ห้ามให้ทาสินค้าที่ไม่ใช่เครื่องสำอางลงบนใบหน้า",
      "ห้ามอธิบายตัวหนังสือ ข้อความ หรือคำบรรยายที่จะปรากฏบนจอไว้ใน description หรือ visual เพราะข้อความบนจอถูกกำหนดแยกต่างหากแล้ว",
      "ห้ามบรรยายฉากที่มีความเสี่ยงถูกโมเดลสร้างวิดีโอปฏิเสธ เช่น การกล่าวอ้างทางการแพทย์แบบภาพ (คนหายป่วย บาดแผลหาย), ความรุนแรง, เครื่องดื่มแอลกอฮอล์, เด็กที่ไม่มีผู้ปกครองอยู่ด้วย หรือฉากที่ดูอันตราย",
    ].join("\n"),
    prompt: [
      hasImages ? "รูปสินค้าจริงแนบมา ให้ยึดตามรูป" : "",
      `สินค้า: ${product.name}`,
      `รายละเอียดสินค้า: ${product.description ?? "-"}`,
      `สไตล์: ${content.style} — โหมดเสียงพูดที่แนะนำ: ${STYLE_SPEECH_MODE[content.style] ?? "เลือกให้เหมาะกับฉาก"}`,
      content.angle ? `มุมการขาย: ${content.angle}` : "",
      `hook: ${content.hook}`,
      `script: ${content.script}`,
      `cta: ${content.cta}`,
      content.onScreenText
        ? `ข้อความพาดหัวบนจอ "${content.onScreenText}" จะขึ้นช่วงต้นของ clip 0 — ให้ฉากแรกของ clip 0 เป็นภาพที่สื่อถึง hook และมีพื้นที่ว่างให้ข้อความ`
        : "ฉากแรกของ clip 0 ต้องเป็นภาพที่สื่อถึง hook ของสคริปต์โดยตรง ให้เห็นแวบแรกแล้วรู้สึกอยากดูต่อ",
      content.onScreenCta ? `ข้อความ CTA บนจอ "${content.onScreenCta}" จะขึ้นช่วงท้ายของ clip ${lastBlock} — ให้ฉากสุดท้ายจบที่สินค้าดูน่าซื้อ` : "",
      `ความยาววิดีโอทั้งหมด: ${blocks * BLOCK_SECONDS} วินาที = ${blocks} clip (clip 0 ถึง clip ${lastBlock}) ต้องมีฉากครบทุก clip`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function toScenePromptInputs(scenes: Scene[]): (Scene & { position: number })[] {
  return scenes.map((scene, position) => ({ position, ...scene }));
}
