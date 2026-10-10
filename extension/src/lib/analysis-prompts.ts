import { platformForStyle, platformRule, salesContext, type PublishPlatform } from "./commerce.js";
/** Ported from src/services/{analysis,content,scene}.service.ts + src/lib/validation/*.ts — same prompts, hand-written JSON Schema instead of zod (no zod dependency in the extension). */

import type { JsonSchema } from "./gemini.js";
import type { Product, ProductAnalysis, Scene } from "./store.js";
import { MAX_CLIPS, clipCountFor } from "./prompt-engine.js";
import { getStylePlaybook, NATURAL_SPEECH_RULE, SPEAKABLE_SCRIPT_RULE, styleCameraMotion, speechBudget, styleStoryRule, shotPlanningRule, sellingScriptRule, presenterRule, styleUsesOnScreenText, stylePlaybookPrompt } from "./style-playbooks.js";

export { CONTENT_STYLES } from "./style-playbooks.js";

export const PRODUCT_ANALYSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    targetCustomer: { type: "string", description: "กลุ่มลูกค้าเป้าหมาย 1-2 ประโยค: เป็นใคร ไลฟ์สไตล์แบบไหน และใช้สินค้าในสถานการณ์ใด" },
    painPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "ปัญหาจริงของกลุ่มเป้าหมายที่สินค้านี้ช่วยได้ ข้อละ 1 ประโยค 3-5 ข้อ" },
    sellingPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "จุดขายที่จับต้องได้ของสินค้าชิ้นนี้ (วัสดุ ขนาด ฟีเจอร์ วิธีใช้) ข้อละ 1 ประโยค 3-5 ข้อ" },
    angles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "มุมเล่าเรื่องสำหรับวิดีโอสั้น ที่ต่างกันชัดเจน ข้อละ 1 ประโยค 3-5 ข้อ" },
  },
  required: ["targetCustomer", "painPoints", "sellingPoints", "angles"],
};

export const CONTENT_GENERATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hook: { type: "string", description: "ประโยคเปิด 1 ประโยคที่ดึงความสนใจได้ใน 1-2 วินาทีแรก" },
    script: { type: "string", description: "คำพูดทั้งหมดในคลิปเรียงตามเวลา ขึ้นต้นด้วย hook และจบด้วย CTA" },
    caption: { type: "string", description: "แคปชันโพสต์: hook สั้น + จุดขาย 1 ประโยค + แฮชแท็กตามข้อกำหนดแพลตฟอร์ม" },
    cta: { type: "string", description: "ประโยคชวนดูสินค้าตามแพลตฟอร์มตอนท้าย" },
    onScreenText: { type: "string", description: "ข้อความพาดหัวบนจอ ภาษาไทยล้วนและสั้นมาก หรือ \"\" ถ้าสไตล์นี้ไม่ใช้" },
    onScreenCta: { type: "string", description: "ข้อความ CTA บนจอ ภาษาไทยล้วนและสั้นมาก หรือ \"\" ถ้าสไตล์นี้ไม่ใช้" },
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

/** Rotates through the analysis angles so repeated generations for a product tell different stories. */
export function pickAngle(analysis: ProductAnalysis | null, generationIndex: number): string | undefined {
  const angles = analysis?.angles?.filter((a) => a.trim()) ?? [];
  return angles.length ? angles[generationIndex % angles.length] : undefined;
}

/**
 * Video models pronounce plain spoken Thai well but garble digits, English
 * words, abbreviations and symbols — or read them out in English.
 */
/**
 * The presenter's gender is picked after the script is written. Particles
 * (ครับ/ค่ะ) are switched to match automatically; gendered pronouns cannot be
 * (ผม also means hair), so the script avoids them.
 */
const GENDER_NEUTRAL_RULE =
  "ผู้พูดอาจเป็นผู้หญิงหรือผู้ชาย: ห้ามใช้สรรพนามแทนตัวเองที่บอกเพศ (ผม ดิฉัน ฉัน หนู) ให้ใช้ \"เรา\" แทน ส่วนคำลงท้าย ครับ/ค่ะ/คะ ใช้ได้ตามปกติ (ระบบจะปรับให้ตรงเพศผู้พูดเอง) และให้เว้นวรรคหลังคำลงท้ายทุกครั้ง";

