/** Standalone copy of src/lib/prompt-engine/style-playbooks.ts for the Chrome extension build. */
/**
 * Creative playbooks shared by content generation and the final video prompt.
 * A style name by itself is too vague for an LLM; each style needs a distinct
 * story shape, speaking mode, and visual language.
 */

/**
 * Video models pronounce plain spoken Thai well but garble digits, English
 * words, abbreviations and symbols — or read them out in English.
 */
export const SPEAKABLE_SCRIPT_RULE =
  "คำพูดทุกประโยค (script, dialogue, voiceover) ต้องเป็นภาษาไทยที่อ่านออกเสียงได้ทันที: เขียนตัวเลขเป็นคำอ่านไทย (เช่น \"สามสิบเก้าบาท\" ไม่ใช่ \"39฿\"), ชื่อแบรนด์หรือคำอังกฤษให้เขียนทับศัพท์เป็นอักษรไทย, ห้ามใช้ตัวย่อ อีโมจิ สัญลักษณ์ (% / + & ~ …) หรือเครื่องหมายคำพูด, ห้ามใช้คำพูดติดปากซ้ำๆ เช่น \"คือแบบ\" \"แบบว่า\" และแต่ละประโยคพูดจบได้ในลมหายใจเดียวแต่ต้องครบความ";

/**
 * Tight budgets made the writer drop subjects and connectors, so lines came
 * out as keyword fragments ("ตื่นมา ผมยุ่งมั้ย เทียบผ้าปกติ") that sound
 * robotic and jump topic. Ask for whole, linked sentences in one story.
 */
export const NATURAL_SPEECH_RULE = [
  "เขียนบทพูดเหมือนคนไทยเล่าให้เพื่อนฟังจริงๆ: ทุกประโยคต้องครบความ มีใครทำอะไรหรือเกิดอะไรขึ้นชัดเจน ห้ามเขียนเป็นวลีห้วนๆ แบบคีย์เวิร์ดต่อกัน",
  "ตัวอย่างที่ห้ามเขียน: \"ตื่นมา ผมยุ่งมั้ย เทียบผ้าปกติ\" — ให้เขียนแบบนี้แทน: \"ตื่นมาทีไรผมยุ่งฟูทุกเช้าเลยใช่ไหม ลองเทียบกับปลอกหมอนผ้าธรรมดาให้ดูนะ\"",
  "ทั้งบทเป็นเรื่องเดียวกันตั้งแต่ hook ถึง CTA: ทุกประโยคต้องต่อจากประโยคก่อนหน้าแบบมีเหตุผล ใช้คำเชื่อมแบบภาษาพูด เช่น เลย, ก็เลย, เพราะ, แล้วก็, พอ...ก็, ที่ชอบคือ ห้ามกระโดดเปลี่ยนเรื่องกลางคัน",
  "พูดถึงจุดขายน้อยข้อแต่อธิบายให้ครบความ ดีกว่าใส่หลายข้อแบบห้วนๆ จนฟังไม่รู้เรื่อง — อ่านออกเสียงแล้วคนฟังครั้งเดียวต้องเข้าใจทันที",
].join("\n");

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

export type ContentStyle = (typeof CONTENT_STYLES)[number];

/**
 * Styles whose message needs a written word on screen (a "before/after" label,
 * a comparison point, a tip title). Video models often draw Thai as made-up
 * letters, so every other style renders with no text at all — TikTok captions
 * carry the message instead.
 */
// Empty on purpose: even short quoted Thai came back as garbled letters, so no
// style asks the video model to draw text. Add a style here to bring it back.
const STYLES_WITH_ON_SCREEN_TEXT = new Set<string>([]);

export function styleUsesOnScreenText(style: string): boolean {
  return STYLES_WITH_ON_SCREEN_TEXT.has(style);
}

export interface StyleLabel {
  /** Thai name shown in style pickers; the English value stays the stored key. */
  name: string;
  /** One-line Thai explanation of what the style looks like. */
  description: string;
}

