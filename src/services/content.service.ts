import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import {
  contentGenerationResultSchema,
  type UpdateContentInput,
} from "@/lib/validation/content";

const MOCK_CONTENT = {
  hook: "ใครแต่งหน้าแล้วรองพื้นตกร่องต้องดู",
  script: "วันนี้ลองตัวนี้มา 1 อาทิตย์ ผิวเนียนขึ้นจริง ซึมไวมาก ไม่เหนียวเหนอะหนะเลย",
  caption: "ลองแล้วชอบกว่าที่คิด ราคาเข้าถึงง่ายด้วย",
  cta: "กดดูสินค้าได้ที่ตะกร้า",
};

export async function generateContent(
  userId: string,
  productId: string,
  style: string,
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, userId },
    include: { analysis: true },
  });
  if (!product) return null;

  const llm = getLLMProvider();
  const result = await llm.generateObject({
    system:
      "คุณเป็นนักเขียนสคริปต์ TikTok affiliate มืออาชีพ ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยที่เป็นธรรมชาติ กระชับ เหมาะกับวิดีโอสั้น",
    prompt: [
      `สร้างคอนเทนต์สไตล์ "${style}" สำหรับสินค้านี้:`,
      `ชื่อสินค้า: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      product.analysis
        ? [
            `กลุ่มเป้าหมาย: ${product.analysis.targetCustomer}`,
            `Pain points: ${product.analysis.painPoints.join(", ")}`,
            `จุดขาย: ${product.analysis.sellingPoints.join(", ")}`,
          ].join("\n")
        : "",
      "ต้องการ hook (ประโยคเปิดที่ดึงดูด), script (บทพูดเต็ม), caption (แคปชันโพสต์), cta (call to action)",
    ]
      .filter(Boolean)
      .join("\n"),
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
