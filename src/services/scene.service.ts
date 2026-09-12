import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import { scenePlanResultSchema } from "@/lib/validation/scene";
import { loadProductImages } from "@/lib/ai/product-images";

const MOCK_SCENES = {
  scenes: [
    { duration: 2, description: "หญิงสาวส่องกระจก มองผิวหน้าตัวเองด้วยสีหน้ากังวล" },
    { duration: 3, description: "หยิบผลิตภัณฑ์ขึ้นมา ทาลงบนใบหน้าอย่างเบามือ" },
    { duration: 3, description: "Close-up ผิวหน้าที่ดูเนียนใสขึ้น ยิ้มพอใจ" },
  ],
};

export async function planScenes(
  userId: string,
  contentId: string,
  targetDuration: number,
) {
  const content = await prisma.content.findFirst({
    where: { id: contentId, userId },
    include: { product: true },
  });
  if (!content) return null;

  const images = await loadProductImages(content.productId);

  const llm = getLLMProvider();
  const result = await llm.generateObject({
    system: [
      "คุณเป็น storyboard artist สำหรับวิดีโอ TikTok affiliate ตอบเป็น JSON ตาม schema เท่านั้น แบ่งสคริปต์เป็นฉากสั้นๆ ที่รวมความยาวเท่ากับเวลาที่กำหนด",
      "คำบรรยายฉากจะถูกส่งต่อให้โมเดลสร้างวิดีโอโดยตรง จึงต้องบรรยายสิ่งที่เห็นในเฟรมอย่างเป็นรูปธรรม",
      "ถ้ามีรูปสินค้าแนบมา ให้บรรยายสินค้าตามหน้าตาจริงในรูป (รูปทรง สี วัสดุ) และให้ฉากเป็นการใช้งานที่สมเหตุสมผลกับสินค้าประเภทนั้นจริงๆ",
      "ห้ามใส่ฉากที่ไม่เข้ากับประเภทสินค้า เช่น ห้ามให้ทาสินค้าที่ไม่ใช่เครื่องสำอางลงบนใบหน้า",
    ].join("\n"),
    prompt: [
      images.length ? `รูปสินค้าจริงแนบมา ${images.length} รูป ให้ยึดตามรูป` : "",
      `สคริปต์: ${content.script}`,
      `สินค้า: ${content.product.name}`,
      `รายละเอียดสินค้า: ${content.product.description ?? "-"}`,
      `ความยาววิดีโอทั้งหมด: ${targetDuration} วินาที`,
      "แบ่งเป็นฉากสั้นๆ (3-5 ฉาก) แต่ละฉากมี duration (วินาที) และ description (บรรยายภาพที่เห็น)",
    ]
      .filter(Boolean)
      .join("\n"),
    images,
    schema: scenePlanResultSchema,
    mock: MOCK_SCENES,
  });

  await prisma.scene.deleteMany({ where: { contentId } });

  await prisma.scene.createMany({
    data: result.scenes.map((scene, position) => ({
      contentId,
      position,
      duration: scene.duration,
      description: scene.description,
    })),
  });

  return prisma.scene.findMany({
    where: { contentId },
    orderBy: { position: "asc" },
  });
}
