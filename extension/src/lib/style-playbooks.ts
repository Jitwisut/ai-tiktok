/** Standalone copy of src/lib/prompt-engine/style-playbooks.ts for the Chrome extension build. */

export const CONTENT_STYLES = [
  "UGC",
  "Review",
  "Problem Solution",
  "Storytelling",
  "Before After",
  "Unboxing",
  "Demo",
  "POV",
  "ASMR / Satisfying",
  "Comparison",
  "Challenge / Test",
  "Lifestyle Vlog",
  "Educational Tips",
] as const;

export interface StylePlaybook {
  goal: string;
  structure: string;
  writing: string;
  videoDirection: string;
  speechMode: string;
}

const STYLE_PLAYBOOKS: Record<(typeof CONTENT_STYLES)[number], StylePlaybook> = {
  UGC: {
    goal: "ให้เหมือนครีเอเตอร์ค้นพบหรือกำลังใช้สินค้าจริงแบบเป็นธรรมชาติ ไม่เหมือนโฆษณาทีวี",
    structure: "visual interruption → conversational hook → quick context → product interaction → 1-2 concrete benefits → natural reaction → soft CTA",
    writing: "ใช้ภาษาไทยกันเอง ประโยคสั้น มีความเป็นภาษาพูดได้เล็กน้อย ห้ามเปิดด้วยการแนะนำตัวหรือภาษาขายของแข็งๆ",
    videoDirection: "casual creator UGC, spontaneous handheld smartphone framing, imperfect but believable gestures, natural reaction, one clear product interaction",
    speechMode: "dialogue เป็นหลัก คนในภาพพูดกับกล้องแบบเป็นกันเอง",
  },
  Review: {
    goal: "รีวิวที่น่าเชื่อถือ มีประโยชน์ และฟังเหมือนคนกำลังช่วยคนดูตัดสินใจซื้อ ไม่ใช่ชมทุกอย่างแบบไม่มีหลักฐาน",
    structure: "hook → first impression → practical test/demo → 2 concrete observations → honest limitation or neutral fit note when relevant → who it suits → CTA",
    writing: "พูดจากสิ่งที่เห็นหรือทดลองในคลิปนี้ ใช้ถ้อยคำเช่น ‘จากที่ลองในคลิปนี้’, ‘จุดที่เห็นชัดคือ’, ‘เหมาะกับคนที่...’ ห้ามอ้างว่าใช้มาหลายวัน/หลายเดือน ซื้อซ้ำ หรือเห็นผลตามเวลา ถ้าไม่มีข้อมูลยืนยัน",
    videoDirection: "trustworthy on-camera product review, medium talking-head framing mixed with close-up practical test, calm eye contact, show evidence before making a claim",
    speechMode: "dialogue เป็นหลัก แทรก voiceover ได้เฉพาะตอนสาธิตที่มองเห็นสินค้าเต็มจอ",
  },
  "Problem Solution": {
    goal: "หยิบปัญหาที่กลุ่มเป้าหมายเจอจริงขึ้นมา แล้วแสดงว่าสินค้าช่วยในขั้นตอนไหน",
    structure: "specific pain/frustration → recognizable situation → introduce product → demonstrate how it helps → practical result → CTA",
    writing: "ปัญหาต้องเฉพาะกับสินค้าและกลุ่มเป้าหมาย ไม่ใช้คำกว้างๆ และห้ามอ้างผลลัพธ์เกินจริง",
    videoDirection: "clear problem-to-solution visual arc, start with a recognizable frustrating moment, then show the product solving the exact task in a close-up",
    speechMode: "ผสม dialogue สั้นๆ กับ voiceover ตามจังหวะปัญหาและวิธีแก้",
  },
  Storytelling: {
    goal: "เล่า micro-story ที่มีจุดเปลี่ยนชัดเจนภายในเวลาสั้น ทำให้คนดูอยากรู้ตอนจบ",
    structure: "micro-story setup → problem or curiosity → product discovery → interaction → payoff → CTA",
    writing: "ใช้ตัวละครหลักคนเดียวและสถานที่เดียวเป็นค่าเริ่มต้น เล่าให้กระชับ ไม่สร้างหลายเหตุการณ์จนตามไม่ทัน",
    videoDirection: "short cinematic micro-story with one protagonist and one location, motivated camera movement, visual cause-and-effect, a satisfying payoff on the product",
    speechMode: "voiceover เป็นหลัก หรือ dialogue สั้นๆ เฉพาะจุดเปลี่ยนของเรื่อง",
  },
  "Before After": {
    goal: "ทำให้ความต่างก่อนและหลังเข้าใจได้จากภาพ โดยใช้การเปลี่ยนแปลงที่ตรวจสอบได้และปลอดภัย",
    structure: "before state → transition/product use → after state → clear comparison → CTA",
    writing: "ผลลัพธ์หลังใช้ต้องอิงข้อเท็จจริง ห้ามสร้างการรักษา การเปลี่ยนแปลงทางร่างกาย หรือ performance ที่ไม่มีข้อมูลรองรับ สำหรับสินค้าทั่วไปให้เน้นความเป็นระเบียบ ความสะดวก หรือขั้นตอนการทำงานที่ดีขึ้น",
    videoDirection: "visually obvious before-and-after composition, match the framing across both states, show the transition through real product use, avoid magical transformations",
    speechMode: "voiceover อธิบาย before/after สั้นๆ ปล่อยให้ภาพเป็นหลัก",
  },
  Unboxing: {
    goal: "สร้างความรู้สึกอยากเปิดดูไปพร้อมกัน ตั้งแต่แพ็กเกจหรือสินค้าปรากฏจนถึง first impression",
    structure: "package/object reveal → opening/unwrapping → close-up details → first interaction → quick honest impression → CTA",
    writing: "บรรยายสิ่งที่เห็นจริง อย่าแต่งแพ็กเกจพรีเมียมหรืออุปกรณ์เสริมที่ไม่มีในรูปสินค้า",
    videoDirection: "satisfying unboxing tabletop shot, deliberate hand movements, tactile close-ups of real packaging and product details, reveal the product progressively",
    speechMode: "dialogue สั้นๆ แบบรีแอคชั่นระหว่างแกะกล่อง ไม่พูดยาวทับจังหวะการเปิด",
  },
  Demo: {
    goal: "สาธิตการใช้งานให้คนดูเข้าใจทันทีว่าสินค้าทำอะไรและใช้อย่างไร",
    structure: "task/problem → product setup → actual use → important feature close-up → practical result → CTA",
    writing: "ให้ข้อมูลเท่าที่จำเป็น ไม่ใส่บทพูดยาวจนบังภาพการสาธิต",
    videoDirection: "instructional product demonstration, hands and product stay clearly visible, purposeful close-ups, step-by-step action, minimal decorative shots",
    speechMode: "voiceover สั้นๆ หรือพูดน้อยที่สุด เพื่อให้ภาพการสาธิตเป็นตัวอธิบาย",
  },
  POV: {
    goal: "ทำให้คนดูรู้สึกว่าอยู่ในสถานการณ์นั้นเองและเห็นประโยชน์ของสินค้าจากมุมมองบุคคลที่หนึ่ง",
    structure: "POV situation → immediate friction or desire → hands interact with product → satisfying resolution → CTA",
    writing: "ใช้คำพูดเหมือนคิดหรือพูดกับตัวเองในสถานการณ์จริง ไม่อธิบายกว้างๆ แบบโฆษณา",
    videoDirection: "first-person POV smartphone video, hands enter the frame naturally, immersive close-ups, audience feels present in the real situation, no unnecessary talking head",
    speechMode: "voiceover หรือ dialogue นอกเฟรมแบบสั้นและเป็นธรรมชาติ",
  },
  "ASMR / Satisfying": {
    goal: "ใช้ภาพและเสียงสัมผัสที่ดูเพลิน เช่น เปิด ปิด กด เท จัด หรือวาง ให้คนดูอยากดูจนจบ",
    structure: "visual tease → tactile setup → satisfying product action → detail close-up → clean final arrangement → soft CTA",
    writing: "พูดน้อยมาก ใช้คำอธิบายสั้นๆ เท่าที่จำเป็น ห้ามใส่เสียงหรือการกระทำที่สินค้าไม่สามารถทำได้จริง",
    videoDirection: "clean satisfying ASMR product macro shots, deliberate tactile movements, crisp natural foley, stable composition, no distracting music or exaggerated effects",
    speechMode: "ไม่มีบทพูดหรือมี voiceover เพียง 1-2 ประโยคสั้นๆ เสียงสัมผัสต้องเด่นกว่าเพลง",
  },
  Comparison: {
    goal: "ช่วยคนดูเห็นความต่างระหว่างสินค้ากับทางเลือกทั่วไปอย่างเป็นธรรม ไม่โจมตีคู่แข่งแบบไม่มีหลักฐาน",
    structure: "comparison question → side-by-side setup → one fair practical test → observed difference → best-fit recommendation → CTA",
    writing: "เปรียบเทียบเฉพาะความต่างที่ยืนยันได้จากข้อมูลสินค้า ห้ามตั้งชื่อหรือใส่ข้อเสียของคู่แข่งที่ไม่มีข้อมูลรองรับ",
    videoDirection: "fair side-by-side comparison layout, matching camera angle and lighting for both options, one observable test, neutral evidence-led presentation",
    speechMode: "dialogue หรือ voiceover แบบผู้เชี่ยวชาญที่เป็นกลาง ไม่ใช้น้ำเสียงโจมตี",
  },
  "Challenge / Test": {
    goal: "ตั้งบททดสอบเดียวที่เข้าใจง่ายและปลอดภัย แล้วแสดงผลที่สังเกตได้จริง",
    structure: "challenge setup → define what is being tested → product attempt → visible result → honest takeaway → CTA",
    writing: "การทดสอบต้องไม่อันตราย ไม่หลอกคนดู และห้ามประกาศว่าผ่านหรือได้ผลเกินกว่าที่ภาพแสดง",
    videoDirection: "single safe product test with a clear setup and payoff, energetic but believable pacing, show the test result plainly without spectacle or dangerous stunts",
    speechMode: "dialogue สั้นๆ ตั้งโจทย์และสรุปผล หรือ voiceover ถ้าภาพทดสอบเต็มจอ",
  },
  "Lifestyle Vlog": {
    goal: "แทรกสินค้าเข้าไปใน routine ที่คนดูอยากทำตาม ทำให้เห็นว่าสินค้าเข้ากับชีวิตจริงอย่างไร",
    structure: "daily-life hook → routine context → product naturally enters the routine → useful moment → lifestyle payoff → CTA",
    writing: "พูดเหมือนเล่า routine ให้เพื่อนฟัง เน้นประโยชน์ที่เกิดขึ้นในสถานการณ์จริง ไม่สร้างสถานที่หรือตัวละครมากเกินเวลาคลิป",
    videoDirection: "warm day-in-the-life vlog, natural transitions within one routine, authentic environment, product used as part of the action rather than held up in every shot",
    speechMode: "dialogue แบบ vlog สลับ voiceover ได้เล็กน้อย",
  },
  "Educational Tips": {
    goal: "สอน tip เดียวที่นำไปใช้ได้จริง แล้วให้สินค้าเป็นเครื่องมือในขั้นตอนนั้น",
    structure: "specific question → one useful tip → show the correct step → product supports the step → recap → CTA",
    writing: "สอนเพียงหนึ่งเรื่องให้ชัด ใช้ภาษาง่าย ไม่ทำตัวเป็นผู้เชี่ยวชาญทางการแพทย์ และไม่ใส่ข้อมูลที่ไม่มีหลักฐาน",
    videoDirection: "clear educational short-form tutorial, presenter or hands demonstrate one useful tip, intentional framing with room for a concise visual cue, confident but friendly tone",
    speechMode: "voiceover หรือ dialogue ที่อธิบายเป็นขั้นตอนสั้นๆ",
  },
};

export function getStylePlaybook(style: string): StylePlaybook {
  return (
    STYLE_PLAYBOOKS[style as (typeof CONTENT_STYLES)[number]] ?? {
      goal: "สร้างวิดีโอ TikTok affiliate ที่เป็นธรรมชาติและเน้นการใช้งานจริง",
      structure: "hook → product interaction → concrete benefit → CTA",
      writing: "ภาษาไทยแบบภาษาพูด กระชับ และไม่กล่าวอ้างเกินจริง",
      videoDirection: "natural short-form product video with clear product interaction and varied framing",
      speechMode: "เลือก dialogue หรือ voiceover ให้เหมาะกับภาพ",
    }
  );
}

export function stylePlaybookPrompt(style: string): string {
  const playbook = getStylePlaybook(style);
  return [
    `สไตล์นี้มีเป้าหมาย: ${playbook.goal}`,
    `โครงสร้างบังคับโดยประมาณ: ${playbook.structure}`,
    `แนวทางการเขียน: ${playbook.writing}`,
    `โหมดเสียงพูดที่แนะนำ: ${playbook.speechMode}`,
  ].join("\n");
}

export function styleVideoDirection(style: string): string {
  return getStylePlaybook(style).videoDirection;
}