export const STYLE_LABELS: Record<(typeof CONTENT_STYLES)[number], StyleLabel> = {
  UGC: { name: "คนจริงรีวิวเอง (UGC)", description: "เหมือนครีเอเตอร์ถ่ายเองด้วยมือถือ พูดกับกล้องแบบเป็นกันเอง ดูเป็นธรรมชาติ ไม่เหมือนโฆษณา" },
  Review: { name: "รีวิวสินค้า", description: "ลองใช้ให้ดูจริง บอกจุดเด่นที่เห็นในคลิปและเหมาะกับใคร เน้นความน่าเชื่อถือ" },
  "Problem Solution": { name: "ปัญหา → ทางแก้", description: "เปิดด้วยปัญหาที่คนดูเจอบ่อย แล้วโชว์ว่าสินค้าช่วยแก้ได้อย่างไร" },
  Storytelling: { name: "เล่าเรื่อง", description: "เรื่องสั้นที่มีจุดเปลี่ยน ใช้ตัวละครเดียวและสถานที่เดียว ชวนดูจนจบ" },
  "Before After": { name: "ก่อน-หลังใช้", description: "เทียบภาพก่อนและหลังใช้สินค้าในมุมเดียวกัน ให้เห็นความต่างชัดๆ" },
  Unboxing: { name: "แกะกล่อง", description: "เปิดกล่องให้ดูทีละขั้น โชว์รายละเอียดสินค้าและความรู้สึกแรกที่เห็น" },
  Demo: { name: "สาธิตวิธีใช้", description: "โชว์วิธีใช้งานทีละขั้น เห็นมือกับสินค้าชัด พร้อมเสียงอธิบายว่าแต่ละขั้นดียังไง" },
  POV: { name: "มุมมองคนดู (POV)", description: "ถ่ายจากสายตาคนดู เหมือนกำลังหยิบใช้สินค้าเองในสถานการณ์จริง" },
  "ASMR / Satisfying": { name: "ASMR / ดูเพลิน", description: "ภาพระยะใกล้กับเสียงสัมผัส เช่น เปิด กด เท จัดวาง พูดน้อยมากหรือไม่พูดเลย" },
  Comparison: { name: "เปรียบเทียบ", description: "วางเทียบกับทางเลือกทั่วไปแบบเป็นกลาง ทดสอบให้เห็นความต่างจริง" },
  "Challenge / Test": { name: "ท้าทดสอบ", description: "ตั้งโจทย์ทดสอบง่ายๆ ที่ปลอดภัย แล้วโชว์ผลลัพธ์ให้เห็นตรงๆ" },
  "Lifestyle Vlog": { name: "วล็อกชีวิตประจำวัน", description: "แทรกสินค้าเข้าไปใน routine ประจำวัน ให้เห็นว่าเข้ากับชีวิตจริง" },
  "Educational Tips": { name: "สอนเคล็ดลับ", description: "สอนทริคที่ใช้ได้จริง 1 เรื่อง โดยมีสินค้าเป็นตัวช่วยในขั้นตอนนั้น" },
};

/** Thai label for a stored style value; unknown values are shown as-is. */
export function styleLabel(style: string): StyleLabel {
  return STYLE_LABELS[style as (typeof CONTENT_STYLES)[number]] ?? { name: style, description: "" };
}

export interface StylePlaybook {
  goal: string;
  structure: string;
  writing: string;
  videoDirection: string;
  speechMode: string;
  /** Video prompt: what shoots the advert and from where (replaces one fixed camera for every style). */
  camera: string;
  lighting: string;
  /** Who is in frame: a presenter facing the camera, only hands (and no face), or either. */
  presenter: PresenterMode;
  /** How much is said: a non-stop sales pitch, continuous speech in the style's own tone, or a few lines with room for sounds. */
  speech: SpeechAmount;
  /** How the voice sounds. */
  delivery: string;
  /** What is heard under (or instead of) the voice. */
  soundBed: string;
}

export type PresenterMode = "face" | "hands" | "mixed";
export type SpeechAmount = "sell" | "steady" | "light" | "silent";

