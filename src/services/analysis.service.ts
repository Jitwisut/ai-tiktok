import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import { productAnalysisSchema } from "@/lib/validation/analysis";

const MOCK_ANALYSIS = {
  targetCustomer: "ผู้หญิงวัยทำงาน อายุ 22-35 ปี ที่ดูแลผิวหน้าเป็นประจำ",
  painPoints: ["ผิวหมองคล้ำจากการนอนดึก", "รองพื้นตกร่องระหว่างวัน"],
  sellingPoints: ["ซึมเร็ว ไม่เหนียวเหนอะหนะ", "ใช้ได้ทุกสภาพผิว"],
  angles: ["Problem Solution", "Before After", "Review"],
};

export async function analyzeProduct(userId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, userId },
  });
  if (!product) return null;

  const llm = getLLMProvider();
  const result = await llm.generateObject({
    system:
      "คุณเป็นนักการตลาดที่เชี่ยวชาญด้าน affiliate marketing วิเคราะห์สินค้าแล้วตอบเป็น JSON ตาม schema เท่านั้น",
    prompt: `วิเคราะห์สินค้านี้:\nชื่อ: ${product.name}\nรายละเอียด: ${product.description ?? "-"}\nราคา: ${product.price ?? "-"} ${product.currency ?? ""}\nหมวดหมู่: ${product.category ?? "-"}`,
    schema: productAnalysisSchema,
    mock: MOCK_ANALYSIS,
  });

  const model =
    process.env.LLM_PROVIDER === "openai"
      ? (process.env.OPENAI_MODEL ?? "gpt-4o-mini")
      : process.env.LLM_PROVIDER === "gemini"
        ? (process.env.GEMINI_MODEL ?? "gemini-2.0-flash")
        : "mock";

  return prisma.productAnalysis.upsert({
    where: { productId },
    create: {
      productId,
      targetCustomer: result.targetCustomer,
      painPoints: result.painPoints,
      sellingPoints: result.sellingPoints,
      angles: result.angles,
      rawJson: result,
      model,
    },
    update: {
      targetCustomer: result.targetCustomer,
      painPoints: result.painPoints,
      sellingPoints: result.sellingPoints,
      angles: result.angles,
      rawJson: result,
      model,
    },
  });
}

export function getProductAnalysis(userId: string, productId: string) {
  return prisma.productAnalysis.findFirst({
    where: { productId, product: { userId } },
  });
}
