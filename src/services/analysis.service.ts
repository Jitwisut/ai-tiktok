import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import { productAnalysisSchema } from "@/lib/validation/analysis";
import { loadProductImages } from "@/lib/ai/product-images";

const MOCK_ANALYSIS = {
  targetCustomer: "ผู้หญิงวัยทำงาน อายุ 22-35 ปี ที่ดูแลผิวหน้าเป็นประจำ",
  painPoints: ["ผิวหมองคล้ำจากการนอนดึก", "รองพื้นตกร่องระหว่างวัน"],
  sellingPoints: ["ซึมเร็ว ไม่เหนียวเหนอะหนะ", "ใช้ได้ทุกสภาพผิว"],
  angles: [
    "ปัญหาที่เจอในชีวิตประจำวัน",
    "รีวิวจากสิ่งที่เห็นและทดลองในคลิป",
    "สาธิตการใช้งานแบบทีละขั้น",
    "เปรียบเทียบกับวิธีเดิมอย่างเป็นธรรม",
    "ทดสอบจุดเด่นที่สังเกตได้จริง",
    "แกะกล่องและ first impression",
  ],
};

export async function analyzeProduct(userId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, userId },
  });
  if (!product) return null;

  const images = await loadProductImages(productId);

  const llm = getLLMProvider();
  const result = await llm.generateObject({
    system: [
      "คุณเป็นนักการตลาดที่เชี่ยวชาญด้าน affiliate marketing วิเคราะห์สินค้าแล้วตอบเป็น JSON ตาม schema เท่านั้น",
      "ถ้ามีรูปสินค้าแนบมา ให้ยึดสิ่งที่เห็นในรูปเป็นหลักว่าสินค้าคืออะไร ใช้ทำอะไร เพราะชื่อและรายละเอียดที่ดึงมาจากหน้าเว็บมักไม่ครบหรือคลาดเคลื่อน",
      "ห้ามแต่งสรรพคุณที่ไม่สอดคล้องกับประเภทสินค้าที่เห็นจริง",
      "คิดมุมการขายอย่างน้อย 4-6 มุมที่แตกต่างกันจริง ไม่ใช่เปลี่ยนคำแต่พูดเรื่องเดิมซ้ำ เช่น ปัญหาเฉพาะ, วิธีใช้, ความสะดวก, รีวิวอย่างเป็นธรรม, เปรียบเทียบ, unboxing หรือการทดสอบที่ปลอดภัย",
      "มุมรีวิวต้องอิงข้อเท็จจริงจากรูปและข้อมูลสินค้า ห้ามแต่งประวัติการใช้หรือผลลัพธ์ตามจำนวนวัน",
      "ห้ามอ้างการรักษาโรค รับประกันผลลัพธ์ หรือ performance ตัวเลขที่ไม่มีข้อมูลยืนยัน",
    ].join("\n"),
    prompt: [
      images.length
        ? `วิเคราะห์สินค้านี้จากรูปที่แนบมา (${images.length} รูป) ประกอบกับข้อมูลด้านล่าง:`
        : "วิเคราะห์สินค้านี้:",
      `ชื่อ: ${product.name}`,
      `รายละเอียด: ${product.description ?? "-"}`,
      `ราคา: ${product.price ?? "-"} ${product.currency ?? ""}`,
      `หมวดหมู่: ${product.category ?? "-"}`,
    ].join("\n"),
    images,
    schema: productAnalysisSchema,
    mock: MOCK_ANALYSIS,
  });

  const model =
    process.env.LLM_PROVIDER === "openai"
      ? (process.env.OPENAI_MODEL ?? "gpt-4o-mini")
      : process.env.LLM_PROVIDER === "gemini"
        ? (process.env.GEMINI_MODEL ?? "gemini-flash-latest")
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
