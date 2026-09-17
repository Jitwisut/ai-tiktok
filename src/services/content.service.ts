import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import { loadProductImages } from "@/lib/ai/product-images";
import {
  contentGenerationResultSchema,
  ON_SCREEN_CTA_MAX,
  ON_SCREEN_HEADLINE_MAX,
  type UpdateContentInput,
} from "@/lib/validation/content";
import { SPEAKABLE_SCRIPT_RULE, getStylePlaybook, stylePlaybookPrompt, styleUsesOnScreenText } from "@/lib/prompt-engine/style-playbooks";

const MOCK_CONTENT = {
  hook: "ใครกำลังหาไอเท็มที่ใช้สะดวกต้องดู",
  script: "จากที่ลองในคลิปนี้ ตัวนี้ใช้งานสะดวกและหยิบใช้ได้ง่าย ใครกำลังหาแบบนี้กดดูรายละเอียดที่ตะกร้าได้เลย",
  caption: "ไอเท็มที่ช่วยให้ขั้นตอนนี้ง่ายขึ้น ลองดูรายละเอียดก่อนตัดสินใจนะ #ของใช้ดีบอกต่อ #TikTokShop",
  cta: "กดดูรายละเอียดที่ตะกร้าได้เลย",
  onScreenText: "ใช้สะดวก",
  onScreenCta: "กดดูเลย",
};

const THAI_CHARS_PER_SECOND = 45 / 8;

function cleanOnScreenText(text: string | undefined, maxChars: number): string | undefined {
  const cleaned = (text ?? "")
    .replace(/[^\u0E00-\u0E7F0-9\s!?]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([!?])/g, "$1")
    .trim();
  if (!cleaned || !/[\u0E00-\u0E7F]/.test(cleaned)) return undefined;
  return Array.from(cleaned).length <= maxChars ? cleaned : undefined;
}

function scriptStructure(targetDuration: number): string {
  if (targetDuration <= 8) return "hook สั้นมาก + จุดขายหลัก 1 ข้อ + CTA สั้น";
  if (targetDuration <= 16) return "hook + จุดขาย/การใช้งาน 2 จังหวะ + CTA";
  return "hook + ปัญหา/บริบท + สาธิตการใช้งาน + ประโยชน์ + CTA";
}

function reviewRules(): string[] {
  return [
    "Review ต้องประกอบด้วย first impression → practical test/demo → จุดที่สังเกตได้จริง → ข้อจำกัดหรือคำแนะนำว่าเหมาะกับใครเมื่อมีข้อมูล → CTA",
    "ห้ามแกล้งทำเป็นลูกค้าที่ใช้มานาน เช่น \"ใช้มา 7 วัน\" \"ใช้มา 3 เดือน\" \"ซื้อซ้ำรอบที่ 4\" หรือ \"เห็นผลใน X วัน\" เว้นแต่ข้อมูลสินค้าระบุและยืนยันไว้ชัดเจน",
    "ถ้าไม่มีประสบการณ์ใช้งานจริง ให้ใช้คำว่า \"จากที่เห็นในคลิปนี้\" \"จุดที่เห็นชัดคือ\" หรือ \"ตัวนี้ดูเหมาะกับคนที่...\" แทนการอ้างประวัติส่วนตัว",
  ];
}

function claimSafetyRules(): string[] {
  return [
    "ห้ามอ้างว่ารักษาโรค หายขาด ป้องกันโรค ได้ผล 100% รับประกันผลลัพธ์ หรือใส่ตัวเลข performance ที่ไม่มีในข้อมูลสินค้า",
    "ห้ามสร้าง before/after ทางร่างกายหรือผลลัพธ์มหัศจรรย์ที่ไม่มีข้อเท็จจริงรองรับ สำหรับสินค้าทั่วไปให้ใช้ before/after ด้านความสะดวก ความเป็นระเบียบ หรือขั้นตอนการทำงาน",
    "อย่าแต่งฟีเจอร์ วัสดุ ขนาด ราคา ส่วนลด อุปกรณ์ในกล่อง หรือแพ็กเกจที่ไม่มีในข้อมูลหรือรูปสินค้า",
  ];
}

function angleFor(angles: string[] | undefined, generationIndex: number): string | undefined {
  const available = angles?.map((angle) => angle.trim()).filter(Boolean) ?? [];
  return available.length ? available[generationIndex % available.length] : undefined;
}

