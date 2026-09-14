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

/** Veo renders long or mixed-script overlay text badly; keep what it's asked to show short and Thai-only. */
export function cleanOnScreenText(text: string | undefined, maxChars: number): string | undefined {
  const cleaned = (text ?? "")
    .replace(/[^฀-๿0-9\s!?]/g, "") // Thai letters, digits, spaces, ! ?
    .replace(/\s+/g, " ")
    .replace(/\s+([!?])/g, "$1")
    .trim();
  if (!cleaned || !/[฀-๿]/.test(cleaned)) return undefined;
  return Array.from(cleaned).length <= maxChars ? cleaned : undefined;
}

export const SCENE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          duration: { type: "integer", minimum: 1, maximum: 15 },
          description: { type: "string" },
          cameraMotion: { type: "string" },
        },
        required: ["duration", "description", "cameraMotion"],
      },
    },
  },
  required: ["scenes"],
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

export function buildContentPrompt(product: Product, analysis: ProductAnalysis | null, style: string, hasImages: boolean) {
  return {
    system: [
      "คุณเป็นนักเขียนสคริปต์ TikTok affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยที่เป็นธรรมชาติ กระชับ เหมาะกับวิดีโอสั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปว่าสินค้าคืออะไร และพูดถึงประโยชน์ที่ตรงกับสินค้าประเภทนั้นจริงๆ",
      "hook ต้องดึงความสนใจได้ภายใน 1-2 วินาทีแรก เลือกใช้เทคนิคอย่างใดอย่างหนึ่ง: ตั้งคำถามที่กลุ่มเป้าหมายอยากรู้คำตอบ, พูดถึงปัญหาที่เจอบ่อยแบบเจาะจง, หรือประโยคที่ทำให้อยากรู้ว่าเกิดอะไรขึ้นต่อ ห้ามขึ้นต้นด้วยการแนะนำตัวหรือแนะนำสินค้าตรงๆ เช่น \"วันนี้จะมารีวิว...\" \"สวัสดีค่ะวันนี้...\"",
      "script ต้องพูดจบได้จริงภายในความยาววิดีโอสั้น เขียนกระชับแบบพูดปากเปล่า ไม่ใช่บทความ — ประมาณ 2-3 ประโยคสั้นต่อ 8 วินาทีของความยาววิดีโอ",
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
      "ต้องการ hook (ประโยคเปิดที่ดึงดูด), script (บทพูดเต็ม), caption (แคปชันโพสต์), cta (call to action)",
      "และ onScreenText: ข้อความพาดหัวที่กลั่นมาจาก hook หรือจุดขายหลัก ให้เห็นแวบเดียวแล้วเข้าใจทันที ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ — ควรเป็นคำเดียวหรือวลีสั้นมาก ไม่เกิน 10 ตัวอักษร (ยิ่งสั้นยิ่งเรนเดอร์เป็นภาษาไทยได้แม่นยำขึ้น) ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น \"สบายสุด\" \"ยืดเยอะ\"",
      "และ onScreenCta: ข้อความชวนกดตะกร้าเหลืองซื้อตอนท้าย ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ ไม่เกิน 8 ตัวอักษร ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น \"กดเลย\" \"สั่งเลย\"",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildScenePrompt(
  product: Product,
  script: string,
  targetDuration: number,
  hasImages: boolean,
) {
  return {
    system: [
      "คุณเป็น storyboard artist สำหรับวิดีโอ TikTok affiliate ตอบเป็น JSON ตาม schema เท่านั้น แบ่งสคริปต์เป็นฉากสั้นๆ ที่รวมความยาวเท่ากับเวลาที่กำหนด",
      "คำบรรยายฉากจะถูกส่งต่อให้โมเดลสร้างวิดีโอโดยตรง จึงต้องบรรยายสิ่งที่เห็นในเฟรมอย่างเป็นรูปธรรม",
      "แต่ละฉากต้องเป็นช็อตที่ต่างกันชัดเจน ทั้งมุมกล้อง ระยะภาพ และการกระทำ ห้ามให้สองฉากเป็นภาพแบบเดียวกัน",
      "เรียงฉากให้เป็นลำดับเรื่องที่เดินหน้า เช่น เห็นปัญหา → หยิบสินค้ามาใช้ → เห็นผลลัพธ์ ไม่ใช่โชว์สินค้าซ้ำๆ หลายมุม",
      "ถ้ามีรูปสินค้าแนบมา ให้บรรยายสินค้าตามหน้าตาจริงในรูป (รูปทรง สี วัสดุ) และให้ฉากเป็นการใช้งานที่สมเหตุสมผลกับสินค้าประเภทนั้นจริงๆ",
      "ห้ามใส่ฉากที่ไม่เข้ากับประเภทสินค้า เช่น ห้ามให้ทาสินค้าที่ไม่ใช่เครื่องสำอางลงบนใบหน้า",
      "ฉากแรกต้องเป็นภาพที่สื่อถึง hook ของสคริปต์โดยตรง ให้เห็นแวบแรกแล้วรู้สึกอยากดูต่อ",
      "ห้ามอธิบายตัวหนังสือ ข้อความ หรือคำบรรยายที่จะปรากฏบนจอไว้ใน description เพราะข้อความบนจอถูกกำหนดแยกต่างหากแล้ว ให้ description บรรยายเฉพาะภาพเคลื่อนไหวและการกระทำที่เห็นเท่านั้น",
      "ห้ามบรรยายฉากที่มีความเสี่ยงถูกโมเดลสร้างวิดีโอปฏิเสธ เช่น การกล่าวอ้างทางการแพทย์แบบภาพ (คนหายป่วย บาดแผลหาย), ความรุนแรง, เครื่องดื่มแอลกอฮอล์, เด็กที่ไม่มีผู้ปกครองอยู่ด้วย หรือฉากที่ดูอันตราย",
    ].join("\n"),
    prompt: [
      hasImages ? "รูปสินค้าจริงแนบมา ให้ยึดตามรูป" : "",
      `สคริปต์: ${script}`,
      `สินค้า: ${product.name}`,
      `รายละเอียดสินค้า: ${product.description ?? "-"}`,
      `ความยาววิดีโอทั้งหมด: ${targetDuration} วินาที`,
      "แบ่งเป็นฉากสั้นๆ (3-5 ฉาก) แต่ละฉากมี duration (วินาที), description (บรรยายภาพและการกระทำที่เห็น) และ cameraMotion (การเคลื่อนกล้อง)",
      "ฉากทั้งหมดจะถูกต่อเป็นวิดีโอเดียว ให้แต่ละฉากต่อเนื่องจากฉากก่อนหน้า: คนเดิม ชุดเดิม สถานที่เดิม แสงเดิม",
      "cameraMotion ให้เขียนเป็นภาษาอังกฤษสั้นๆ และต้องต่อจากการเคลื่อนกล้องของฉากก่อนหน้าอย่างลื่นไหล เช่น \"continue the slow push-in, then tilt down to the product\" ห้ามตัดภาพกระโดด",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function toScenePromptInputs(scenes: Scene[]): { position: number; duration: number; description: string }[] {
  return scenes.map((scene, position) => ({ position, ...scene }));
}