const STYLE_PLAYBOOKS: Record<ContentStyle, StylePlaybook> = {
  UGC: {
    goal: "ให้เหมือนครีเอเตอร์ค้นพบหรือกำลังใช้สินค้าจริงแบบเป็นธรรมชาติ ไม่เหมือนโฆษณาทีวี",
    structure: "visual interruption → conversational hook → quick context → product interaction → 1-2 concrete benefits → natural reaction → soft CTA",
    writing: "ใช้ภาษาไทยกันเอง ประโยคสั้น มีความเป็นภาษาพูดได้เล็กน้อย ห้ามเปิดด้วยการแนะนำตัวหรือภาษาขายของแข็งๆ",
    videoDirection: "casual creator UGC, spontaneous handheld smartphone framing, imperfect but believable gestures, natural reaction, one clear product interaction",
    speechMode: "dialogue เป็นหลัก พูดกับกล้องเหมือนแนะนำให้เพื่อนฟัง เว้นจังหวะให้เห็นการใช้สินค้า",
    camera: "handheld smartphone held at arm's length, casual creator framing",
    lighting: "natural window daylight",
    presenter: "face",
    speech: "sell",
    delivery: "a friendly Thai creator sharing one useful discovery with a friend, conversational and lightly persuasive",
    soundBed: "soft upbeat background music kept low under the voice, natural room ambience",
  },
  Review: {
    goal: "รีวิวที่น่าเชื่อถือ มีประโยชน์ และฟังเหมือนคนกำลังช่วยคนดูตัดสินใจซื้อ ไม่ใช่ชมทุกอย่างแบบไม่มีหลักฐาน",
    structure: "hook → first impression → practical test/demo → 2 concrete observations → honest limitation or neutral fit note when relevant → who it suits → CTA",
    writing: "พูดจากสิ่งที่เห็นหรือทดลองในคลิปนี้ ใช้ถ้อยคำเช่น ‘จากที่ลองในคลิปนี้’, ‘จุดที่เห็นชัดคือ’, ‘เหมาะกับคนที่...’ ห้ามอ้างว่าใช้มาหลายวัน/หลายเดือน ซื้อซ้ำ หรือเห็นผลตามเวลา ถ้าไม่มีข้อมูลยืนยัน",
    videoDirection: "trustworthy on-camera product review, medium talking-head framing mixed with close-up practical test, calm eye contact, show evidence before making a claim",
    speechMode: "dialogue เป็นหลัก รีวิวจากสิ่งที่เห็น เว้นช่วงให้ดูหลักฐานหรือการสาธิต แทรก voiceover ได้ตอนเห็นสินค้าเต็มจอ",
    camera: "steady smartphone on a tripod at eye level, medium shot with close-up inserts of the product",
    lighting: "soft even daylight",
    presenter: "face",
    speech: "sell",
    delivery: "a calm, credible reviewer — clear, honest and persuasive, confident rather than hyped",
    soundBed: "very low neutral background music, natural room ambience",
  },
  "Problem Solution": {
    goal: "หยิบปัญหาที่กลุ่มเป้าหมายเจอจริงขึ้นมา แล้วแสดงว่าสินค้าช่วยในขั้นตอนไหน",
    structure: "specific pain/frustration → recognizable situation → introduce product → demonstrate how it helps → practical result → CTA",
    writing: "ปัญหาต้องเฉพาะกับสินค้าและกลุ่มเป้าหมาย ไม่ใช้คำกว้างๆ และห้ามอ้างผลลัพธ์เกินจริง",
    videoDirection: "clear problem-to-solution visual arc, start with a recognizable frustrating moment, then show the product solving the exact task in a close-up",
    speechMode: "พูดต่อเนื่องตั้งแต่เล่าปัญหาจนถึงวิธีแก้ ใช้ dialogue เป็นหลัก แทรก voiceover ได้ตามจังหวะภาพ",
    camera: "handheld smartphone, medium shot moving in to close-ups of the product at work",
    lighting: "natural indoor daylight",
    presenter: "mixed",
    speech: "sell",
    delivery: "relatable and persuasive — a little frustrated while describing the problem, then relieved and enthusiastic about the solution and the call to buy",
    soundBed: "soft upbeat background music kept low under the voice, natural room ambience",
  },
  Storytelling: {
    goal: "เล่า micro-story ที่มีจุดเปลี่ยนชัดเจนภายในเวลาสั้น ทำให้คนดูอยากรู้ตอนจบ",
    structure: "micro-story setup → problem or curiosity → product discovery → interaction → payoff → CTA",
    writing: "ใช้ตัวละครหลักคนเดียวและสถานที่เดียวเป็นค่าเริ่มต้น เล่าให้กระชับ ไม่สร้างหลายเหตุการณ์จนตามไม่ทัน",
    videoDirection: "short cinematic micro-story with one protagonist and one location, motivated camera movement, visual cause-and-effect, a satisfying payoff on the product",
    speechMode: "voiceover เล่าเฉพาะจังหวะสำคัญ ปล่อยให้การกระทำเล่าเรื่องได้ ไม่ต้องพูดกับกล้องหรือชวนซื้อทุกช่วง",
    camera: "cinematic camera on a smooth gimbal with shallow depth of field",
    lighting: "warm, soft cinematic light with gentle contrast",
    presenter: "mixed",
    speech: "steady",
    delivery: "a warm, engaging storyteller with natural emotion, closing with a confident invitation to buy",
    soundBed: "gentle cinematic music kept low under the voice",
  },
  "Before After": {
    goal: "ทำให้ความต่างก่อนและหลังเข้าใจได้จากภาพ โดยใช้การเปลี่ยนแปลงที่ตรวจสอบได้และปลอดภัย",
    structure: "before state → transition/product use → after state → clear comparison → CTA",
    writing: "ผลลัพธ์หลังใช้ต้องอิงข้อเท็จจริง ห้ามสร้างการรักษา การเปลี่ยนแปลงทางร่างกาย หรือ performance ที่ไม่มีข้อมูลรองรับ สำหรับสินค้าทั่วไปให้เน้นความเป็นระเบียบ ความสะดวก หรือขั้นตอนการทำงานที่ดีขึ้น",
    videoDirection: "visually obvious before-and-after composition, match the framing across both states, show the transition through real product use, avoid magical transformations",
    speechMode: "voiceover อธิบาย before/after ต่อเนื่อง ชี้ให้เห็นความต่างและบอกว่าดีกับคนดูอย่างไร",
    camera: "locked-off camera on a tripod with identical framing for the before and the after state",
    lighting: "the same neutral daylight in both states",
    presenter: "mixed",
    speech: "steady",
    delivery: "a clear, convincing narrator pointing out the difference with growing excitement",
    soundBed: "soft background music kept low under the voice",
  },
  Unboxing: {
    goal: "สร้างความรู้สึกอยากเปิดดูไปพร้อมกัน ตั้งแต่แพ็กเกจหรือสินค้าปรากฏจนถึง first impression",
    structure: "package/object reveal → opening/unwrapping → close-up details → first interaction → quick honest impression → CTA",
    writing: "บรรยายสิ่งที่เห็นจริง อย่าแต่งแพ็กเกจพรีเมียมหรืออุปกรณ์เสริมที่ไม่มีในรูปสินค้า",
    videoDirection: "satisfying unboxing tabletop shot, deliberate hand movements, tactile close-ups of real packaging and product details, reveal the product progressively",
    speechMode: "voiceover แบบพูดไปแกะไปจากหลังกล้อง สั้นๆ ไม่กี่ประโยค เว้นจังหวะให้ได้ยินเสียงแกะกล่อง แล้วปิดด้วยการชวนซื้อ",
    camera: "tabletop smartphone shot from slightly above, close on the hands and the package",
    lighting: "bright soft daylight on a clean table",
    presenter: "hands",
    speech: "light",
    delivery: "an excited but soft first-impression voice from behind the camera",
    soundBed: "no music or only very faint music; crisp natural packaging sounds (opening, unwrapping, lifting) clearly audible",
  },
  Demo: {
    goal: "สาธิตการใช้งานให้คนดูเข้าใจทันทีว่าสินค้าทำอะไรและใช้อย่างไร",
    structure: "task/problem → product setup → actual use → important feature close-up → practical result → CTA",
    writing: "เล่าไปพร้อมการสาธิตทุกขั้นตอน บอกด้วยว่าแต่ละขั้นช่วยคนดูอย่างไร แต่คำพูดต้องตรงกับภาพที่เห็น",
    videoDirection: "instructional product demonstration, hands and product stay clearly visible, purposeful close-ups, step-by-step action, minimal decorative shots",
    speechMode: "voiceover อธิบายทุกขั้นตอนไปพร้อมการสาธิต พูดต่อเนื่องแต่ให้ตรงกับสิ่งที่เห็นในภาพ",
    camera: "steady smartphone slightly overhead, close on the hands and the product",
    lighting: "bright even daylight",
    presenter: "hands",
    speech: "sell",
    delivery: "a clear, helpful and persuasive instructor explaining each step and why it helps, then inviting the viewer to buy",
    soundBed: "soft background music kept low, natural sounds of the product in use",
  },
  POV: {
    goal: "ทำให้คนดูรู้สึกว่าอยู่ในสถานการณ์นั้นเองและเห็นประโยชน์ของสินค้าจากมุมมองบุคคลที่หนึ่ง",
    structure: "POV situation → immediate friction or desire → hands interact with product → satisfying resolution → CTA",
    writing: "ใช้คำพูดเหมือนคิดหรือพูดกับตัวเองในสถานการณ์จริง ไม่อธิบายกว้างๆ แบบโฆษณา",
    videoDirection: "first-person POV smartphone video, hands enter the frame naturally, immersive close-ups, audience feels present in the real situation, no unnecessary talking head",
    speechMode: "voiceover หรือเสียงพูดนอกเฟรมแบบคิดดังๆ ต่อเนื่องและเป็นธรรมชาติ",
    camera: "first-person point of view from the viewer's eyes, smartphone at chest height, only the viewer's own hands visible",
    lighting: "the natural light of the real situation",
    presenter: "hands",
    speech: "steady",
    delivery: "natural inner thoughts spoken aloud — casual, relatable and convincing, as if talking to yourself",
    soundBed: "natural ambience of the situation with faint background music",
  },
  "ASMR / Satisfying": {
    goal: "ใช้ภาพและเสียงสัมผัสที่ดูเพลิน เช่น เปิด ปิด กด เท จัด หรือวาง ให้คนดูอยากดูจนจบ",
    structure: "visual tease → tactile setup → satisfying product action → detail close-up → clean final arrangement → soft CTA",
    writing: "พูดน้อยมาก ใช้คำอธิบายสั้นๆ เท่าที่จำเป็น ห้ามใส่เสียงหรือการกระทำที่สินค้าไม่สามารถทำได้จริง",
    videoDirection: "clean satisfying ASMR product macro shots, deliberate tactile movements, crisp natural foley, stable composition, no distracting music or exaggerated effects",
    speechMode: "ไม่มีบทพูดหรือ voiceover ให้เสียงสัมผัสจริงของสินค้าเป็นเสียงหลัก ใช้ภาพเปิดและภาพจบแทนคำพูด ส่วนคำชวนซื้ออยู่ใน caption",
    camera: "macro close-up on a stable tripod",
    lighting: "soft clean studio light",
    presenter: "hands",
    speech: "silent",
    delivery: "a soft, calm near-whisper close to the microphone, slow and gentle",
    soundBed: "no music; crisp, clear natural foley of every touch, click, pour and tap is the main sound",
  },
  Comparison: {
    goal: "ช่วยคนดูเห็นความต่างระหว่างสินค้ากับทางเลือกทั่วไปอย่างเป็นธรรม ไม่โจมตีคู่แข่งแบบไม่มีหลักฐาน",
    structure: "comparison question → side-by-side setup → one fair practical test → observed difference → best-fit recommendation → CTA",
    writing: "เปรียบเทียบเฉพาะความต่างที่ยืนยันได้จากข้อมูลสินค้า ห้ามตั้งชื่อหรือใส่ข้อเสียของคู่แข่งที่ไม่มีข้อมูลรองรับ",
    videoDirection: "fair side-by-side comparison layout, matching camera angle and lighting for both options, one observable test, neutral evidence-led presentation",
    speechMode: "พูดเปรียบเทียบต่อเนื่องแบบผู้เชี่ยวชาญที่เป็นกลาง ไม่ใช้น้ำเสียงโจมตี",
    camera: "locked-off tripod shot with both options side by side in the same frame",
    lighting: "identical neutral daylight on both options",
    presenter: "mixed",
    speech: "steady",
    delivery: "a neutral, knowledgeable and credible voice — confident about the difference without attacking the alternative",
    soundBed: "very low neutral background music",
  },
  "Challenge / Test": {
    goal: "ตั้งบททดสอบเดียวที่เข้าใจง่ายและปลอดภัย แล้วแสดงผลที่สังเกตได้จริง",
    structure: "challenge setup → define what is being tested → product attempt → visible result → honest takeaway → CTA",
    writing: "การทดสอบต้องไม่อันตราย ไม่หลอกคนดู และห้ามประกาศว่าผ่านหรือได้ผลเกินกว่าที่ภาพแสดง",
    videoDirection: "single safe product test with a clear setup and payoff, energetic but believable pacing, show the test result plainly without spectacle or dangerous stunts",
    speechMode: "dialogue ต่อเนื่อง ตั้งโจทย์ เล่าไประหว่างทดสอบ แล้วสรุปผลและชวนซื้อ",
    camera: "handheld smartphone, medium shot with close-ups on the test result",
    lighting: "bright natural daylight",
    presenter: "face",
    speech: "sell",
    delivery: "energetic and curious, building suspense before the result, then convinced and urging the viewer to buy",
    soundBed: "upbeat background music kept low under the voice",
  },
  "Lifestyle Vlog": {
    goal: "แทรกสินค้าเข้าไปใน routine ที่คนดูอยากทำตาม ทำให้เห็นว่าสินค้าเข้ากับชีวิตจริงอย่างไร",
    structure: "daily-life hook → routine context → product naturally enters the routine → useful moment → lifestyle payoff → CTA",
    writing: "พูดเหมือนเล่า routine ให้เพื่อนฟัง เน้นประโยชน์ที่เกิดขึ้นในสถานการณ์จริง ไม่สร้างสถานที่หรือตัวละครมากเกินเวลาคลิป",
    videoDirection: "warm day-in-the-life vlog, natural transitions within one routine, authentic environment, product used as part of the action rather than held up in every shot",
    speechMode: "voiceover เล่า routine แบบเป็นกันเอง หรือ dialogue สั้นๆ ตามเหตุการณ์ เว้นจังหวะให้เห็นการใช้งานจริง",
    camera: "handheld vlog smartphone with natural, gentle movement",
    lighting: "warm natural daylight of a real home",
    presenter: "mixed",
    speech: "steady",
    delivery: "friendly and casual like chatting to a friend, warmly recommending the product and inviting the viewer to buy",
    soundBed: "light lo-fi music kept low, natural ambience",
  },
  "Educational Tips": {
    goal: "สอน tip เดียวที่นำไปใช้ได้จริง แล้วให้สินค้าเป็นเครื่องมือในขั้นตอนนั้น",
    structure: "specific question → one useful tip → show the correct step → product supports the step → recap → CTA",
    writing: "สอนเพียงหนึ่งเรื่องให้ชัด ใช้ภาษาง่าย ไม่ทำตัวเป็นผู้เชี่ยวชาญทางการแพทย์ และไม่ใส่ข้อมูลที่ไม่มีหลักฐาน",
    videoDirection: "clear educational short-form tutorial, presenter or hands demonstrate one useful tip, intentional framing with room for a concise visual cue, confident but friendly tone",
    speechMode: "voiceover หรือ dialogue อธิบายทีละขั้นต่อเนื่องจนจบ tip แล้วชวนซื้อ",
    camera: "steady smartphone on a tripod, medium shot with close-ups on the key step",
    lighting: "bright even daylight",
    presenter: "mixed",
    speech: "steady",
    delivery: "a clear, friendly teacher voice, confident and easy to follow",
    soundBed: "soft background music kept low under the voice",
  },
};

