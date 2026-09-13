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
  },
  required: ["hook", "script", "caption", "cta"],
};

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
        },
        required: ["duration", "description"],
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
    ].join("\n"),
    prompt: [
      hasImages ? "รูปสินค้าจริงแนบมา ให้ยึดตามรูป" : "",
      `สคริปต์: ${script}`,
      `สินค้า: ${product.name}`,
      `รายละเอียดสินค้า: ${product.description ?? "-"}`,
      `ความยาววิดีโอทั้งหมด: ${targetDuration} วินาที`,
      "แบ่งเป็นฉากสั้นๆ (3-5 ฉาก) แต่ละฉากมี duration (วินาที) และ description (บรรยายภาพที่เห็น)",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function toScenePromptInputs(scenes: Scene[]): { position: number; duration: number; description: string }[] {
  return scenes.map((scene, position) => ({ position, ...scene }));
}
