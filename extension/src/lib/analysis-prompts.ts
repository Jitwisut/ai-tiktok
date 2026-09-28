/** Ported from src/services/{analysis,content,scene}.service.ts + src/lib/validation/*.ts — same prompts, hand-written JSON Schema instead of zod (no zod dependency in the extension). */

import type { JsonSchema } from "./gemini.js";
import type { Product, ProductAnalysis, Scene } from "./store.js";
import { MAX_CLIPS, clipCountFor } from "./prompt-engine.js";
import { styleUsesOnScreenText, stylePlaybookPrompt } from "./style-playbooks.js";

export { CONTENT_STYLES } from "./style-playbooks.js";

export const PRODUCT_ANALYSIS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    targetCustomer: { type: "string", description: "กลุ่มลูกค้าเป้าหมาย 1-2 ประโยค: เป็นใคร ไลฟ์สไตล์แบบไหน และใช้สินค้าในสถานการณ์ใด" },
    painPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "ปัญหาจริงของกลุ่มเป้าหมายที่สินค้านี้ช่วยได้ ข้อละ 1 ประโยค 3-5 ข้อ" },
    sellingPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "จุดขายที่จับต้องได้ของสินค้าชิ้นนี้ (วัสดุ ขนาด ฟีเจอร์ วิธีใช้) ข้อละ 1 ประโยค 3-5 ข้อ" },
    angles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "มุมเล่าเรื่องสำหรับคลิป TikTok ที่ต่างกันชัดเจน ข้อละ 1 ประโยค 3-5 ข้อ" },
  },
  required: ["targetCustomer", "painPoints", "sellingPoints", "angles"],
};

export const CONTENT_GENERATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hook: { type: "string", description: "ประโยคเปิด 1 ประโยคที่ดึงความสนใจได้ใน 1-2 วินาทีแรก" },
    script: { type: "string", description: "คำพูดทั้งหมดในคลิปเรียงตามเวลา ขึ้นต้นด้วย hook และจบด้วย CTA" },
    caption: { type: "string", description: "แคปชันโพสต์ TikTok: hook สั้น + จุดขาย 1 ประโยค + แฮชแท็ก 4-6 อัน" },
    cta: { type: "string", description: "ประโยคชวนกดตะกร้าเหลืองตอนท้าย" },
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

/**
 * Thai speaking budget per second of video, in characters (vowel and tone
 * marks included). A natural Thai speaking pace is about 10-12 characters a
 * second, so 10 keeps the presenter selling almost continuously without
 * having to rush the words.
 */
const THAI_CHARS_PER_SECOND = 10;

/** Scripts and storyboards are planned in blocks of the site's clip length (8s Flow/AI Studio; on Gemini one block is the whole video). */
function speechCharsPerBlock(clipSeconds: number): number {
  return Math.round(THAI_CHARS_PER_SECOND * clipSeconds);
}

/**
 * A short line leaves the presenter silent for most of a clip and does not
 * sell; this asks for a continuous, concrete pitch that still fits the
 * speaking budget and the claim-safety rules.
 */
const SELLING_SCRIPT_RULE = [
  "script ต้องเป็นคำพูดขายที่ต่อเนื่องและน่าเชื่อ ไม่ใช่แค่บรรยายภาพ: ทุกจุดขายต้องบอกด้วยว่าดียังไงกับคนดู (เช่น ใช้แล้วประหยัดเวลาตอนไหน เก็บของได้มากขึ้นแค่ไหน) ไม่ใช่พูดลอยๆ ว่าดีหรือคุ้ม",
  "ใส่รายละเอียดที่จับต้องได้จากข้อมูลสินค้า เช่น วัสดุ ขนาด วิธีใช้ จำนวนชิ้น เพื่อให้ฟังแล้วรู้สึกว่าคนพูดใช้สินค้าจริง",
  "บอกให้ชัดว่าเหมาะกับใครหรือใช้ตอนไหน แล้วปิดด้วย CTA ที่ชวนกดตะกร้าเหลืองอย่างมั่นใจ",
  "พูดต่อเนื่องเป็นจังหวะธรรมชาติ ประโยคสั้นเรียงติดกัน เว้นจังหวะหายใจสั้นๆ ได้ แต่ห้ามเงียบยาวหลายวินาที",
  "ห้ามพูดวนซ้ำความเดิมเพื่อให้ยาวขึ้น ทุกประโยคต้องเพิ่มข้อมูลใหม่หรือเหตุผลใหม่ที่ทำให้อยากซื้อ",
].join("\n");

