import { sceneIssues, generateValidated, creativeRepairPrompt } from "@/lib/prompt-engine/creative-quality";
import { prisma } from "@/lib/db/prisma";
import { getLLMProvider } from "@/lib/ai";
import { scenePlanResultSchema, type ScenePlanResult } from "@/lib/validation/scene";
import { loadProductImages } from "@/lib/ai/product-images";
import { CLIP_SECONDS, MAX_CLIPS } from "@/lib/prompt-engine/clip-planner";
import {
  SPEAKABLE_SCRIPT_RULE,
  getStylePlaybook,
  presenterRule,
  speechBudget,
  shotPlanningRule,
  stylePlaybookPrompt,
  styleUsesOnScreenText,
} from "@/lib/prompt-engine/style-playbooks";

const MOCK_SCENES = {
  scenes: [
    {
      clip: 0,
      duration: 2,
      description: "เห็นสถานการณ์ปัญหาในชีวิตประจำวัน แล้วคนในภาพหันมาสนใจสินค้า",
      visual: "A person notices the specific everyday problem, then looks toward the real product on the table.",
      cameraMotion: "slow handheld push-in from the problem to the product",
      dialogue: "ใครเจอปัญหานี้ลองดูตัวนี้",
      voiceover: "",
    },
    {
      clip: 0,
      duration: 3,
      description: "หยิบสินค้าและสาธิตขั้นตอนการใช้งานที่ถูกต้องอย่างใกล้ๆ",
      visual: "The person picks up the real product and demonstrates the relevant use step in a clear close-up.",
      cameraMotion: "continue the push-in, then tilt down to the hands and product",
      dialogue: "จุดที่เห็นชัดคือใช้งานสะดวก",
      voiceover: "",
    },
    {
      clip: 0,
      duration: 3,
      description: "วางสินค้าเด่นในเฟรมและแสดงผลลัพธ์ด้านความสะดวกอย่างเป็นธรรมชาติ",
      visual: "The person completes the task, smiles naturally, and places the real product prominently in the foreground.",
      cameraMotion: "gently pull back and settle on the product",
      dialogue: "ถ้ากำลังหาแบบนี้กดดูรายละเอียดได้เลย",
      voiceover: "",
    },
  ],
};

function quoteExact(value: string): string {
  return JSON.stringify(value.trim());
}