export function getStylePlaybook(style: string): StylePlaybook {
  return (
    STYLE_PLAYBOOKS[style as ContentStyle] ?? {
      goal: "สร้างวิดีโอ TikTok affiliate ที่เป็นธรรมชาติและเน้นการใช้งานจริง",
      structure: "hook → product interaction → concrete benefit → CTA",
      writing: "ภาษาไทยแบบภาษาพูด กระชับ และไม่กล่าวอ้างเกินจริง",
      videoDirection: "natural short-form product video with clear product interaction and varied framing",
      speechMode: "พูดขายต่อเนื่องเกือบตลอดคลิป เลือก dialogue หรือ voiceover ให้เหมาะกับภาพ",
      camera: "handheld smartphone",
      lighting: "natural daylight",
      presenter: "mixed",
      speech: "sell",
      delivery: "an energetic, confident Thai TikTok Shop seller who is actively selling — enthusiastic and persuasive, stressing the benefits and the call to buy",
      soundBed: "soft background music kept low under the voice, natural room ambience",
    }
  );
}

export function stylePlaybookPrompt(style: string): string {
  const playbook = getStylePlaybook(style);
  return [
    `สไตล์นี้มีเป้าหมาย: ${playbook.goal}`,
    `โครงเรื่องของสไตล์นี้ (ให้ยึดเป็นหลักแล้วลดจำนวนจังหวะตามความยาว): ${playbook.structure}`,
    `แนวทางการเขียน: ${playbook.writing}`,
    `โหมดเสียงพูดที่แนะนำ: ${playbook.speechMode}`,
  ].join("\n");
}