export const SCENE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    productLook: {
      type: "string",
      description: "หน้าตาสินค้าตามรูปจริง เป็นภาษาอังกฤษ 1-2 ประโยค: รูปทรง สัดส่วน สี วัสดุ ฝา/หัว ตำแหน่งโลโก้และฉลาก ขนาดเทียบกับมือ",
    },
    castOptions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "ลุคคนและสถานที่ 4 แบบ: ผู้หญิง 2 ผู้ชาย 2",
      items: {
        type: "object",
        properties: {
          person: { type: "string", description: "ลักษณะคนในคลิป เป็นภาษาอังกฤษ" },
          setting: { type: "string", description: "สถานที่ เวลา และทิศทางแสง เป็นภาษาอังกฤษ" },
          gender: { type: "string", enum: ["female", "male"], description: "เพศของคนในลุคนี้" },
        },
        required: ["person", "setting"],
      },
    },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CLIPS * 3,
      description: "ฉากเรียงตามเวลา ต้องมีครบทุก clip",
      items: {
        type: "object",
        properties: {
          clip: { type: "integer", minimum: 0, maximum: MAX_CLIPS - 1, description: "เลขช่วงวิดีโอ เริ่มจาก 0" },
          duration: { type: "integer", minimum: 1, maximum: 20, description: "ความยาวฉากเป็นวินาที (จำนวนเต็ม)" },
          description: { type: "string", description: "สรุปภาพของฉาก ภาษาไทยสั้นๆ" },
          visual: { type: "string", description: "สิ่งที่เห็นในเฟรม ภาษาอังกฤษล้วน เรียกคนว่า the person" },
          cameraMotion: { type: "string", description: "การเคลื่อนกล้อง ภาษาอังกฤษสั้นๆ" },
          dialogue: { type: "string", description: "คำพูดภาษาไทยของคนในภาพ หรือ \"\"" },
          voiceover: { type: "string", description: "เสียงบรรยายภาษาไทยนอกจอ หรือ \"\"" },
        },
        required: ["clip", "duration", "description", "visual", "cameraMotion", "dialogue", "voiceover"],
      },
    },
  },
  required: ["castOptions", "scenes"],
};

/**
 * Filled-in answers for an invented product (a stainless tumbler), shown to
 * the web chat apps next to the field list so they see the exact JSON shape.
 * The prompt labels them as shape-only so their content is not copied.
 */
export const PRODUCT_ANALYSIS_EXAMPLE = {
  targetCustomer: "พนักงานออฟฟิศและนักศึกษาอายุ 18-35 ปีที่พกน้ำไปทำงานหรือเรียนทั้งวัน และอยากได้น้ำเย็นตลอดวันโดยไม่ต้องซื้อน้ำแข็งเพิ่ม",
  painPoints: [
    "น้ำแข็งในแก้วละลายหมดตั้งแต่ช่วงบ่าย น้ำจืดชืดไม่อร่อย",
    "แก้วน้ำทั่วไปมีหยดน้ำเกาะด้านนอก ทำโต๊ะและกระเป๋าเปียก",
    "ต้องซื้อน้ำขวดพลาสติกใหม่ทุกวัน เปลืองเงินและเป็นขยะ",
  ],
  sellingPoints: [
    "ผนังสแตนเลสสองชั้นแบบสุญญากาศ เก็บความเย็นได้ทั้งวันตามข้อมูลสินค้า",
    "ความจุ 900 มล. ดื่มได้ทั้งวันโดยไม่ต้องเติมบ่อย",
    "ฝาหลอดดูดพับเก็บได้ พร้อมหูหิ้วซิลิโคนถือสะดวก",
  ],
  angles: [
    "ใส่น้ำแข็งตั้งแต่เช้าแล้วเปิดดูตอนเย็นว่ายังเหลือเป็นก้อน",
    "วางเทียบกับแก้วธรรมดาบนโต๊ะทำงาน ใบหนึ่งมีหยดน้ำเกาะ อีกใบแห้งสนิท",
    "รีวิวแบบจริงใจว่าหนักไหม ใส่กระเป๋าได้หรือเปล่า",
  ],
};

export function contentGenerationExample(withOnScreenText: boolean, silent = false, light = false) {
  return {
    hook: silent ? "มือเปิดฝาและวางกระบอกน้ำบนโต๊ะอย่างนุ่มนวล" : light ? "" : "พกน้ำสะดวกขึ้นนะ",
    script: silent ? "" : light ? "ดูที่ตะกร้าได้เลย" : "พกน้ำสะดวกขึ้นนะ กดดูที่ตะกร้าได้เลย",
    caption: "น้ำเย็นได้ทั้งวัน ไม่ต้องซื้อน้ำแข็งเพิ่ม\nกระบอกสแตนเลสสองชั้น 900 มล. พกไปทำงานได้ทั้งวัน\n#กระบอกน้ำ #กระบอกน้ำเก็บความเย็น #ของใช้ออฟฟิศ #ของดีบอกต่อ #TikTokShop",
    cta: "ดูที่ตะกร้าได้เลย",
    onScreenText: withOnScreenText ? "เย็นทั้งวัน" : "",
    onScreenCta: withOnScreenText ? "กดเลย" : "",
  };
}