function clipPlanFor(targetDuration: number): { clipCount: number; clipSeconds: number } {
  const safeDuration = Math.max(4, Math.min(targetDuration, MAX_CLIPS * CLIP_SECONDS));
  const clipCount = Math.max(1, Math.ceil(safeDuration / CLIP_SECONDS));
  return { clipCount, clipSeconds: clipCount === 1 ? safeDuration : CLIP_SECONDS };
}

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
  const { clipCount, clipSeconds } = clipPlanFor(targetDuration);
  const totalDuration = clipCount * clipSeconds;
  const playbook = getStylePlaybook(content.style);
  const budget = speechBudget(clipSeconds, playbook.speech);

  const llm = getLLMProvider();
  const request = {
    system: [
      "คุณเป็น storyboard artist สำหรับวิดีโอ TikTok affiliate ตอบเป็น JSON ตาม schema เท่านั้น",
      `วิดีโอนี้แบ่งเป็น ${clipCount} clip โดย clip แต่ละอันสร้างแยกกันยาว ${clipSeconds} วินาที แล้วนำมาต่อกัน — clip ใช้เลข 0 ถึง ${clipCount - 1}`,
      `ต้องมีฉากครบทุก clip และ duration ของฉากใน clip เดียวกันรวมกันเท่ากับ ${clipSeconds} วินาทีโดยประมาณ ใช้ 1-2 ฉากต่อ clip${clipCount === 1 ? "" : " และห้ามปล่อย clip ใดว่าง"}`,
      "ภายใน clip เดียวกันให้เป็นการเคลื่อนไหวต่อเนื่อง ไม่มี jump cut; ข้าม clip ให้เรื่องเดินหน้าและเปลี่ยนการกระทำ มุมกล้อง หรือระยะภาพอย่างมีเหตุผล แต่คน ชุด สถานที่ แสง และสินค้าต้องต่อเนื่อง",
      "description เป็นสรุปฉากภาษาไทยสั้นๆ สำหรับผู้ใช้ตรวจ, visual เป็นคำบรรยายภาพภาษาอังกฤษที่เป็นรูปธรรมสำหรับโมเดลวิดีโอ, cameraMotion เป็นคำสั่งกล้องภาษาอังกฤษที่ต่อจากฉากก่อน",
      "visual ต่อฉากให้มีการกระทำหลักเพียงอย่างเดียวที่ช้าและเรียบง่าย (เช่น หยิบสินค้าขึ้นมา, เปิดฝา, กดใช้) ห้ามมีท่าหมุนตัว หันหลัง สะบัดหัว เต้น กระโดด โยนสินค้า หรือการเคลื่อนไหวเร็ว เพราะโมเดลวิดีโอจะทำให้หัวหรือร่างกายบิดผิดธรรมชาติ",
      "cameraMotion ใช้ได้เฉพาะการเคลื่อนที่ช้าและนิ่ง: static, slow push-in, slow pull-back, gentle tilt up/down, small slow pan ห้ามใช้ orbit, arc, 360, วนรอบตัวคน, whip pan หรือ zoom เร็ว",
      presenterRule(playbook.presenter),
      shotPlanningRule(content.style),
      `dialogue คือประโยคภาษาไทยที่คนในภาพพูด, voiceover คือประโยคภาษาไทยของเสียงบรรยายนอกจอ ฉากหนึ่งควรใช้เพียงช่องเดียว ${
        playbook.speech === "silent" ? "ทุกฉากทั้ง dialogue และ voiceover เป็นสตริงว่าง ให้เสียงสัมผัสจริงของสินค้าเป็นเสียงหลัก" : "เว้นช่วงให้ภาพและเสียงของสินค้าเล่าเรื่องได้ ไม่ต้องพูดเต็มทุกวินาที"
      }`,
      "แบ่ง script ตามรอยต่อประโยคเท่านั้น ห้ามตัดกลางประโยค แต่ละฉากได้ประโยคที่ครบความ และคำพูดในฉากต้องพูดถึงสิ่งที่กำลังเห็นในภาพของฉากนั้น",
      "ทั้งวิดีโอเป็นเรื่องเดียวต่อเนื่อง: คนเดิม สถานที่เดิม ช่วงเวลาเดียวกัน ฉากถัดไปเริ่มจากสิ่งที่ฉากก่อนจบไว้ (ท่าทาง ตำแหน่งสินค้า) ห้ามเปลี่ยนสถานที่หรือขึ้นเหตุการณ์ใหม่ที่ไม่เกี่ยวกันในแต่ละ clip",
      "แบ่งเฉพาะคำพูดใน script ลงใน dialogue/voiceover ตามลำดับ ใช้ข้อความตามต้นฉบับครบ ไม่ซ้ำ ไม่เพิ่มคำพูดจาก hook หรือ cta ที่ไม่ได้อยู่ใน script",
      `ใน 1 clip ใช้ผู้พูดแบบเดียว คำพูดรวมไม่เกิน ${budget[1]} ตัวอักษร เว้นเวลาสำหรับการกระทำและการหายใจ แบ่งคำพูดเป็นประโยคครบความ ห้ามตัดคำพูดทิ้ง`,
      SPEAKABLE_SCRIPT_RULE,
      "ถ้าเป็น Review ให้เห็นหลักฐานจากการสาธิตก่อนพูดจุดเด่น และห้ามแต่งประสบการณ์ว่าใช้มานาน ซื้อซ้ำ หรือเห็นผลในจำนวนวัน ถ้าไม่มีข้อมูลยืนยัน",
      "ถ้ามีรูปสินค้า ให้ยึดรูปทรง สี วัสดุ โลโก้ และวิธีใช้งานที่สมเหตุสมผลตามรูป ห้ามเปลี่ยนเป็นสินค้าทั่วไปหรือใส่ฟีเจอร์ที่ไม่มีข้อมูล",
      "ห้ามใส่ฉากอันตราย ความรุนแรง การรักษาโรค การเปลี่ยนแปลงร่างกายแบบมหัศจรรย์ หรือ before/after ที่ไม่มีข้อเท็จจริงรองรับ",
      "ห้ามใส่ตัวหนังสือ คำบรรยาย หรือ caption ลงใน description/visual เพราะข้อความบนจอถูกกำหนดแยกใน prompt สุดท้าย",
    ].join("\n"),
    prompt: [
      images.length ? `รูปสินค้าจริงแนบมา ${images.length} รูป ให้ยึดตามรูป` : "",
      `สินค้า: ${content.product.name}`,
      `รายละเอียดสินค้า: ${content.product.description ?? "-"}`,
      `สไตล์: ${content.style}`,
      stylePlaybookPrompt(content.style),
      `แนวภาพของสไตล์นี้ (ใช้กับ visual และ cameraMotion ทุกฉาก): ${playbook.videoDirection} / กล้อง: ${playbook.camera} / แสง: ${playbook.lighting}`,
      content.angle ? `มุมการขาย: ${content.angle}` : "",
      `hook: ${content.hook}`,
      `script (ต้องรักษาคำพูดไว้ครบ): ${content.script}`,
      `cta: ${content.cta}`,
      content.onScreenText && styleUsesOnScreenText(content.style)
        ? `ข้อความพาดหัวบนจอภาษาไทยที่ต้องคัดลอกตรงตัวว่า ${quoteExact(content.onScreenText)} จะขึ้นต้นคลิป — จัด composition ให้มีพื้นที่ว่าง ห้ามใส่ข้อความนี้ไว้ใน description/visual`
        : "",
      content.onScreenCta && styleUsesOnScreenText(content.style)
        ? `ข้อความ CTA บนจอภาษาไทยที่ต้องคัดลอกตรงตัวว่า ${quoteExact(content.onScreenCta)} จะขึ้นท้ายคลิป — จัดเฟรมสินค้าน่าซื้อ ห้ามใส่ข้อความนี้ไว้ใน description/visual`
        : "",
      `ความยาวทั้งหมด: ${totalDuration} วินาที (${clipCount} clip × ${clipSeconds} วินาที)`,
      "ส่ง scenes ให้ครบ โดยแต่ละรายการมี clip, duration, description, visual, cameraMotion, dialogue และ voiceover",
    ]
      .filter(Boolean)
      .join("\n"),
    images,
    schema: scenePlanResultSchema,
    mock: {
      scenes: Array.from({ length: clipCount }, (_, clip) => ({
        ...MOCK_SCENES.scenes[1], clip, duration: clipSeconds,
        dialogue: playbook.presenter === "hands" || playbook.speech === "silent" || clip > 0 ? "" : content.script,
        voiceover: playbook.presenter === "hands" && playbook.speech !== "silent" && clip === 0 ? content.script : "",
      })),
    },
  };
  const result = await generateValidated<ScenePlanResult>(
    (repair) => llm.generateObject({ ...request, prompt: request.prompt + (repair ? creativeRepairPrompt(repair) : "") }),
    (value) => sceneIssues(value.scenes, content, clipCount, clipSeconds),
  );

  await prisma.scene.deleteMany({ where: { contentId } });

  await prisma.scene.createMany({
    data: result.scenes.map((scene, position) => ({
      contentId,
      position,
      duration: scene.duration,
      description: scene.description,
      visual: scene.visual?.trim() || null,
      cameraMotion: scene.cameraMotion?.trim() || null,
      clip: scene.clip ?? 0,
      dialogue: scene.dialogue?.trim() || null,
      voiceover: scene.voiceover?.trim() || null,
    })),
  });

  return prisma.scene.findMany({
    where: { contentId },
    orderBy: { position: "asc" },
  });
}