/**
 * Share of the speaking budget a style fills. Quiet styles (ASMR, unboxing)
 * leave room for the product's sounds instead of talking over them.
 */
export function speechShare(speech: SpeechAmount): [number, number] {
  if (speech === "silent") return [0, 0];
  if (speech === "light") return [0, 0.25];
  return speech === "sell" ? [0.65, 0.8] : [0.5, 0.7];
}

/**
 * A short line leaves the presenter silent for most of a clip and does not
 * sell; this asks for a concrete pitch that still fits the speaking budget and
 * the claim-safety rules. How hard it sells follows the style: a TikTok Shop
 * hard sell suits UGC or a demo, not an ASMR clip or a neutral comparison.
 */
export function sellingScriptRule(speech: SpeechAmount): string {
  if (speech === "silent") return 'script ต้องเป็นสตริงว่าง "" ไม่มีบทพูด ใช้ hook เป็นคำอธิบายภาพเปิด ส่วน cta เป็นคำชวนซื้อสำหรับ caption เท่านั้น';
  return [
    "script ต้องเป็นคำพูดขายที่น่าเชื่อ ไม่ใช่แค่บรรยายภาพ: ทุกจุดขายต้องบอกด้วยว่าดียังไงกับคนดู (เช่น ใช้แล้วประหยัดเวลาตอนไหน เก็บของได้มากขึ้นแค่ไหน) ไม่ใช่พูดลอยๆ ว่าดีหรือคุ้ม",
    "ใส่รายละเอียดที่จับต้องได้จากข้อมูลสินค้า เช่น วัสดุ ขนาด วิธีใช้ จำนวนชิ้น เพื่อให้ฟังแล้วรู้สึกว่าคนพูดใช้สินค้าจริง",
    "บอกให้ชัดว่าเหมาะกับใครหรือใช้ตอนไหน แล้วปิดด้วย CTA ที่ชวนกดตะกร้าเหลืองอย่างมั่นใจ",
    ...(speech === "sell"
      ? [
          "หนึ่งช่วงวิดีโอเน้นประโยชน์หลักหนึ่งข้อ อธิบายให้ครบความ เว้นจังหวะให้เห็นการใช้งานและผลลัพธ์ ห้ามอัดหลายจุดขายจนพูดไม่ทัน",
          "ชวนซื้อด้วยประโยชน์ที่ยืนยันได้ ใช้น้ำเสียงและวิธีพูดของสไตล์นี้ ปิดด้วย CTA สั้นเพียงครั้งเดียวท้ายวิดีโอ ห้ามแต่งโปรโมชันหรือราคา",
          "ประโยคครบความและต่อกันเป็นเรื่องเดียว มีจังหวะหายใจและช่วงให้ภาพเล่าเรื่อง ไม่ต้องพูดเต็มทุกวินาที",
        ]
      : speech === "steady"
      ? [
          "เล่าด้วยน้ำเสียงของสไตล์นี้ พูดเฉพาะสิ่งที่ช่วยให้เข้าใจภาพ เว้นช่วงให้เห็นขั้นตอนหรือผลลัพธ์โดยไม่ต้องบรรยายทุกวินาที",
          "ประโยคครบความและต่อกันเป็นเรื่องเดียว มีจังหวะหายใจและช่วงให้ภาพเล่าเรื่อง ไม่ต้องพูดเต็มทุกวินาที",
        ]
      : [
          "สไตล์นี้พูดน้อยโดยตั้งใจ: ใช้ประโยคสั้นไม่กี่ประโยค เว้นช่วงให้ภาพและเสียงของสินค้าเล่าเรื่อง พูดได้เพียงประโยคสั้นที่เพิ่มความเข้าใจ ปิดด้วย CTA สั้นถ้ามีงบเหลือ หรือเก็บคำชวนซื้อไว้ใน caption",
        ]),
    "ห้ามพูดวนซ้ำความเดิมเพื่อให้ยาวขึ้น ทุกประโยคต้องเพิ่มข้อมูลใหม่หรือเหตุผลใหม่ที่ทำให้อยากซื้อ",
  ].join("\n");
}