export async function generateContent(
  userId: string,
  productId: string,
  style: string,
  targetDuration = 24,
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, userId },
    include: { analysis: true },
  });
  if (!product) return null;

  const [images, generationIndex] = await Promise.all([
    loadProductImages(productId),
    prisma.content.count({ where: { productId } }),
  ]);
  const angle = angleFor(product.analysis?.angles, generationIndex);
  const playbook = getStylePlaybook(style);
  const speechBudget = Math.round(targetDuration * THAI_CHARS_PER_SECOND);

  const llm = getLLMProvider();
  const result = await llm.generateObject({
    system: [
      "คุณเป็นนักเขียนครีเอทีฟและนักวางโฆษณา TikTok affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น",
      "เขียน hook, script, caption, cta และข้อความบนจอเป็นภาษาไทยที่เป็นธรรมชาติแบบภาษาพูด แม้ข้อมูลสินค้าและคำสั่งส่วนอื่นจะเป็นภาษาอังกฤษ",
      "script คือคำพูดที่ได้ยินจริงทั้งหมด เรียงตามเวลา ขึ้นต้นด้วย hook จบด้วย CTA ประโยคสั้น พูดจบได้ในเวลาที่กำหนดโดยไม่ต้องเร่ง และเว้นจังหวะให้ภาพเล่าเรื่อง",
      SPEAKABLE_SCRIPT_RULE,
      "hook ต้องดึงความสนใจภายใน 1-2 วินาทีแรก ห้ามขึ้นต้นด้วยการแนะนำตัวหรือคำว่า วันนี้จะมารีวิว...",
      "ยึดรูปสินค้าและข้อมูลที่ให้มาเป็นหลัก ห้ามแต่งคุณสมบัติหรือการใช้งานที่ไม่สมเหตุสมผลกับประเภทสินค้า",
      ...reviewRules(),
      ...claimSafetyRules(),
      "caption ต้องไม่คัดลอก hook แบบคำต่อคำ ให้พูดถึงประโยชน์หรือความน่าสนใจหลักเพียงหนึ่งเรื่อง ใช้แฮชแท็กที่เกี่ยวข้อง 4-6 อัน ไม่สแปมแฮชแท็ก",
      `แนวทางเฉพาะของสไตล์ ${style}: ${playbook.writing}`,
    ].join("\n"),
    prompt: [
      images.length ? `รูปสินค้าจริงแนบมา ${images.length} รูป ให้ยึดตามรูป` : "",
      `สร้างคอนเทนต์สไตล์ "${style}" สำหรับสินค้านี้`,
      stylePlaybookPrompt(style),
      `ชื่อสินค้า: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      product.analysis
        ? [
            `กลุ่มเป้าหมาย: ${product.analysis.targetCustomer}`,
            `Pain points: ${product.analysis.painPoints.join(", ")}`,
            `จุดขาย: ${product.analysis.sellingPoints.join(", ")}`,
          ].join("\n")
        : "",
      angle
        ? `มุมการขายที่เลือก: "${angle}" — hook, script, caption และ CTA ต้องอยู่ในมุมนี้ตลอดทั้งชิ้น ห้ามเปลี่ยนมุมกลางคลิป`
        : "เลือกมุมการขายที่เหมาะกับสินค้าและสไตล์นี้เพียงหนึ่งมุม แล้วรักษามุมเดิมตลอดทั้งชิ้น",
      `ความยาวเป้าหมาย: ${targetDuration} วินาที`,
      `โครงเรื่องตามความยาว: ${scriptStructure(targetDuration)}`,
      `งบคำพูดโดยประมาณ: ไม่เกิน ${speechBudget} ตัวอักษรไทยรวมสระและวรรณยุกต์ (เหลือเวลาสำหรับภาพและ CTA)`,
      "ส่งฟิลด์ hook, script, caption, cta ให้ครบ",
      styleUsesOnScreenText(style)
        ? `ส่ง onScreenText เป็นพาดหัวภาษาไทยล้วนจาก hook/จุดขาย ไม่เกิน ${ON_SCREEN_HEADLINE_MAX} ตัวอักษร และ onScreenCta เป็น CTA ภาษาไทยล้วน ไม่เกิน ${ON_SCREEN_CTA_MAX} ตัวอักษร — ทั้งสองฟิลด์คือข้อความจริงที่จะถูกคัดลอกลงวิดีโอ ห้ามใส่เครื่องหมายคำพูดไว้ในค่า เพราะระบบจะครอบด้วยเครื่องหมาย \"...\" เอง`
        : 'ส่ง onScreenText และ onScreenCta เป็นสตริงว่าง "" ทั้งคู่ เพราะสไตล์นี้ไม่ใส่ตัวหนังสือบนวิดีโอ',
    ]
      .filter(Boolean)
      .join("\n"),
    images,
    schema: contentGenerationResultSchema,
    mock: MOCK_CONTENT,
  });

  return prisma.content.create({
    data: {
      userId,
      productId,
      style,
      hook: result.hook,
      script: result.script,
      caption: result.caption,
      cta: result.cta,
      onScreenText: cleanOnScreenText(result.onScreenText, ON_SCREEN_HEADLINE_MAX),
      onScreenCta: cleanOnScreenText(result.onScreenCta, ON_SCREEN_CTA_MAX),
      angle,
    },
  });
}

export function listContents(userId: string) {
  return prisma.content.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { product: { select: { name: true } } },
  });
}

export function getContent(userId: string, contentId: string) {
  return prisma.content.findFirst({
    where: { id: contentId, userId },
    include: {
      product: { select: { id: true, name: true } },
      scenes: { orderBy: { position: "asc" } },
    },
  });
}

export async function updateContent(
  userId: string,
  contentId: string,
  input: UpdateContentInput,
) {
  const { count } = await prisma.content.updateMany({
    where: { id: contentId, userId },
    data: input,
  });
  return count > 0;
}

export async function deleteContent(userId: string, contentId: string) {
  const { count } = await prisma.content.deleteMany({
    where: { id: contentId, userId },
  });
  return count > 0;
}