/** Rotates through the analysis angles so repeated generations for a product tell different stories. */
export function pickAngle(analysis: ProductAnalysis | null, generationIndex: number): string | undefined {
  const angles = analysis?.angles?.filter((a) => a.trim()) ?? [];
  return angles.length ? angles[generationIndex % angles.length] : undefined;
}

/**
 * Video models pronounce plain spoken Thai well but garble digits, English
 * words, abbreviations and symbols — or read them out in English.
 */
const SPEAKABLE_SCRIPT_RULE =
  "คำพูดทุกประโยค (script, dialogue, voiceover) ต้องเป็นภาษาไทยที่อ่านออกเสียงได้ทันที: เขียนตัวเลขเป็นคำอ่านไทย (เช่น \"สามสิบเก้าบาท\" ไม่ใช่ \"39฿\"), ชื่อแบรนด์หรือคำอังกฤษให้เขียนทับศัพท์เป็นอักษรไทย, ห้ามใช้ตัวย่อ อีโมจิ สัญลักษณ์ (% / + & ~ …) หรือเครื่องหมายคำพูด, ห้ามใช้คำพูดติดปากซ้ำๆ เช่น \"คือแบบ\" \"แบบว่า\" และใช้ประโยคสั้นที่พูดจบในลมหายใจเดียว";

/** Story beats each length has room for — an 8-second video cannot carry a 32-second structure. */
const SCRIPT_STRUCTURE: Record<number, string> = {
  1: "hook + จุดขายหลัก 1 ข้อพร้อมเหตุผลว่าดียังไง + CTA ชวนกดซื้อ",
  2: "hook + ปัญหาที่เจอ + จุดขาย 2 ข้อพร้อมเหตุผล + บอกว่าเหมาะกับใคร + CTA ชวนกดซื้อ",
  3: "hook + ปัญหาที่เจอ + สาธิตการใช้งานพร้อมเล่าไปด้วย + จุดขาย 2-3 ข้อพร้อมเหตุผล + บอกว่าเหมาะกับใคร + CTA ชวนกดซื้อแบบหนักแน่น",
};