/** Who may appear on screen, for the storyboard writer. */
export function presenterRule(presenter: PresenterMode): string {
  if (presenter === "hands") {
    return "สไตล์นี้เห็นแค่มือกับสินค้า ห้ามมีหน้าหรือหัวคนในเฟรม: visual บรรยายมือ (เรียกว่า \"the hands\") กับสินค้า, ใช้ voiceover เท่านั้น (dialogue เป็นสตริงว่างทุกฉาก) และ castOptions.person ทุกลุคต้องเป็นลักษณะมือ เช่น \"hands only, short clean nails, light beige sleeves\"";
  }
  return presenter === "face"
    ? "สไตล์นี้มีคนพูดกับกล้อง: คนในภาพหันหน้าเข้ากล้องเป็นหลัก และ castOptions ทุกลุคต้องเห็นหน้าคน"
    : "คนในภาพสนใจการกระทำและสินค้าตามเรื่อง มองสิ่งที่กำลังทำ ไม่ต้องหันหน้าหรือพูดกับกล้องทุกฉาก แทรกช็อตมือและสินค้าได้ตามสไตล์";
}

/** Conservative character budgets leave room for breathing and the product action. */
export function speechBudget(seconds: number, speech: SpeechAmount): [number, number] {
  return speechShare(speech).map((share) => Math.floor(seconds * 10 * share)) as [number, number];
}