/** A complete, budget-safe example; only its JSON shape is a reference. */
export function scenePlanExample(blocks: number, clipSeconds: number, style = "UGC") {
  const playbook = getStylePlaybook(style);
  const hands = playbook.presenter === "hands";
  const actions: Record<string, string[]> = {
    "Before After": ["The empty product is held open on the desk", "The hands fill the product with water", "The filled product rests in the same position", "The hands close the lid and hold the finished state"],
    Comparison: ["The product and a plain cup sit side by side", "The hands pour the same amount of water into each", "The hands point out the visible lid difference", "Both options remain visible in the same framing"],
    Unboxing: ["The hands open the plain wrapping around the product", "The hands lift the product from the wrapping", "The hands reveal the lid detail", "The product rests clearly on the desk"],
    "ASMR / Satisfying": ["The hands gently open the product lid with an audible click", "The hands pour water into the product", "The hands gently close the lid", "The hands set the product on the table with a soft tap"],
    POV: ["From the viewer's eyes, the hands reach for the product", "From the same viewpoint, the hands open the lid", "The hands fill the product", "The hands close the lid, ready to carry it"],
  };
  const steps = actions[style] ?? ["The person opens the product lid", "The person fills the product with water", "The person closes the lid", "The person places the product ready to carry"];
  const scenes = Array.from({ length: blocks }, (_, clip) => {
    const action = hands ? steps[clip % steps.length].replace(/The person/g, "The hands") : steps[clip % steps.length];
    const words = playbook.speech === "silent" || (playbook.speech === "light" && clip < blocks - 1) ? "" : clip === blocks - 1 ? (platformForStyle(style) === "shopee" ? "ดูสินค้าที่แนบได้เลย" : "ดูที่ตะกร้าได้เลย") : "พกน้ำสะดวกขึ้นนะ";
    return {
      clip, duration: clipSeconds, description: "สาธิตหนึ่งขั้นแล้วค้างภาพให้เห็นรายละเอียด",
      visual: `Close-up at desk height${platformForStyle(style) === "shopee" ? ` in ${salesContext(style)}` : ""}, ${action}. The product starts within reach, the contact point stays visible, and the final state is held briefly`,
      cameraMotion: styleCameraMotion(style),
      dialogue: hands || style === "Storytelling" || style === "Lifestyle Vlog" ? "" : words,
      voiceover: hands || style === "Storytelling" || style === "Lifestyle Vlog" ? words : "",
    };
  });
  return {
    productLook: "A tall matte silver stainless steel tumbler, a black flip-up straw lid and a black side handle, a small engraved logo near the bottom",
    castOptions: [
      { person: hands ? "hands only, a Thai woman's hands, short clean nails, beige sleeves" : "Thai woman in her late 20s, black ponytail, plain beige shirt", setting: platformForStyle(style) === "shopee" ? salesContext(style) : "tidy Thai home desk, soft daylight from the left", gender: "female" },
      { person: hands ? "hands only, a Thai man's hands, short clean nails, navy sleeves" : "Thai man in his early 30s, short black hair, plain navy shirt", setting: platformForStyle(style) === "shopee" ? salesContext(style) : "tidy Thai home desk, soft daylight from the left", gender: "male" },
      { person: hands ? "hands only, a Thai woman's hands, short clean nails, white sleeves" : "Thai woman in her mid-20s, shoulder-length black hair, plain white shirt", setting: platformForStyle(style) === "shopee" ? salesContext(style) : "clean condo table, even daylight", gender: "female" },
      { person: hands ? "hands only, a Thai man's hands, short clean nails, grey sleeves" : "Thai man in his late 20s, short black hair, plain grey shirt", setting: platformForStyle(style) === "shopee" ? salesContext(style) : "clean condo table, even daylight", gender: "male" },
    ],
    scenes,
  };
}