export const SCENE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    castOptions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "ลุคคนและสถานที่ 3 แบบที่ต่างกันชัดเจน",
      items: {
        type: "object",
        properties: {
          person: { type: "string", description: "ลักษณะคนในคลิป เป็นภาษาอังกฤษ" },
          setting: { type: "string", description: "สถานที่ เวลา และทิศทางแสง เป็นภาษาอังกฤษ" },
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

export function contentGenerationExample(withOnScreenText: boolean) {
  return {
    hook: "น้ำแข็งละลายหมดก่อนเที่ยงทุกวันใช่ไหม",
    script: "น้ำแข็งละลายหมดก่อนเที่ยงทุกวันใช่ไหม ลองกระบอกนี้ดู ใส่น้ำแข็งไว้ตั้งแต่เจ็ดโมงเช้า ตอนนี้ห้าโมงเย็นยังเหลือเป็นก้อนอยู่เลย ด้านนอกไม่มีหยดน้ำเกาะ วางบนโต๊ะทำงานได้สบาย ใครอยากได้กดตะกร้าเหลืองด้านล่างได้เลย",
    caption: "น้ำเย็นได้ทั้งวัน ไม่ต้องซื้อน้ำแข็งเพิ่ม\nกระบอกสแตนเลสสองชั้น 900 มล. พกไปทำงานได้ทั้งวัน\n#กระบอกน้ำ #กระบอกน้ำเก็บความเย็น #ของใช้ออฟฟิศ #ของดีบอกต่อ #TikTokShop",
    cta: "กดตะกร้าเหลืองด้านล่างได้เลย",
    onScreenText: withOnScreenText ? "เย็นทั้งวัน" : "",
    onScreenCta: withOnScreenText ? "กดเลย" : "",
  };
}

/** Two scenes per clip, for up to two clips — enough to show the shape without a wall of text. */
export function scenePlanExample(blocks: number, clipSeconds: number) {
  const first = Math.ceil(clipSeconds / 2);
  const beats = [
    {
      description: "คนถือแก้วธรรมดาที่น้ำแข็งละลายหมดแล้ว ทำหน้าเบื่อ",
      visual: "Medium shot, the person at an office desk lifts a plain glass of melted, watery iced tea and looks at it with a small frown",
      cameraMotion: "static, then a slow push-in",
      dialogue: "น้ำแข็งละลายหมดก่อนเที่ยงทุกวันใช่ไหม",
      voiceover: "",
    },
    {
      description: "หยิบกระบอกสแตนเลสขึ้นมาวางข้างแก้ว",
      visual: "The person places a matte silver stainless tumbler next to the glass and turns it so the handle faces the camera",
      cameraMotion: "continue the slow push-in, then tilt down to the tumbler",
      dialogue: "ลองกระบอกนี้ดู ใส่น้ำแข็งไว้ตั้งแต่เช้า",
      voiceover: "",
    },
    {
      description: "เปิดฝาให้เห็นน้ำแข็งยังเป็นก้อน",
      visual: "Close-up, the person opens the tumbler lid slowly to show ice cubes still whole inside",
      cameraMotion: "slow push-in toward the open lid",
      dialogue: "ตอนนี้เย็นแล้วน้ำแข็งยังอยู่เลย ด้านนอกก็ไม่มีหยดน้ำ",
      voiceover: "",
    },
    {
      description: "ยกกระบอกขึ้นจิบแล้วยิ้ม",
      visual: "Medium shot, the person takes a sip through the straw lid and smiles at the camera, holding the tumbler at chest height",
      cameraMotion: "gentle slow pull-back",
      dialogue: "อยากได้กดตะกร้าเหลืองด้านล่างได้เลย",
      voiceover: "",
    },
  ];
  const clips = Math.min(Math.max(blocks, 1), 2);
  const scenes = [];
  for (let clip = 0; clip < clips; clip++) {
    scenes.push({ clip, duration: first, ...beats[clip * 2] });
    scenes.push({ clip, duration: clipSeconds - first, ...beats[clip * 2 + 1] });
  }
  return {
    castOptions: [
      { person: "Thai woman in her late 20s, black hair in a low ponytail, plain white shirt", setting: "bright modern office desk by a window, late-morning daylight from the left" },
      { person: "Thai man in his early 30s, short hair, navy polo shirt", setting: "cozy home work corner with a wooden desk, warm afternoon light from the right" },
      { person: "Thai university student around 20, shoulder-length hair, light grey hoodie", setting: "quiet campus library table, soft even daylight from large windows" },
    ],
    scenes,
  };
}

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
) {
  const blocks = clipCountFor(targetDuration, clipSeconds);
  const seconds = blocks * clipSeconds;
  const speechChars = blocks * speechCharsPerBlock(clipSeconds);

  return {
    system: [
      "คุณเป็นนักเขียนสคริปต์ TikTok affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยที่เป็นธรรมชาติ กระชับ เหมาะกับวิดีโอสั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปว่าสินค้าคืออะไร และพูดถึงประโยชน์ที่ตรงกับสินค้าประเภทนั้นจริงๆ",
      "hook ต้องดึงความสนใจได้ภายใน 1-2 วินาทีแรก เลือกใช้เทคนิคอย่างใดอย่างหนึ่ง: ตั้งคำถามที่กลุ่มเป้าหมายอยากรู้คำตอบ, พูดถึงปัญหาที่เจอบ่อยแบบเจาะจง, หรือประโยคที่ทำให้อยากรู้ว่าเกิดอะไรขึ้นต่อ ห้ามขึ้นต้นด้วยการแนะนำตัวหรือแนะนำสินค้าตรงๆ เช่น \"วันนี้จะมารีวิว...\" \"สวัสดีค่ะวันนี้...\"",
      "script คือคำพูดทั้งหมดที่จะได้ยินในวิดีโอ (ทั้งคนในภาพพูดและเสียงบรรยาย) เรียงตามลำดับเวลา ขึ้นต้นด้วย hook และจบด้วย CTA เขียนแบบพูดปากเปล่า ประโยคสั้น ไม่ใช่บทความ",
      "script ต้องพูดจบได้จริงภายในความยาววิดีโอที่กำหนด โดยไม่ต้องเร่งพูด และเหลือเวลาให้ภาพโชว์สินค้าและรีแอคชั่นด้วย — ห้ามเขียนยาวเกินงบตัวอักษรที่กำหนด",
      SPEAKABLE_SCRIPT_RULE,
      "caption ต้องมีโครงสร้าง: บรรทัดแรกเป็น hook สั้นที่ทำให้คนหยุดเลื่อน ตามด้วยจุดขายสั้นๆ 1 ประโยค แล้วปิดท้ายด้วยแฮชแท็ก 4-6 อัน ผสมระหว่างแฮชแท็กกว้าง (หมวดสินค้า) กับแฮชแท็กเจาะจง (ชื่อ/ประเภทสินค้า) ห้ามใช้แฮชแท็กที่ไม่เกี่ยวข้องเพื่อหวังยอดวิว",
      "cta ให้ใช้ภาษาที่คนไทยบน TikTok Shop คุ้นเคย เช่น ชวนกดตะกร้าเหลืองด้านล่าง หรือชวนแชทสอบถาม ห้ามใช้คำที่ฟังดูยัดเยียดหรือเร่งรัดเกินไป",
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
      angle
        ? `มุมการขายที่เลือก: "${angle}" — สร้าง hook, script และ CTA ทั้งหมดรอบมุมนี้ ห้ามเปลี่ยนไปใช้มุมอื่นกลางคลิป`
        : "",
      blocks > 1
        ? `ความยาววิดีโอ: ${seconds} วินาที (${blocks} ช่วง ช่วงละ ${clipSeconds} วินาที)`
        : `ความยาววิดีโอ: ${seconds} วินาที (สร้างรวดเดียวทั้งคลิป)`,
      // Pick the arc by length, not clip count: one 20-second Gemini video needs the fuller story, not the 8-second one.
      `โครงเรื่องที่เหมาะกับความยาวนี้: ${SCRIPT_STRUCTURE[seconds <= 10 ? 1 : seconds < 20 ? 2 : 3]}`,
      `งบคำพูด: script ควรยาวประมาณ ${Math.round(speechChars * 0.85)}-${speechChars} ตัวอักษรไทย (นับสระและวรรณยุกต์ด้วย ประมาณ ${THAI_CHARS_PER_SECOND} ตัวอักษรต่อวินาที) — ให้พูดขายต่อเนื่องเกือบตลอดคลิป ไม่ใช่พูดสั้นๆ แล้วเงียบ แต่ห้ามยาวเกินงบจนต้องเร่งพูด`,
      SELLING_SCRIPT_RULE,
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
    example: contentGenerationExample(styleUsesOnScreenText(style)),
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
  clipSeconds: number,
  hasImages: boolean,
  analysis: ProductAnalysis | null,
) {
  const blocks = clipCountFor(targetDuration, clipSeconds);
  const lastBlock = blocks - 1;
  const perBlock = speechCharsPerBlock(clipSeconds);

  return {
    system: [
      "คุณเป็น storyboard artist สำหรับวิดีโอ TikTok affiliate ตอบเป็น JSON ตาม schema เท่านั้น",
      blocks > 1
        ? `โมเดลสร้างวิดีโอเรนเดอร์ได้ครั้งละ ${clipSeconds} วินาที วิดีโอจึงถูกสร้างเป็นช่วง (clip) ช่วงละ ${clipSeconds} วินาทีแยกกัน แล้วนำมาต่อเป็นวิดีโอเดียว ให้วางแผนฉากตามช่วงเหล่านี้โดยตรง`
        : `โมเดลสร้างวิดีโอเรนเดอร์วิดีโอนี้ทั้ง ${clipSeconds} วินาทีในครั้งเดียว (clip เดียว) ทุกฉากจึงเป็น clip 0`,
      `แต่ละฉากต้องระบุ clip (เลขช่วงเริ่มจาก 0) และ duration — ฉากใน clip เดียวกันต้องมี duration รวมกันเท่ากับ ${clipSeconds} วินาทีพอดี ใช้ ${clipSeconds > 10 ? "3-5" : "1-3"} ฉากต่อ clip`,
      clipSeconds > 10 && blocks === 1
        ? "วิดีโอนี้ยาวกว่าช็อตเดียว ตัดภาพระหว่างฉากได้แบบนุ่มนวล แต่ห้ามตัดกระโดดกลางการกระทำ ทุกฉากต้องเป็นคนเดิม ชุดเดิม สถานที่เดิม แสงเดิม และแต่ละฉากต้องมีการกระทำใหม่ที่พาเรื่องเดินหน้า ห้ามโชว์สินค้าซ้ำแบบเดิม"
        : "ภายใน clip เดียวกัน กล้องถ่ายต่อเนื่องเป็นเทคเดียว ไม่มีการตัดภาพ ฉากใน clip เดียวกันคือจังหวะต่อเนื่องของการกระทำ (เช่น หยิบสินค้า → เปิดฝา → ลองใช้) ที่เปลี่ยนระยะภาพได้ด้วยการเคลื่อนกล้องเท่านั้น",
      blocks > 1
        ? "ข้าม clip เรื่องต้องเดินหน้า: แต่ละ clip มีการกระทำใหม่ที่ต่างจาก clip ก่อนหน้าชัดเจน ห้ามโชว์สินค้าซ้ำๆ แบบเดิมหรือทำการกระทำเดิมซ้ำ แต่ยังเป็นคนเดิม ชุดเดิม สถานที่เดิม แสงเดิม"
        : "",
      blocks > 1 ? "clip ที่ไม่ใช่ช่วงสุดท้ายต้องจบด้วยท่าทางหรือการเคลื่อนไหวที่นิ่งและต่อได้ และ clip ถัดไปต้องเริ่มจากท่านั้น" : "",
      "เรียงเรื่องให้เดินหน้า เช่น เห็นปัญหา → หยิบสินค้ามาใช้ → เห็นผลลัพธ์ และใช้การเล่าเรื่องด้วยภาพ ไม่ใช่ให้คนถือสินค้ายื่นเข้ากล้องทุกฉาก",
      "description: สรุปภาพของฉากเป็นภาษาไทยสั้นๆ (ใช้แสดงให้ผู้ใช้ตรวจ)",
      "visual: บรรยายสิ่งที่เห็นในเฟรมเป็นภาษาอังกฤษอย่างเป็นรูปธรรม (ท่าทาง การใช้สินค้า ระยะภาพ) เพราะจะส่งให้โมเดลสร้างวิดีโอโดยตรง ห้ามมีตัวอักษรไทยใน visual — เรียกคนในภาพว่า \"the person\" ห้ามระบุเพศ อายุ หรือหน้าตาใน visual เพราะลุคของคนถูกกำหนดแยกไว้ใน castOptions",
      "visual ต่อฉากให้มีการกระทำหลักเพียงอย่างเดียวที่ช้าและเรียบง่าย (เช่น หยิบสินค้าขึ้นมา, เปิดฝา, กดใช้) คนในภาพหันหน้าเข้ากล้องเป็นหลัก ห้ามมีท่าหมุนตัว หันหลัง สะบัดหัว เต้น กระโดด โยนสินค้า หรือการเคลื่อนไหวเร็ว เพราะโมเดลวิดีโอจะทำให้หัวหรือร่างกายบิดผิดธรรมชาติ",
      "cameraMotion: การเคลื่อนกล้องเป็นภาษาอังกฤษสั้นๆ ที่ต่อจากฉากก่อนหน้าอย่างลื่นไหล ใช้ได้เฉพาะการเคลื่อนที่ช้าและนิ่ง: static, slow push-in, slow pull-back, gentle tilt up/down, small slow pan เช่น \"continue the slow push-in, then tilt down to the product\" ห้ามใช้ orbit, arc, 360, วนรอบตัวคน, whip pan หรือ zoom เร็ว และห้ามตัดภาพกระโดด",
      "dialogue: ประโยคภาษาไทยที่คนในภาพพูดในฉากนั้น / voiceover: ประโยคภาษาไทยที่เสียงบรรยายนอกจอพูด — ฉากหนึ่งใช้อย่างใดอย่างหนึ่ง อีกช่องให้เป็นสตริงว่าง หรือว่างทั้งคู่ถ้าเป็นฉากภาพล้วน",
      "นำ script มาแบ่งใส่ dialogue/voiceover ตามลำดับ ใช้คำตามต้นฉบับ ทุกประโยคต้องปรากฏครั้งเดียวเท่านั้นในทั้งวิดีโอ ห้ามใส่ประโยคเดิมซ้ำในฉากหรือ clip อื่น ห้ามตัด hook หรือ CTA ทิ้ง ห้ามแต่งประโยคพูดเพิ่ม",
      `ใน 1 clip ให้มีผู้พูดแบบเดียว (dialogue หรือ voiceover อย่างใดอย่างหนึ่ง) แต่พูดต่อเนื่องเกือบตลอด clip รวมประมาณ ${Math.round(perBlock * 0.85)}-${perBlock} ตัวอักษร ห้ามใส่แค่ประโยคสั้นประโยคเดียวแล้วปล่อยให้เงียบ`,
      SPEAKABLE_SCRIPT_RULE,
      `คำพูดต้องพูดจบได้ในเวลาของฉากด้วยจังหวะปกติ: ประมาณ ${THAI_CHARS_PER_SECOND} ตัวอักษรไทยต่อ 1 วินาที และรวมไม่เกิน ${perBlock} ตัวอักษรต่อ clip ห้ามยัดประโยคยาวลงฉากที่ยาว 1-2 วินาที ถ้าเป็น dialogue ให้เห็นหน้าคนพูดตอนเริ่มพูด`,
      "castOptions: เสนอ 3 ลุคที่ต่างกันชัดเจนสำหรับวิดีโอนี้ เป็นภาษาอังกฤษ แต่ละลุคมี person (เช่น \"Thai woman in her mid-20s, shoulder-length black hair, plain beige oversized T-shirt\" หรือ \"hands only, short clean nails\" ถ้าสินค้าเหมาะกับการถ่ายแค่มือ) และ setting (สถานที่ เวลา ทิศทางแสง เช่น \"bright minimal bedroom desk by a window, late-morning daylight from the left\") ทุกลุคต้องใช้ได้กับทุกฉากที่วางไว้ (ถ้ามีฉากที่มี dialogue หรือเห็นหน้าคน ห้ามเสนอลุคแบบเห็นแค่มือ) และสมเหตุสมผลกับสินค้า ไม่ต้องบรรยายรูปร่างหน้าตาละเอียดเกินจำเป็น",
      "ถ้ามีรูปสินค้าแนบมา ให้บรรยายสินค้าตามหน้าตาจริงในรูป (รูปทรง สี วัสดุ) และให้ฉากเป็นการใช้งานที่สมเหตุสมผลกับสินค้าประเภทนั้นจริงๆ",
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
    example: scenePlanExample(blocks, clipSeconds),
  };
}

export function toScenePromptInputs(scenes: Scene[]): (Scene & { position: number })[] {
  return scenes.map((scene, position) => ({ position, ...scene }));
}