export function speechLength(text: string): number {
  return Array.from(text.trim().replace(/\s+/g, " ")).length;
}

/** Gender is picked later; reserve room for the longer male polite particle. */
export function speechBudgetUsage(text: string): number {
  return speechLength(text.replace(/(?:ค่ะ|คะ)(?=[\s!?,.]|$)/g, "ครับ"));
}

export function assertSpeechFits(text: string, seconds: number, speech: SpeechAmount): void {
  const max = speechBudget(seconds, speech)[1];
  if (speechBudgetUsage(text) > max) {
    throw new Error(`บทพูดใช้งบ ${speechBudgetUsage(text)} ตัวอักษรรวมเผื่อคำลงท้าย เกินงบ ${max} ตัวอักษรสำหรับ ${seconds} วินาที — เขียนบทและวางฉากใหม่ให้พอดีเวลา`);
  }
}

/** Duration limits the number of beats, never replaces the selected style's story. */
export function styleStoryRule(seconds: number): string {
  return `ยึดโครงเรื่องของสไตล์ที่เลือก: ${seconds <= 10 ? "ย่อเหลือภาพเปิด → การกระทำหลักหนึ่งอย่าง → ภาพจบ เน้นประโยชน์เดียว" : seconds <= 20 ? "เลือก 3-4 จังหวะ เน้นประโยชน์เดียวพร้อมหลักฐานที่เห็นในภาพ" : "เลือก 4-5 จังหวะ เพิ่มรายละเอียดเฉพาะที่ช่วยให้เข้าใจ ไม่เกินสองประโยชน์"} ไม่ต้องเปลี่ยนทุกสไตล์เป็นปัญหา-ทางแก้ และไม่ต้องชวนซื้อทุกช่วง`;
}