export function buildAnalysisPrompt(product: Product, hasImages: boolean, platform: PublishPlatform = product.source === "shopee" ? "shopee" : "tiktok") {
  return {
    system: [
      "คุณเป็นนักการตลาดที่เชี่ยวชาญด้าน affiliate marketing วิเคราะห์สินค้าแล้วตอบเป็น JSON ตาม schema เท่านั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปเป็นหลักว่าสินค้าคืออะไร ใช้ทำอะไร เพราะชื่อและรายละเอียดที่ดึงมาจากหน้าเว็บมักไม่ครบหรือคลาดเคลื่อน",
      "ห้ามแต่งสรรพคุณที่ไม่สอดคล้องกับประเภทสินค้าที่เห็นจริง",
      platformRule(platform),
      "ตอบทุกฟิลด์เป็นภาษาไทยล้วน แม้ชื่อหรือรายละเอียดสินค้าจะเป็นภาษาอังกฤษ",
      "ห้ามเขียน painPoints หรือ sellingPoints ที่เป็นคำกว้างทั่วไปซึ่งใช้ได้กับสินค้าทุกชนิด เช่น \"คุณภาพดี\" \"ราคาคุ้มค่า\" \"ใช้งานง่าย\" — ทุกข้อต้องอ้างอิงรายละเอียดที่จับต้องได้ของสินค้าชิ้นนี้จริงๆ เช่น วัสดุ ขนาด สี ฟีเจอร์ วิธีใช้",
      "angles ให้คิดจากมุมที่คนไทยดูคลิปสั้นแล้วหยุดดูจริง เช่น ปัญหาที่เจอบ่อยในชีวิตประจำวัน, รีวิวแบบจริงใจไม่โอเว่อร์, เปรียบเทียบก่อน-หลัง, unboxing ที่มีจังหวะเซอร์ไพรส์",
      "ห้ามระบุ painPoints, sellingPoints หรือ angles ที่เป็นการอ้างสรรพคุณทางการแพทย์ การรักษาโรค หรือผลลัพธ์ที่รับประกัน 100% แม้ชื่อหรือคำอธิบายสินค้าจะใช้คำเหล่านั้นก็ตาม — ให้ปรับเป็นมุมด้านความรู้สึกหรือประสบการณ์การใช้งานแทน",
    ].join("\n"),
    prompt: [
      hasImages ? "วิเคราะห์สินค้านี้จากรูปที่แนบมา ประกอบกับข้อมูลด้านล่าง:" : "วิเคราะห์สินค้านี้:",
      `ชื่อ: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      `ราคา: ${product.price ?? "-"} ${product.currency ?? ""}`,
    ].join("\n"),
    example: PRODUCT_ANALYSIS_EXAMPLE,
  };
}

export function buildContentPrompt(
  product: Product,
  analysis: ProductAnalysis | null,
  style: string,
  targetDuration: number,
  clipSeconds: number,
  hasImages: boolean,
  angle?: string,
  platform: PublishPlatform = platformForStyle(style),
) {
  const blocks = clipCountFor(targetDuration, clipSeconds);
  const seconds = blocks * clipSeconds;

  const { speech } = getStylePlaybook(style);
  const budget = speechBudget(seconds, speech);

  return {
    system: [
      `คุณเป็นนักเขียนสคริปต์ ${platform === "shopee" ? "Shopee Video" : "TikTok"} affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยที่เป็นธรรมชาติ กระชับ เหมาะกับวิดีโอสั้น`,
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปว่าสินค้าคืออะไร และพูดถึงประโยชน์ที่ตรงกับสินค้าประเภทนั้นจริงๆ",
      "hook ต้องดึงความสนใจภายใน 1-2 วินาทีด้วยภาพหรือคำพูดตามสไตล์ ไม่ต้องเปิดด้วยปัญหาทุกสไตล์ ห้ามเริ่มด้วยการแนะนำตัว",
      speech === "silent" ? 'script เป็นสตริงว่าง "" เพราะสไตล์นี้ไม่มีคำพูด hook อธิบายภาพเปิด ส่วน cta ใช้กับ caption ไม่ต้องพูดในวิดีโอ' : "script คือคำพูดทั้งหมดที่จะได้ยินในวิดีโอ เรียงตามลำดับเวลา ใช้ประโยคที่ครบความตามสไตล์ ไม่ต้องบรรยายทุกการกระทำ",
      "script ต้องพูดจบได้จริงภายในความยาววิดีโอที่กำหนดโดยไม่ต้องเร่งพูด ห้ามเขียนยาวเกินงบตัวอักษรที่กำหนด",
      SPEAKABLE_SCRIPT_RULE,
      GENDER_NEUTRAL_RULE,
      platform === "shopee" ? "caption สำหรับ Shopee รวมทั้งหมดต้องไม่เกิน 150 ตัวอักษร รวมสระ วรรณยุกต์ ช่องว่าง และแฮชแท็ก: จุดขายสั้นหนึ่งประโยค พร้อม #ShopeeVideo และแฮชแท็กสินค้า 1–2 อัน" : "caption ต้องมีโครงสร้าง: บรรทัดแรกเป็น hook สั้นที่ทำให้คนหยุดเลื่อน ตามด้วยจุดขายสั้นๆ 1 ประโยค แล้วปิดท้ายด้วยแฮชแท็ก 4-6 อัน ผสมระหว่างแฮชแท็กกว้าง (หมวดสินค้า) กับแฮชแท็กเจาะจง (ชื่อ/ประเภทสินค้า) ห้ามใช้แฮชแท็กที่ไม่เกี่ยวข้องเพื่อหวังยอดวิว",
      platformRule(platform),
      "ห้ามเขียน hook, script, caption, cta หรือข้อความบนจอที่มีการอ้างสรรพคุณทางการแพทย์ (เช่น รักษาโรค ต้านมะเร็ง ลดความเสี่ยงโรค), การรับประกันผลลัพธ์แบบเกินจริง (เช่น \"ได้ผล 100%\" \"หายขาด\"), หรือถ้อยคำที่อาจถูกมองว่าหลอกลวงผู้บริโภค — เน้นประสบการณ์การใช้งานจริงและความรู้สึกแทนเสมอ",
      "ห้ามแต่งประสบการณ์ส่วนตัว เช่น ใช้มา 7 วัน/3 เดือน ซื้อซ้ำ หรือเห็นผลในจำนวนวันที่กำหนด เว้นแต่ข้อมูลสินค้าระบุและยืนยันไว้ชัดเจน",
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
      stylePlaybookPrompt(style),
      platform === "shopee" ? `ฉากการขายที่เลือก: ${salesContext(style)} — ผู้ขายแสดงสินค้าและสาธิตจริง ไม่ยืนพูดเฉยๆ` : "",
      angle
        ? `มุมการขายที่เลือก: "${angle}" — สร้าง hook, script และ CTA ทั้งหมดรอบมุมนี้ ห้ามเปลี่ยนไปใช้มุมอื่นกลางคลิป`
        : "",
      blocks > 1
        ? `ความยาววิดีโอ: ${seconds} วินาที (${blocks} ช่วง ช่วงละ ${clipSeconds} วินาที)`
        : `ความยาววิดีโอ: ${seconds} วินาที (สร้างรวดเดียวทั้งคลิป)`,
      // Pick the arc by length, not clip count: one 20-second Gemini video needs the fuller story, not the 8-second one.
      styleStoryRule(seconds),
      speech === "silent" ? "" : NATURAL_SPEECH_RULE,
      `แบ่ง script เป็นไม่เกิน ${blocks} บรรทัดตาม clip แต่ละบรรทัดเป็นประโยคครบความและไม่เกิน ${speechBudget(clipSeconds, speech)[1]} ตัวอักษร ห้ามตัดประโยคข้าม clip`,
      `งบคำพูด: script ประมาณ ${budget[0]}-${budget[1]} ตัวอักษรไทยรวมสระ วรรณยุกต์และช่องว่าง ห้ามเกิน ${budget[1]} ตัวอักษร เว้นเวลาสำหรับหายใจ การสาธิต และภาพผลลัพธ์ ถ้ายาวเกินให้เขียนใหม่โดยลดจุดขาย ไม่ตัดกลางประโยค`,
      platform === "shopee" ? sellingScriptRule(speech).replace(/ตะกร้าเหลือง/g, "สินค้าที่แนบ") : sellingScriptRule(speech),
      "ต้องการ hook (ประโยคเปิดที่ดึงดูด), script (บทพูดเต็ม), caption (แคปชันโพสต์), cta (call to action)",
      ...(styleUsesOnScreenText(style)
        ? [
            `และ onScreenText: ข้อความพาดหัวที่กลั่นมาจาก hook หรือจุดขายหลัก ให้เห็นแวบเดียวแล้วเข้าใจทันที ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ — ควรเป็นคำเดียวหรือวลีสั้นมาก ไม่เกิน ${ON_SCREEN_HEADLINE_MAX} ตัวอักษรรวมสระและวรรณยุกต์ (ยิ่งสั้นยิ่งเรนเดอร์เป็นภาษาไทยได้แม่นยำขึ้น) ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น "สบายสุด" "ยืดเยอะ"`,
            `และ onScreenCta: ข้อความชวนกดตะกร้าเหลืองซื้อตอนท้าย ภาษาไทยล้วน สั้นที่สุดเท่าที่จะสั้นได้ ไม่เกิน ${ON_SCREEN_CTA_MAX} ตัวอักษรรวมสระและวรรณยุกต์ ห้ามมีภาษาอังกฤษ อีโมจิ หรือสัญลักษณ์ เช่น "กดเลย" "สั่งเลย"`,
            "ฟิลด์ onScreenText และ onScreenCta คือข้อความจริงที่จะถูกคัดลอกลงวิดีโอภายหลัง: ส่งเฉพาะตัวอักษรภาษาไทย ไม่ต้องใส่เครื่องหมายคำพูดในค่า เพราะ prompt engine จะครอบด้วยเครื่องหมาย \"...\" ให้เอง",
          ]
        : ['onScreenText และ onScreenCta: ส่งเป็นสตริงว่าง "" ทั้งคู่ เพราะสไตล์นี้ไม่ใส่ตัวหนังสือบนวิดีโอ']),
    ]
      .filter(Boolean)
      .join("\n"),
    example: { ...contentGenerationExample(styleUsesOnScreenText(style), speech === "silent", speech === "light"), ...(platform === "shopee" ? { script: speech === "silent" ? "" : "ดูรายละเอียดชัดเลย กดดูสินค้าที่แนบได้เลย", caption: "ดูรายละเอียดสินค้าและเลือกแบบที่ต้องการ\n#รีวิวสินค้า #ของใช้ #ShopeeVideo", cta: "กดดูสินค้าที่แนบได้เลย" } : {}) },
  };
}

export interface ScenePlanContent {
  style: string;
  platform?: PublishPlatform;
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
  clipSeconds: number,
  hasImages: boolean,
  analysis: ProductAnalysis | null,
) {
  const blocks = clipCountFor(targetDuration, clipSeconds);
  const lastBlock = blocks - 1;
  const platform = platformForStyle(content.style, content.platform);
  const playbook = getStylePlaybook(content.style);
  const budget = speechBudget(clipSeconds, playbook.speech);

  return {
    system: [
      `คุณเป็น storyboard artist สำหรับวิดีโอ ${platform === "shopee" ? "Shopee Video" : "TikTok"} affiliate ตอบเป็น JSON ตาม schema เท่านั้น`,
      platformRule(platform),
      platform === "shopee" ? `ทุก castOptions.setting และ visual ต้องใช้ฉากขายนี้: ${salesContext(content.style)} คนเดิมและฉากเดิมทุก clip; การขายผ่านท่าทางและสาธิตจริง ไม่สร้างลูกค้า ยอดคนดูหรือข้อความ UI ปลอม` : "",
      blocks > 1
        ? `โมเดลสร้างวิดีโอเรนเดอร์ได้ครั้งละ ${clipSeconds} วินาที วิดีโอจึงถูกสร้างเป็นช่วง (clip) ช่วงละ ${clipSeconds} วินาทีแยกกัน แล้วนำมาต่อเป็นวิดีโอเดียว ให้วางแผนฉากตามช่วงเหล่านี้โดยตรง`
        : `โมเดลสร้างวิดีโอเรนเดอร์วิดีโอนี้ทั้ง ${clipSeconds} วินาทีในครั้งเดียว (clip เดียว) ทุกฉากจึงเป็น clip 0`,
      `แต่ละฉากต้องระบุ clip (เลขช่วงเริ่มจาก 0) และ duration — ฉากใน clip เดียวกันต้องมี duration รวมกันเท่ากับ ${clipSeconds} วินาทีพอดี ใช้ ${clipSeconds > 10 ? "3-4" : "1-2"} ฉากต่อ clip`,
      clipSeconds > 10 && blocks === 1
        ? "วิดีโอนี้ยาวกว่าช็อตเดียว ตัดภาพระหว่างฉากได้แบบนุ่มนวล แต่ห้ามตัดกระโดดกลางการกระทำ ทุกฉากต้องเป็นคนเดิม ชุดเดิม สถานที่เดิม แสงเดิม และแต่ละฉากต้องมีการกระทำใหม่ที่พาเรื่องเดินหน้า ห้ามโชว์สินค้าซ้ำแบบเดิม"
        : "ภายใน clip เดียวกัน กล้องถ่ายต่อเนื่องเป็นเทคเดียว ไม่มีการตัดภาพ ฉากใน clip เดียวกันคือจังหวะต่อเนื่องของการกระทำ (เช่น หยิบสินค้า → เปิดฝา → ลองใช้) ที่เปลี่ยนระยะภาพได้ด้วยการเคลื่อนกล้องเท่านั้น",
      blocks > 1
        ? "ข้าม clip เรื่องต้องเดินหน้า: แต่ละ clip มีการกระทำใหม่ที่ต่างจาก clip ก่อนหน้าชัดเจน ห้ามโชว์สินค้าซ้ำๆ แบบเดิมหรือทำการกระทำเดิมซ้ำ แต่ยังเป็นคนเดิม ชุดเดิม สถานที่เดิม แสงเดิม"
        : "",
      blocks > 1 ? "clip ที่ไม่ใช่ช่วงสุดท้ายต้องจบด้วยท่าทางหรือการเคลื่อนไหวที่นิ่งและต่อได้ และ clip ถัดไปต้องเริ่มจากท่านั้น" : "",
      "เรียงเรื่องให้เดินหน้าตามโครงเรื่องของสไตล์ ใช้การกระทำและภาพเล่าเรื่อง ไม่ต้องถือสินค้ายื่นเข้ากล้องทุกฉาก",
      "description: สรุปภาพของฉากเป็นภาษาไทยสั้นๆ (ใช้แสดงให้ผู้ใช้ตรวจ)",
      "visual: บรรยายสิ่งที่เห็นในเฟรมเป็นภาษาอังกฤษอย่างเป็นรูปธรรม (ท่าทาง การใช้สินค้า ระยะภาพ) เพราะจะส่งให้โมเดลสร้างวิดีโอโดยตรง ห้ามมีตัวอักษรไทยใน visual — เรียกคนในภาพว่า \"the person\" ห้ามระบุเพศ อายุ หรือหน้าตาใน visual เพราะลุคของคนถูกกำหนดแยกไว้ใน castOptions",
      "visual ต่อฉากให้มีการกระทำหลักเพียงอย่างเดียวที่ช้าและเรียบง่าย (เช่น หยิบสินค้าขึ้นมา, เปิดฝา, กดใช้) ห้ามมีท่าหมุนตัว หันหลัง สะบัดหัว เต้น กระโดด โยนสินค้า หรือการเคลื่อนไหวเร็ว เพราะโมเดลวิดีโอจะทำให้หัวหรือร่างกายบิดผิดธรรมชาติ",
      "cameraMotion: การเคลื่อนกล้องเป็นภาษาอังกฤษสั้นๆ ที่ต่อจากฉากก่อนหน้าอย่างลื่นไหล ใช้ได้เฉพาะการเคลื่อนที่ช้าและนิ่ง: static, slow push-in, slow pull-back, gentle tilt up/down, small slow pan เช่น \"continue the slow push-in, then tilt down to the product\" ห้ามใช้ orbit, arc, 360, วนรอบตัวคน, whip pan หรือ zoom เร็ว และห้ามตัดภาพกระโดด",
      presenterRule(playbook.presenter),
      shotPlanningRule(content.style),
      `dialogue: ประโยคภาษาไทยที่คนในภาพพูดในฉากนั้น / voiceover: ประโยคภาษาไทยที่เสียงบรรยายนอกจอพูด — ฉากหนึ่งใช้อย่างใดอย่างหนึ่ง อีกช่องให้เป็นสตริงว่าง ${
        playbook.speech === "silent" ? "ทุกฉากทั้ง dialogue และ voiceover ต้องเป็นสตริงว่าง ใช้เสียงสัมผัสจริงของสินค้า" : "เว้นช่วงให้ภาพหรือเสียงสินค้าเล่าเรื่องได้ ไม่ต้องพูดเต็มทุกวินาที"
      }`,
      "แบ่ง script ตามรอยต่อประโยคเท่านั้น ห้ามตัดกลางประโยค แต่ละฉากได้ประโยคที่ครบความ และคำพูดในฉากต้องพูดถึงสิ่งที่กำลังเห็นในภาพของฉากนั้น",
      "ทั้งวิดีโอเป็นเรื่องเดียวต่อเนื่อง: คนเดิม สถานที่เดิม ช่วงเวลาเดียวกัน ฉากถัดไปเริ่มจากสิ่งที่ฉากก่อนจบไว้ (ท่าทาง ตำแหน่งสินค้า) ห้ามเปลี่ยนสถานที่หรือขึ้นเหตุการณ์ใหม่ที่ไม่เกี่ยวกันในแต่ละ clip",
      "นำเฉพาะคำพูดใน script มาแบ่งใส่ dialogue/voiceover ตามลำดับ ใช้คำตามต้นฉบับครบ ไม่ซ้ำ ไม่เพิ่มคำพูดจาก hook หรือ cta ที่ไม่ได้อยู่ใน script",
      `ใน 1 clip ใช้ผู้พูดแบบเดียว คำพูดรวมไม่เกิน ${budget[1]} ตัวอักษร เว้นเวลาสำหรับการกระทำและการหายใจ แบ่งคำพูดเป็นประโยคครบความ หากใส่ script ไม่ลงให้รายงานปัญหา ห้ามตัดคำพูดทิ้ง`,
      SPEAKABLE_SCRIPT_RULE,
      GENDER_NEUTRAL_RULE,
      "ให้คำพูดอยู่กับภาพที่กำลังอธิบาย เว้นจังหวะหายใจ ห้ามยัดประโยคยาวลงฉากสั้น ถ้าเป็น dialogue ให้เห็นหน้าคนพูดตอนเริ่มพูด",
      "castOptions: เสนอ 4 ลุคที่ต่างกันชัดเจน เป็นผู้หญิง 2 ลุคและผู้ชาย 2 ลุค (ระบบจะเลือกเพศตามที่ผู้ใช้ตั้ง) ระบุ gender ทุกลุค เป็นภาษาอังกฤษ แต่ละลุคเป็นคนไทยทั่วไปแบบแม่ค้า/พ่อค้าหรือครีเอเตอร์ที่ขายของจริงบนแพลตฟอร์มที่เลือก อายุและการแต่งตัวเข้ากับกลุ่มลูกค้าของสินค้า แต่งตัวแบบใส่อยู่บ้านหรือไปทำงานจริง ไม่ใช่นายแบบนางแบบ มี person (เช่น \"Thai woman in her mid-20s, shoulder-length black hair, natural makeup, plain beige oversized T-shirt\" หรือ \"hands only — a Thai woman's hands, short clean nails\" ถ้าสินค้าเหมาะกับการถ่ายแค่มือ) และ setting (สถานที่ เวลา ทิศทางแสง เช่น \"bright minimal bedroom desk by a window, late-morning daylight from the left\") ทุกลุคต้องใช้ได้กับทุกฉากที่วางไว้ (ถ้ามีฉากที่มี dialogue หรือเห็นหน้าคน ห้ามเสนอลุคแบบเห็นแค่มือ) และสมเหตุสมผลกับสินค้า ไม่ต้องบรรยายรูปร่างหน้าตาละเอียดเกินจำเป็น",
      "productLook: บรรยายหน้าตาสินค้าเป็นภาษาอังกฤษ 1-2 ประโยคให้ตรงกับรูปสินค้าที่แนบมาที่สุด (รูปทรง สัดส่วน สีหลักและสีรอง วัสดุ/ผิว ฝาหรือหัว ตำแหน่งโลโก้และฉลาก ขนาดเทียบกับมือ) ห้ามเดาสิ่งที่ไม่เห็นในรูป ห้ามใส่ตัวอักษรไทยและห้ามคัดลอกข้อความบนฉลาก (บอกแค่ว่ามีโลโก้/ฉลากอยู่ตรงไหน) ถ้าไม่มีรูปให้บรรยายเท่าที่ข้อมูลสินค้ายืนยัน",
      "ใน visual ให้เรียกสินค้าว่า \"the product\" เท่านั้น ห้ามบรรยายสี รูปทรง หรือวัสดุของสินค้าซ้ำใน visual เพราะหน้าตาสินค้าถูกกำหนดไว้ใน productLook แล้ว และให้ฉากเป็นการใช้งานที่สมเหตุสมผลกับสินค้าประเภทนั้นจริงๆ",
      "ให้สินค้าอยู่ในเฟรมชัดๆ หันด้านหน้า/โลโก้เข้ากล้อง ห้ามให้มือบังโลโก้ ห้ามบิด งอ หรือแกะสินค้าจนรูปทรงเปลี่ยน เว้นแต่เป็นวิธีใช้ปกติของสินค้า",
      "ห้ามใส่ฉากที่ไม่เข้ากับประเภทสินค้า เช่น ห้ามให้ทาสินค้าที่ไม่ใช่เครื่องสำอางลงบนใบหน้า",
      "ห้ามอธิบายตัวหนังสือ ข้อความ หรือคำบรรยายที่จะปรากฏบนจอไว้ใน description หรือ visual เพราะข้อความบนจอถูกกำหนดแยกต่างหากแล้ว",
      "ห้ามบรรยายฉากที่มีความเสี่ยงถูกโมเดลสร้างวิดีโอปฏิเสธ เช่น การกล่าวอ้างทางการแพทย์แบบภาพ (คนหายป่วย บาดแผลหาย), ความรุนแรง, เครื่องดื่มแอลกอฮอล์, เด็กที่ไม่มีผู้ปกครองอยู่ด้วย หรือฉากที่ดูอันตราย",
    ].filter(Boolean).join("\n"),
    prompt: [
      hasImages ? "รูปสินค้าจริงแนบมา ให้ยึดตามรูป" : "",
      `สินค้า: ${product.name}`,
      `รายละเอียดสินค้า: ${product.description ?? "-"}`,
      analysis
        ? [
            `กลุ่มเป้าหมายจากการวิเคราะห์สินค้า: ${analysis.targetCustomer}`,
            `ปัญหาที่สินค้าช่วยตอบโจทย์: ${analysis.painPoints.join(", ")}`,
            `จุดขายที่ตรวจพบ: ${analysis.sellingPoints.join(", ")}`,
            "ให้การกระทำและภาพในแต่ละฉากสื่อถึงกลุ่มเป้าหมาย ปัญหา และจุดขายเหล่านี้ โดยยึดข้อมูลสินค้าและรูปจริง ห้ามเพิ่มคุณสมบัติที่ไม่มีในข้อมูล",
          ].join("\n")
        : "",
      `สไตล์: ${content.style}\n${stylePlaybookPrompt(content.style)}`,
      // The storyboard writes the visuals, so it needs the style's look too — not only its story shape.
      `แนวภาพของสไตล์นี้ (ใช้กับ visual และ cameraMotion ทุกฉาก): ${playbook.videoDirection} / กล้อง: ${playbook.camera} / แสง: ${playbook.lighting}`,
      "ตัวอย่าง JSON ที่แนบมาเป็นแค่รูปแบบคำตอบ ห้ามลอกสินค้า ฉาก ระยะภาพ หรือวิธีพูดจากตัวอย่าง ให้วางฉากตามสไตล์ที่เลือกนี้",
      content.angle ? `มุมการขาย: ${content.angle}` : "",
      `hook: ${content.hook}`,
      `script: ${content.script}`,
      `cta: ${content.cta}`,
      content.onScreenText && styleUsesOnScreenText(content.style)
        ? `ข้อความพาดหัวบนจอภาษาไทยต้องคัดลอกตรงตัวว่า "${content.onScreenText}" จะขึ้นช่วงต้นของ clip 0 — ให้ฉากแรกของ clip 0 เป็นภาพที่สื่อถึง hook และมีพื้นที่ว่างให้ข้อความ`
        : "ฉากแรกของ clip 0 ต้องเป็นภาพที่สื่อถึง hook ของสคริปต์โดยตรง ให้เห็นแวบแรกแล้วรู้สึกอยากดูต่อ",
      content.onScreenCta && styleUsesOnScreenText(content.style) ? `ข้อความ CTA บนจอภาษาไทยต้องคัดลอกตรงตัวว่า "${content.onScreenCta}" จะขึ้นช่วงท้ายของ clip ${lastBlock} — ให้ฉากสุดท้ายจบที่สินค้าดูน่าซื้อ` : "",
      `ความยาววิดีโอทั้งหมด: ${blocks * clipSeconds} วินาที = ${blocks} clip (clip 0 ถึง clip ${lastBlock}) ต้องมีฉากครบทุก clip`,
    ]
      .filter(Boolean)
      .join("\n"),
    example: scenePlanExample(blocks, clipSeconds, content.style),
  };
}

export function toScenePromptInputs(scenes: Scene[]): (Scene & { position: number })[] {
  return scenes.map((scene, position) => ({ position, ...scene }));
}