const STYLE_PERFORMANCE: Partial<Record<ContentStyle, string>> = {
  UGC: "Talk naturally to the lens like sharing a useful discovery with a friend. Show one product interaction and a small genuine reaction.",
  Review: "Alternate natural eye contact with attention to the product test. Let the observable evidence lead the recommendation.",
  "Problem Solution": "React to the specific everyday problem, then focus on using the product to address that task. Look at the action while demonstrating.",
  Storytelling: "Act the small story through the task and a subtle reaction. Look at the objects and action; address the lens only if the planned dialogue calls for it.",
  "Before After": "Show the before and after states from the same camera position, distance and light. Keep the change visible without presenter posing.",
  Unboxing: "Only hands unpack one item, reveal a real detail, then pause so it can be seen. Let packaging sounds lead.",
  Demo: "Only hands demonstrate one clear use step. Keep the contact point visible, complete the action and hold the practical result.",
  POV: "Show the task from the viewer's eyes. Hands enter naturally and use the product; no external view of a presenter.",
  "ASMR / Satisfying": "Only hands perform one tactile action in close-up. Let the real touch, click or pour be heard clearly, with no speech or music.",
  Comparison: "Keep both options visible under identical framing and light. Show one fair test and its observable difference.",
  "Challenge / Test": "Introduce one safe test, focus on carrying it out, then show the result with an honest reaction.",
  "Lifestyle Vlog": "Continue the daily routine naturally. Use the product as part of the task, with attention on the activity rather than presenting it to the lens.",
  "Educational Tips": "Demonstrate one useful tip. Keep the important step visible and pause on the correct result.",
};

export function stylePerformance(style: string): string {
  return STYLE_PERFORMANCE[style as ContentStyle] ?? "Focus on one believable product interaction with a natural reaction.";
}

const LOCKED_CAMERA_STYLES = new Set(["Before After", "Comparison", "ASMR / Satisfying", "Demo", "Educational Tips"]);

export function styleCameraMotion(style: string, planned?: string): string {
  if (LOCKED_CAMERA_STYLES.has(style)) return "static locked-off camera; maintain the same framing throughout the action";
  return planned?.trim() || (style === "UGC" || style === "Lifestyle Vlog"
    ? "steady handheld framing with minimal natural movement"
    : "one gentle slow push-in, settling on the product action");
}

export function shotPlanningRule(style: string): string {
  return [
    `การแสดงของสไตล์นี้: ${stylePerformance(style)}`,
    `กล้องหลัก: ${styleCameraMotion(style)} เลือกการเคลื่อนกล้องหลักเพียงอย่างเดียวต่อ clip`,
    "แต่ละ clip ต้องระบุใน visual: ระยะภาพและตำแหน่งกล้อง, สินค้าอยู่ตรงไหนตอนเริ่ม, การกระทำหลักเพียงอย่างเดียวที่ทำจบได้จริง, และสถานะสินค้าหรือมือเมื่อจบ",
    "จัดเฟรมให้จุดใช้งานของสินค้าเห็นชัด พื้นหลังไม่แย่งความสนใจ แสงทำให้เห็นผิววัสดุจริง มือไม่บังจุดที่กำลังสาธิต และเผื่อพื้นที่ขอบภาพสำหรับ UI ของ TikTok",
    "เริ่ม clip แรกด้วยภาพที่เข้าใจได้ทันทีตามสไตล์ ไม่เสียเวลาหยิบของหลายขั้น ถ้าต้องสาธิตให้สินค้าอยู่ในตำแหน่งพร้อมใช้ตั้งแต่แรก",
    "ช่วงท้ายของ clip สุดท้ายให้เห็นผลลัพธ์หรือรายละเอียดสำคัญชัดประมาณหนึ่งวินาที โดยไม่เพิ่มการกระทำใหม่ ส่วน clip กลางจบด้วยสถานะที่ clip ถัดไปทำต่อได้",
  ].join("\n");
}
