# AI-TikTok Prompt & Video Generation Pipeline Improvement Plan

> Status: Planning only — **do not implement yet**
>
> Project: `Desktop/AI-tiktok`
>
> Scope: Improve the prompt pipeline from product analysis → TikTok content generation → scene planning → Veo/Flow prompt generation → multi-clip continuity → final TikTok-ready video.
>
> Primary goal: Make generated videos feel like intentional TikTok affiliate content rather than generic AI video clips, while keeping the product visually correct, dialogue natural, scenes paced to duration, and repeated generations meaningfully different.

---

# 1. Why this plan exists

The current project already has the right high-level architecture:

```text
Product Data
  ↓
Product Analysis
  ↓
Content / Script Generation
  ↓
Scene Planning
  ↓
Prompt Engine
  ↓
Flow / Veo
  ↓
Generated Clips
  ↓
Merge
  ↓
TikTok Post
```

The main problem is not the overall architecture. The problem is that important information is lost between stages.

The biggest example is the spoken script:

```text
Gemini generates:
- hook
- script
- caption
- CTA

Scene planner uses the script

BUT

Final Veo prompt mainly receives:
- product name
- shot list
- camera
- lighting
- continuity rules
- on-screen text
```

The final video-generation model therefore knows roughly **what should be shown**, but not precisely **what the person should say**.

This creates a pipeline where the content-writing stage can be good while the actual generated video still feels generic.

The improvement plan therefore focuses on preserving important creative intent all the way to the video provider.

---

# 2. Files currently involved

The main prompt-related implementation currently lives in these files:

```text
extension/src/lib/analysis-prompts.ts
extension/src/lib/prompt-engine.ts
extension/src/background.ts
extension/src/flow-automation.ts
extension/src/lib/store.ts
extension/src/lib/autopilot.ts
extension/src/sidepanel.ts

src/services/analysis.service.ts
src/services/content.service.ts
src/services/scene.service.ts
src/services/video.service.ts
src/lib/prompt-engine/prompt-builder.ts
src/lib/prompt-engine/clip-planner.ts
src/lib/prompt-engine/types.ts
```

There are effectively two prompt implementations:

```text
A. Extension-side prompt pipeline
   extension/src/lib/*

B. Original/server-side prompt pipeline
   src/services/*
   src/lib/prompt-engine/*
```

The extension version has already evolved further than the server-side version.

This duplication should eventually be reduced so prompt behavior cannot drift between the two paths.

---

# 3. Current strengths that should be preserved

The following existing decisions are good and should remain:

- Product images are provided to Gemini during analysis/content/scene generation.
- Flow attaches the real product image as a product reference.
- Later clips can use the previous generated clip as a continuity reference.
- The prompt engine separates scene planning from provider-specific prompt rendering.
- The project already understands that multi-part clips need continuity instructions.
- Repeated generations already receive a variation instruction.
- The system attempts to keep Thai text short.
- The system separates TikTok caption generation from video rendering.
- Product analysis is already separated from content generation.
- Video generation can be run manually or through autopilot.

The goal is to build on these strengths rather than rewrite the entire architecture.

---

# 4. Highest-priority problems

## P0-1 — Spoken script is not preserved into the final video prompt

Current flow:

```text
buildContentPrompt()
  ↓
contentResult.script
  ↓
buildScenePrompt(product, contentResult.script, ...)
  ↓
scene descriptions
  ↓
buildVeoPrompt()
```

The spoken wording becomes indirect context instead of explicit video-generation instructions.

A final prompt can contain:

```text
Spoken language: Thai.
```

but that does not tell Veo what to say.

### Required change

Each scene should be able to carry explicit speech information.

Proposed scene structure:

```ts
interface Scene {
  duration: number;
  description: string;
  cameraMotion?: string;
  dialogue?: string;
  voiceover?: string;
}
```

Rules:

```text
- dialogue = person visible on screen speaks this line
- voiceover = narrator/off-screen audio speaks this line
- a scene should normally use one or the other, not both
- either can be empty for purely visual scenes
```

Example:

```json
{
  "duration": 3,
  "description": "ผู้หญิงหยิบสินค้าเข้าหากล้องและยิ้มเล็กน้อย",
  "cameraMotion": "slow handheld push-in",
  "dialogue": "ตอนแรกไม่ได้คาดหวังเลย แต่ตัวนี้ใช้สะดวกกว่าที่คิด",
  "voiceover": ""
}
```

Final provider prompt should explicitly include:

```text
[DIALOGUE]
The woman naturally says in Thai:
"ตอนแรกไม่ได้คาดหวังเลย แต่ตัวนี้ใช้สะดวกกว่าที่คิด"

Natural Thai pronunciation.
Natural conversational rhythm.
Accurate lip sync where the speaker is visible.
Do not translate the dialogue.
Do not invent additional spoken lines.
```

### Acceptance criteria

A generated content script must remain traceable into scene-level dialogue/voiceover, and the final Veo prompt must contain the actual Thai lines intended for the clip.

---

## P0-2 — Content generation does not know target video duration

Currently `buildContentPrompt()` receives product, analysis, style, and image state, but not the chosen final video duration.

That means an 8-second video and a 32-second video can receive similarly sized scripts.

### Required change

Change the content generation function signature conceptually from:

```ts
buildContentPrompt(product, analysis, style, hasImages)
```

to:

```ts
buildContentPrompt(
  product,
  analysis,
  style,
  targetDuration,
  hasImages,
)
```

The content prompt should explicitly tell the model the timing budget.

Example duration guidance:

```text
Target video duration: 24 seconds.

Write spoken content that can realistically be delivered within approximately 19–21 seconds.
Reserve the remaining time for:
- visual hook
- product close-up
- reaction beats
- final CTA

Do not write a 40-second monologue for a 24-second video.
```

### Suggested speaking budgets

```text
8 seconds  → ~15–22 Thai spoken syllable groups / very short line
16 seconds → short hook + 2 concise benefit beats + CTA
24 seconds → hook + problem/context + demo + benefit + CTA
32 seconds → hook + context + demo + 2–3 benefits + conclusion + CTA
```

Do not rely only on word count because Thai token/word segmentation is inconsistent.

The better validation is estimated speaking duration.

### Acceptance criteria

Scripts generated for 8/16/24/32 seconds should clearly differ in length and structure.

---

## P0-3 — Product analysis generates `angles` but content generation does not use them

Current analysis schema already contains:

```ts
interface ProductAnalysis {
  targetCustomer: string;
  painPoints: string[];
  sellingPoints: string[];
  angles: string[];
}
```

But content generation currently passes target customer, pain points, and selling points while effectively ignoring the generated angles.

### Required change

The selected or generated content angle should become explicit input to content generation.

Example:

```text
Chosen creative angle:
"คนที่เบื่อของชิ้นใหญ่พกยาก → เจอตัวนี้ → ทดลองใช้จริง → ประทับใจเรื่องความสะดวก"
```

The content generator should be instructed:

```text
Build the entire hook, script, visual logic and CTA around this angle.
Do not switch to a different sales angle halfway through the video.
```

### Selection strategy

For manual mode:

```text
- show analysis angles in UI
- allow user to choose one
- optionally offer "Auto"
```

For autopilot:

```text
- select an angle automatically
- rotate through angles on repeated runs
- avoid reusing the exact same angle for the same product until all angles are used
```

### Acceptance criteria

Two generations using different angles for the same product should result in visibly different story logic, not just different wording.

---

## P0-4 — Scene count is fixed at 3–5 regardless of video duration

Current scene prompt asks for approximately 3–5 scenes even when target duration can be 8, 16, 24, or 32 seconds.

This becomes problematic for longer videos.

Example failure case:

```text
32-second target
↓
only 3 generated scenes
↓
clip planner needs 4 x 8-second clips
↓
scene distribution becomes sparse
↓
scenes may repeat or get stretched unnaturally
```

### Required change

Scene count should scale with target duration.

Recommended starting ranges:

```text
8s  → 3–4 scenes
16s → 4–6 scenes
24s → 6–8 scenes
32s → 8–10 scenes
```

These are not strict artistic limits; they are planning defaults.

More importantly, scene planning should align with the 8-second generation boundary.

Preferred mental model:

```text
24-second video
  ↓
Clip 1: 0–8s
Clip 2: 8–16s
Clip 3: 16–24s
```

Each planned scene should know which clip block it belongs to or at least be easily partitionable into those blocks.

### Acceptance criteria

No target duration should require the clip planner to repeat the same scene merely because too few scenes were generated.

---

## P0-5 — Prompt says `16:9 vertical format`

Current Flow submission string effectively follows this pattern:

```ts
Generate exactly one 8-second video (no images) in ${aspectRatio} vertical format.
```

For `16:9`, this becomes semantically contradictory.

### Required change

Generate format wording based on the actual aspect ratio.

```ts
9:16 → "9:16 portrait vertical video"
16:9 → "16:9 landscape video"
```

### Acceptance criteria

No provider prompt should contain contradictory orientation instructions.

---

# 5. Product understanding improvements

## P1-1 — Add product visual identity / product lock data

The current product reference image is useful, but the system becomes fragile if the image attachment fails or must be removed during a retry.

The analysis stage should create a textual visual identity fallback.

Proposed additions to `ProductAnalysis`:

```ts
interface ProductVisualIdentity {
  productType: string;
  primaryColor?: string;
  secondaryColors?: string[];
  shape?: string;
  material?: string;
  packaging?: string;
  visibleBrandText?: string;
  distinctiveFeatures: string[];
}
```

Example:

```json
{
  "productType": "กระบอกน้ำสแตนเลสมีฝาปิด",
  "primaryColor": "ดำด้าน",
  "secondaryColors": ["เงิน"],
  "shape": "ทรงกระบอกสูง",
  "material": "สแตนเลส",
  "packaging": "ไม่มีบรรจุภัณฑ์ในภาพอ้างอิง",
  "visibleBrandText": "",
  "distinctiveFeatures": [
    "ฝาเกลียวสีดำ",
    "หูจับด้านบน",
    "ผิวด้าน"
  ]
}
```

Final video prompt can then include:

```text
[PRODUCT IDENTITY]
A matte black stainless-steel bottle with a black screw lid and top carry handle.
Do not change its shape, material, colour, cap type or distinctive features.
```

This should be included even when a product image is attached.

Image reference remains the strongest source; text becomes fallback reinforcement.

---

## P1-2 — Distinguish verified facts from inferred marketing ideas

The product analysis should separate facts from creative interpretation.

Proposed shape:

```ts
interface ProductAnalysis {
  targetCustomer: string;
  painPoints: string[];
  sellingPoints: string[];
  angles: string[];
  verifiedFacts: string[];
  inferredBenefits: string[];
  prohibitedClaims: string[];
  visualIdentity: ProductVisualIdentity;
}
```

Definitions:

```text
verifiedFacts
= directly supported by product data or product images

inferredBenefits
= reasonable marketing interpretations but not hard claims

prohibitedClaims
= claims the model must not invent without evidence
```

Example:

```text
Verified fact:
"มีหูจับบนฝา"

Reasonable inferred benefit:
"พกพาสะดวก"

Unverified / prohibited claim:
"เก็บความเย็น 24 ชั่วโมง"
```

### Why this matters

The current prompt tells the model not to invent incompatible properties, but it should also avoid inventing believable-looking specifications.

The main risk is not absurd output. It is plausible but unsupported output.

---

# 6. Content-generation redesign

## P1-3 — Replace generic style labels with style playbooks

Current content styles:

```text
UGC
Review
Problem Solution
Storytelling
Before After
Unboxing
Demo
```

At present the model mainly receives the style name.

Each style should instead have an explicit creative playbook.

---

## UGC playbook

Goal:

```text
Feel like a casual creator discovered or is demonstrating the product naturally.
```

Suggested structure:

```text
0. visual interruption / creator enters frame
1. conversational hook
2. quick context
3. product interaction
4. one or two believable benefits
5. natural reaction
6. soft CTA
```

Prompt guidance:

```text
- casual Thai speech
- short sentences
- slight conversational imperfections are okay
- avoid corporate advertising language
- avoid sounding like a TV commercial announcer
- keep product handling believable
```

---

## Review playbook

Suggested structure:

```text
Hook
→ first impression
→ practical test/demo
→ what stands out
→ realistic limitation/neutral observation when appropriate
→ who it suits
→ CTA
```

Important rule:

```text
Do not pretend the creator has used the product for days/weeks unless that experience exists in the input data.
```

Good phrasing:

```text
"จากที่ลองในคลิปนี้..."
"จุดที่เห็นชัดคือ..."
"ถ้าชอบแบบที่... ตัวนี้น่าสนใจ"
```

Avoid fabricated experience:

```text
"ใช้มา 3 เดือนแล้ว"
"ซื้อซ้ำรอบที่ 4"
"ใช้ทุกวันจนชีวิตเปลี่ยน"
```

unless explicitly supported.

---

## Problem Solution playbook

Suggested structure:

```text
Pain / frustration
→ recognizable situation
→ introduce product
→ demonstrate how it helps
→ visible or practical result
→ CTA
```

The pain point should match the chosen target customer.

---

## Storytelling playbook

Suggested structure:

```text
Micro-story setup
→ problem or curiosity
→ discovery
→ interaction with product
→ payoff
→ CTA
```

For short durations, the story must remain simple.

Do not create multiple characters or locations unless the duration supports it.

---

## Before After playbook

Suggested structure:

```text
Before state
→ transition / product use
→ after state
→ comparison
→ CTA
```

Important factuality rule:

```text
The "after" state must not depict a medical, cosmetic, performance or other transformation that is unsupported by product facts.
```

For many products, before/after can mean usability rather than physical transformation.

Example:

```text
Before: โต๊ะรก สายชาร์จพันกัน
After: จัดสายด้วยสินค้าแล้วโต๊ะเป็นระเบียบ
```

This is safer and visually clearer than invented performance claims.

---

## Unboxing playbook

Suggested structure:

```text
Package/object reveal
→ opening/unwrapping
→ close-up details
→ first interaction
→ quick impression
→ CTA
```

If no packaging reference exists, do not invent branded luxury packaging.

---

## Demo playbook

Suggested structure:

```text
What problem/task is being demonstrated
→ product setup
→ actual use
→ important feature close-up
→ result
→ CTA
```

For Demo style, visual clarity is more important than long dialogue.

---

# 7. Hook generation improvements

The hook should not be one generic field generated without constraints.

Proposed generation metadata:

```ts
interface GeneratedContent {
  hook: string;
  hookType: string;
  script: string;
  caption: string;
  cta: string;
  onScreenText?: string;
  onScreenCta?: string;
  angle: string;
}
```

Possible hook types:

```text
problem
curiosity
contrarian
reaction
question
visual-first
comparison
specific-person
unexpected-use
```

Examples:

```text
Problem:
"ใครเจอปัญหานี้ทุกเช้าต้องดู"

Curiosity:
"ชิ้นเล็กแค่นี้ทำไมคนใช้กันเยอะ"

Specific person:
"ถ้าคุณพกของไปทำงานทุกวัน อันนี้น่าจะเข้าใจเลย"

Reaction:
"อันนี้เกินที่คิดไว้จริง"
```

### Anti-repetition rule

When multiple videos are generated for one product:

```text
- rotate hook type
- rotate angle
- rotate opening visual
- rotate speaker persona
- rotate location when continuity does not require sameness
```

Variation should be planned before Veo, not left solely to a final sentence like:

```text
make it clearly different
```

---

# 8. Script structure improvements

The content model should generate a structured script rather than only one long free-text script.

Proposed structure:

```ts
interface ScriptBeat {
  type:
    | "hook"
    | "problem"
    | "context"
    | "demo"
    | "benefit"
    | "reaction"
    | "proof"
    | "cta";
  text: string;
  estimatedSeconds: number;
}

interface GeneratedContent {
  hook: string;
  script: string;
  beats: ScriptBeat[];
  caption: string;
  cta: string;
  ...
}
```

Example:

```json
{
  "beats": [
    {
      "type": "hook",
      "text": "ใครพกแก้วใหญ่แล้วกินพื้นที่กระเป๋าตลอด ดูนี่",
      "estimatedSeconds": 3
    },
    {
      "type": "demo",
      "text": "ตัวนี้ทรงค่อนข้างกระชับ แล้วมีหูจับบนฝา",
      "estimatedSeconds": 4
    },
    {
      "type": "benefit",
      "text": "เวลาถือเดินหรือหยิบจากกระเป๋าง่ายขึ้นเยอะ",
      "estimatedSeconds": 4
    },
    {
      "type": "cta",
      "text": "ใครชอบแนวนี้กดดูในตะกร้าได้",
      "estimatedSeconds": 3
    }
  ]
}
```

This creates a clean bridge from content strategy to scene planning.

---

# 9. Scene schema redesign

The current scene schema is too visually minimal.

Recommended target schema:

```ts
interface Scene {
  duration: number;

  // Visual
  description: string;
  shotType?: string;
  subjectAction?: string;
  productAction?: string;
  environment?: string;

  // Camera
  cameraMotion?: string;

  // Audio
  dialogue?: string;
  voiceover?: string;
  soundCue?: string;

  // Editing / continuity
  transition?: string;
  continuityNotes?: string;

  // Optional content mapping
  beatType?: string;
}
```

Example:

```json
{
  "duration": 3,
  "shotType": "medium close-up",
  "description": "หญิงวัยทำงานยืนข้างโต๊ะทำงาน หยิบสินค้าจากกระเป๋าแล้วหันให้กล้องเห็น",
  "subjectAction": "หยิบสินค้าและพูดกับกล้องแบบเป็นกันเอง",
  "productAction": "ยกสินค้าให้เห็นรูปทรงและฝาชัดเจน",
  "cameraMotion": "slow handheld push-in",
  "dialogue": "ถ้าใครพกของไปทำงานทุกวัน ตัวนี้น่าสนใจตรงนี้เลย",
  "voiceover": "",
  "soundCue": "natural room ambience",
  "transition": "continue hand movement into the next shot",
  "continuityNotes": "same woman, same black shirt, same desk, same daylight",
  "beatType": "hook"
}
```

---

# 10. Scene-planning prompt requirements

The scene planner should receive:

```text
- product data
- product visual identity
- verified facts
- selected content style
- selected creative angle
- target duration
- structured script beats
- full script
- hook
- CTA
- image reference availability
```

The prompt should explicitly require:

```text
1. Every spoken script beat must map to one or more scenes.
2. Do not silently drop the hook or CTA.
3. Do not repeat the same action in several scenes.
4. Product use must be physically plausible.
5. Keep character/location continuity when scenes belong to the same narrative.
6. Build transitions that can work across separate 8-second generations.
7. The last scene of each 8-second block should end on a stable, continuable pose or motion.
8. The first scene of the next block should clearly continue that pose/motion.
9. Use visual storytelling rather than having the person hold the product toward camera in every scene.
10. Dialogue must fit inside each scene duration.
```

---

# 11. Plan directly around 8-second generation blocks

Veo/Flow is currently operated around 8-second generations.

Instead of planning an arbitrary 24-second storyboard and slicing it later, the planning stage should be aware of provider clip boundaries.

Example 24-second structure:

```text
CLIP 1 — 0–8s
- visual hook
- problem/context
- introduce product

CLIP 2 — 8–16s
- interaction/demo
- benefit
- reaction

CLIP 3 — 16–24s
- second benefit / conclusion
- product hero shot
- CTA
```

Each clip can still contain multiple micro-scenes.

This reduces the need for `planClips()` to guess how to divide scenes afterward.

Possible future model:

```ts
interface PlannedVideo {
  targetDuration: number;
  clips: PlannedClipBlock[];
}

interface PlannedClipBlock {
  clipIndex: number;
  duration: 8;
  scenes: Scene[];
  continuityFromPrevious?: string;
  continuityToNext?: string;
}
```

This is the preferred long-term structure.

---

# 12. Final Veo prompt redesign

The final provider prompt should be sectioned and priority-oriented.

Recommended structure:

```text
[GOAL]
Create exactly one 8-second TikTok-style video segment.
This segment belongs to part 2 of a continuous 24-second advertisement.

[FORMAT]
9:16 portrait vertical.
Realistic smartphone UGC footage.
Natural handheld movement.

[PRODUCT REFERENCE]
The attached image is the exact advertised product.
Preserve its shape, colours, material, packaging, visible logo and printed text.
Do not replace it with a generic or similar item.

[PRODUCT IDENTITY]
<text fallback from ProductAnalysis.visualIdentity>

[CHARACTER CONTINUITY]
Same Thai woman as previous part.
Same face, hairstyle, body proportions, clothing and accessories.

[LOCATION CONTINUITY]
Same desk / room / time of day.
Same light direction and colour temperature.

[STORY CONTEXT]
Earlier part already showed:
<short summary>
Do not repeat these actions.

[TIMELINE]
0.0–2.0s: ...
2.0–5.0s: ...
5.0–8.0s: ...

[DIALOGUE]
0.0–3.5s — speaker says naturally in Thai:
"..."

4.0–7.0s — speaker says:
"..."

Do not translate.
Do not add extra dialogue.

[CAMERA]
Continue from the previous clip's final camera position.
Then perform: ...

[AUDIO]
Clear natural Thai speech.
Natural room ambience.
No dramatic cinematic music unless requested.

[CONTINUITY OUT]
End with the speaker's right hand moving toward the product on the desk.
Hold a stable final frame that the next segment can continue.

[AVOID]
No jump cut at the beginning.
No product morphing.
No duplicate products.
No warped hands.
No extra fingers.
No sudden wardrobe change.
No unexplained room change.
No fake logos.
No invented packaging.
No extra spoken lines.
No random English overlay text.
```

The exact wording can later be optimized through testing.

The key principle is that the prompt should separate:

```text
what must remain identical
vs
what must change
vs
what must happen now
```

---

# 13. Dialogue and audio strategy

## Dialogue modes

Support at least three content modes:

```text
1. On-camera dialogue
2. Voiceover narration
3. Visual-only / music / ambience
```

Style defaults can differ.

Example:

```text
UGC → mostly on-camera dialogue
Review → on-camera + occasional voiceover
Demo → mostly voiceover or minimal dialogue
Unboxing → reaction dialogue + ambient sound
Storytelling → voiceover may be preferable
```

## Lip-sync rules

When using on-camera dialogue:

```text
- speaker face should be visible when speech begins
- avoid very fast head turns during important lines
- keep dialogue length realistic for duration
- do not put long sentences into 1–2 second scenes
```

## Dialogue language rules

Final provider prompt:

```text
Speak exactly the provided Thai dialogue.
Do not translate to English.
Do not paraphrase.
Do not add filler words unless explicitly present.
Use natural Thai pronunciation and conversational pacing.
```

Whether Veo can perfectly obey exact dialogue should be validated experimentally, but the pipeline must at least preserve the intended speech.

---

# 14. On-screen Thai text strategy

Current system asks Veo to render Thai text.

This is fragile because generated video models often distort text.

## Recommended architecture

Long-term preferred path:

```text
Veo creates clean video without synthetic captions
  ↓
Program overlays text after generation
  ↓
Final merged MP4
```

Benefits:

```text
- correct Thai spelling
- consistent font
- consistent branding
- exact placement
- no garbled characters
- easy A/B test of text without regenerating video
```

## Suggested overlay types

```text
Hook headline
Key benefit text
Price/offer if verified and desired
CTA
Auto-generated subtitles
```

## Short-term compatibility

Until overlay rendering exists:

```text
- keep current short Thai text mechanism
- treat it as best effort
- avoid asking Veo to render long text
- never depend on Veo-rendered text for essential meaning
```

---

# 15. Negative constraints / failure prevention

The final provider prompt should have a shared negative constraint block.

Suggested baseline:

```text
Avoid:
- product changing shape or colour
- generic replacement product
- duplicate product appearing accidentally
- floating objects
- extra fingers or deformed hands
- impossible product interaction
- sudden face change
- sudden clothing change
- sudden location change
- unexplained lighting change
- camera teleportation
- random cuts at clip start
- meaningless product gestures
- fake logos
- made-up product text
- random English captions
- generated gibberish text
- unsupported performance claims shown visually
```

These should be provider-specific if needed.

Do not overload every prompt with hundreds of negatives; maintain a concise baseline and add scene-specific constraints when necessary.

---

# 16. Factuality and affiliate-review rules

Content generation should explicitly prohibit fabricated personal experience.

Required rules:

```text
Do not claim:
- "ใช้มา 7 วัน"
- "ใช้มา 3 เดือน"
- "ซื้อซ้ำแล้ว"
- "ใช้ทุกวัน"
- "เห็นผลใน X วัน"
- "หาย"
- "รักษา"
- "รับประกัน"
- exact performance numbers

unless those facts are supplied and verified in the product data.
```

Prefer language such as:

```text
"จากที่เห็นจุดนี้..."
"จุดเด่นที่น่าสนใจคือ..."
"ถ้าใครกำลังหาแบบที่..."
"ตัวนี้ดูเหมาะกับคนที่..."
"ลองดูจากการใช้งานในคลิปนี้..."
```

The content should still sound persuasive, but not fake a customer history.

---

# 17. Caption generation improvements

TikTok caption should be treated separately from spoken script.

Proposed requirements:

```text
- short natural Thai
- one main benefit or curiosity point
- optional soft CTA
- avoid copying the spoken hook word-for-word
- avoid hashtag spam
- avoid unsupported claims
- allow style-specific voice
```

Potential output schema:

```ts
{
  caption: string,
  hashtags: string[]
}
```

This gives TikTok upload code better control than embedding all hashtags directly into one text blob.

---

# 18. CTA redesign

Generate two separate CTA concepts:

```text
spokenCta
onScreenCta
```

Example:

```json
{
  "spokenCta": "ใครกำลังหาแนวนี้ กดดูรายละเอียดในตะกร้าได้",
  "onScreenCta": "กดดูในตะกร้า"
}
```

This is better than trying to reuse one CTA sentence for both voice and visual text.

---

# 19. Variation engine for repeated generations

Current code already supports a `PlanVariant` concept and tells Veo to make repeated runs different.

This should become a real variation strategy earlier in the pipeline.

Proposed variation dimensions:

```ts
interface CreativeVariant {
  angle: string;
  hookType: string;
  persona: string;
  setting: string;
  openingAction: string;
  cameraProfile: string;
  pacingProfile: string;
}
```

For example, same product could generate:

```text
Variant 1
- UGC
- office worker
- desk setting
- problem hook
- handheld push-in

Variant 2
- Review
- student
- bedroom setting
- curiosity hook
- top-down + close-up

Variant 3
- Demo
- hands-only
- clean table
- immediate demonstration
- macro close-up
```

The final Veo prompt should execute a chosen variant, not invent the entire variation itself.

---

# 20. Character / persona design

For videos containing people, content planning should define a minimal persona.

Proposed optional schema:

```ts
interface CreatorPersona {
  ageRange?: string;
  presentation?: string;
  vibe?: string;
  wardrobe?: string;
  speakingStyle?: string;
}
```

Example:

```json
{
  "ageRange": "24-30",
  "presentation": "Thai woman",
  "vibe": "friendly office worker",
  "wardrobe": "simple black casual shirt",
  "speakingStyle": "casual conversational Thai"
}
```

Do not over-specify physical appearance unless it is important to the creative concept.

The main purpose is consistency between clips.

---

# 21. Camera profiles

Instead of a single default:

```text
handheld smartphone
```

support reusable camera profiles.

Examples:

```text
UGC handheld
- slight natural handheld motion
- eye-level
- occasional push-in
- imperfect but controlled framing

Product demo
- stable tabletop
- overhead / 45-degree view
- macro close-ups
- controlled movement

Review
- medium talking-head shot
- cutaway close-ups of product

Unboxing
- top-down + handheld reaction shot
```

The chosen style can provide the default camera profile.

Scene planner can then request scene-specific motion within the profile.

---

# 22. Lighting profiles

Current default:

```text
natural daylight
```

Keep that as the normal UGC default, but allow style-specific lighting.

Examples:

```text
UGC → natural daylight
Desk demo → soft window light / practical room light
Beauty → soft front daylight
Premium product → controlled soft studio lighting
Unboxing → clean bright room lighting
```

Avoid cinematic lighting unless the style asks for it, because overly cinematic output often stops feeling like TikTok UGC.

---

# 23. Prompt source-of-truth consolidation

There are currently prompt definitions in both extension and server paths.

Target architecture should eventually become:

```text
shared prompt domain
  ├── analysis prompt
  ├── content prompt
  ├── scene prompt
  ├── provider-neutral prompt model
  └── provider adapters
        ├── Veo / Flow
        ├── AI Studio
        ├── future Kling
        ├── future Runway
        └── future Luma
```

Possible folder direction:

```text
src/shared/prompt-engine/
  analysis.ts
  content.ts
  scene.ts
  styles.ts
  duration.ts
  variants.ts
  types.ts
  providers/
    veo.ts
```

The extension build constraints must be considered because it currently uses bare TypeScript without a full bundler for parts of the extension.

Therefore consolidation should not happen by blindly importing server-only dependencies into the extension.

Possible approaches:

```text
A. Pure dependency-free TypeScript shared module copied/built into extension
or
B. Generate extension prompt module from shared source during build
or
C. Keep extension module but make server path import the same pure prompt definitions
```

Choose whichever fits the existing build pipeline with the least complexity.

---

# 24. Prompt versioning

Every generated content/video job should eventually record prompt versions.

Example:

```ts
const PROMPT_VERSIONS = {
  analysis: "analysis-v2",
  content: "content-v3",
  scene: "scene-v3",
  veo: "veo-v4",
};
```

Persist them with generated jobs/content.

Why:

```text
- compare output quality before/after changes
- reproduce old generations
- identify which prompt caused regression
- perform A/B tests
```

A video should eventually be traceable to:

```text
product data
+ analysis result
+ content prompt version
+ generated content
+ scene prompt version
+ generated scenes
+ Veo prompt version
+ exact final prompt
+ provider/model
```

---

# 25. Prompt observability / debug data

For development mode, store the exact prompt at every stage.

Suggested debug object:

```ts
interface PromptTrace {
  analysisSystem?: string;
  analysisUser?: string;
  contentSystem?: string;
  contentUser?: string;
  sceneSystem?: string;
  sceneUser?: string;
  finalVideoPrompts: string[];
}
```

This does not need to be shown to ordinary users.

A developer/debug view can show:

```text
Product input
Analysis output
Content output
Scene output
Clip 1 prompt
Clip 2 prompt
Clip 3 prompt
```

This will make future prompt tuning much faster.

---

# 26. Prompt quality validation before spending video credits

Before sending a prompt to Flow/Veo, run deterministic validation.

Examples:

```text
- target duration is supported
- scenes exist
- total scene duration is reasonable
- each 8-second clip has scene content
- dialogue is not obviously too long
- product identity exists when product image is unavailable
- orientation instruction is valid
- clip 2+ has continuity instruction
- final clip contains CTA or intended ending
- no empty action string
```

Potential validation result:

```ts
interface PromptValidationResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}
```

Hard errors should stop generation before video credits are used.

Warnings can be displayed or logged.

---

# 27. Dialogue duration validation

A rough speaking-time estimator should be added.

It does not need to be linguistically perfect.

Purpose:

```text
catch obviously impossible cases
```

Example:

```text
scene duration = 2 seconds
spoken line = long 25-word Thai sentence
→ warning / regenerate scene plan
```

A practical heuristic can be calibrated using real outputs.

If dialogue is too long:

```text
1. compress the line
2. move part to voiceover in another scene
3. increase scene duration if clip budget allows
```

---

# 28. Continuity redesign

Current continuity logic is already one of the stronger parts of the project.

Improve it by making continuity explicit data rather than only generated prompt prose.

Possible structure:

```ts
interface ContinuityState {
  person?: string;
  wardrobe?: string;
  location?: string;
  lighting?: string;
  productPosition?: string;
  cameraPosition?: string;
  endAction?: string;
}
```

Each clip can expose:

```text
continuityIn
continuityOut
```

Example:

```text
Clip 1 continuityOut:
"woman holds bottle in right hand at chest height while camera continues moving slowly right"

Clip 2 continuityIn:
"start from bottle in right hand at chest height; camera continues same rightward arc"
```

This gives the final provider prompt more precise joining instructions.

---

# 29. Product-image retry behavior

Current Flow logic can fall back by removing the previous clip and eventually the product image when policy errors occur.

This behavior is understandable but risky because removing the product image can reduce product fidelity.

Recommended retry priority:

```text
Attempt 1
- product image attached
- previous clip attached

If rejected:
Attempt 2
- keep product image
- remove previous clip
- strengthen text continuity

If rejected again:
Attempt 3
- consider alternate wording / simplify scene action
- KEEP product image if possible

Only final fallback:
- remove product image
- use strong textual product identity
- mark result as lower-confidence product fidelity
```

The system should prefer rewriting the scene prompt before dropping the strongest product reference.

---

# 30. Scene-level policy fallback

If Flow rejects a prompt, do not immediately retry the exact same semantic concept multiple times.

Add an optional `safeRewriteScenePrompt()` path.

Example transformations:

```text
- simplify physical action
- remove ambiguous body-contact description
- replace risky wording with neutral visual description
- preserve marketing intent
- preserve product identity
```

Do not change the factual product claims during fallback.

---

# 31. UI changes for manual review

The current side panel already displays analysis/content/scenes.

After schema expansion, review UI should show:

```text
Analysis
- target customer
- pain points
- selling points
- angles
- verified facts

Creative
- selected style
- selected angle
- hook type
- hook
- full script
- CTA

Scenes
- duration
- shot
- action
- dialogue/voiceover
- camera motion
```

Optional future controls:

```text
Regenerate hook only
Regenerate script only
Change angle
Change style
Regenerate one scene
Edit dialogue
Edit CTA
```

This is not required for the first prompt-quality phase, but the data model should not block it.

---

# 32. Autopilot changes

Autopilot currently rotates content style.

It should eventually rotate a richer creative configuration.

Instead of only:

```text
styleIndex
```

track something conceptually like:

```text
style
angle
hookType
persona
setting
```

Rules:

```text
- avoid posting multiple nearly identical videos for the same product
- avoid repeating the same hook sentence
- avoid repeating the same opening action
- avoid repeating the same camera profile
```

Autopilot should prioritize creative diversity while keeping claims factual.

---

# 33. Recommended implementation phases

## Phase 0 — Freeze baseline and add tests

Purpose: make current behavior measurable before prompt changes.

Work:

```text
- capture representative prompt outputs
- add tests around current prompt builders
- add duration/orientation tests
- create sample product fixtures
- define evaluation products across multiple categories
```

Recommended sample categories:

```text
fashion/accessory
household tool
beauty/personal care
small electronics/accessory
food container/kitchen item
organization/storage product
```

Deliverable:

```text
baseline prompt snapshots + test fixtures
```

---

## Phase 1 — P0 correctness fixes

Implement only the high-impact structural fixes:

```text
- targetDuration into content generation
- analysis.angles used by content generation
- scene count scales with duration
- fix 16:9/9:16 wording
- dialogue/voiceover added to scene schema
- actual speech included in final video prompt
```

Do not add all advanced features yet.

Goal:

```text
make the existing pipeline preserve script intent correctly
```

---

## Phase 2 — Structured creative generation

Implement:

```text
- style playbooks
- hookType
- script beats
- spokenCta vs onScreenCta
- selected creative angle
- better content diversity
```

Goal:

```text
make UGC/Review/Demo/etc. genuinely different
```

---

## Phase 3 — Product fidelity

Implement:

```text
- verifiedFacts
- inferredBenefits
- prohibitedClaims
- visualIdentity
- textual product lock in every final video prompt
- safer product-image fallback
```

Goal:

```text
reduce hallucinated product design and unsupported claims
```

---

## Phase 4 — Clip-aware storyboard planning

Implement:

```text
- plan around 8-second blocks
- continuityIn / continuityOut
- clip-level scene groups
- dialogue timing validation
```

Goal:

```text
improve 16/24/32-second video continuity
```

---

## Phase 5 — Final provider prompt redesign

Replace the mostly flat prompt with structured sections:

```text
[GOAL]
[FORMAT]
[PRODUCT]
[CHARACTER]
[STORY CONTEXT]
[TIMELINE]
[DIALOGUE]
[CAMERA]
[AUDIO]
[CONTINUITY]
[AVOID]
```

Goal:

```text
make provider instructions explicit and debuggable
```

---

## Phase 6 — Post-render text overlay

Implement external rendering of:

```text
headline
CTA
subtitles
optional key benefit text
```

Possible implementation path:

```text
merged video
  ↓
FFmpeg or existing media pipeline
  ↓
overlay text/subtitles
  ↓
final MP4
```

Goal:

```text
stop relying on video AI for correct Thai text
```

---

## Phase 7 — Prompt versioning and evaluation

Implement:

```text
prompt version IDs
prompt traces
quality metrics
A/B prompt experiments
```

Goal:

```text
turn prompt tuning into a measurable engineering process
```

---

# 34. Exact file-level change map

## `extension/src/lib/analysis-prompts.ts`

Planned changes:

```text
- expand PRODUCT_ANALYSIS_SCHEMA
- expand CONTENT_GENERATION_SCHEMA
- expand SCENE_PLAN_SCHEMA
- add duration input to buildContentPrompt
- add angle into buildContentPrompt
- add style playbook text
- add claim/factuality rules
- add script beat requirements
- add dialogue/voiceover instructions to buildScenePrompt
- scale requested scene count by duration
- add clip-boundary awareness to buildScenePrompt
```

Potential helper functions:

```ts
contentStyleInstructions(style)
durationInstructions(targetDuration)
sceneCountForDuration(targetDuration)
claimSafetyInstructions()
```

---

## `extension/src/lib/store.ts`

Planned changes:

```text
- expand ProductAnalysis
- expand Scene
- expand Content
- preserve backwards compatibility for older stored objects
```

Potential additions:

```ts
ProductVisualIdentity
ScriptBeat
CreatorPersona
CreativeVariant
```

Fields should generally be optional during migration so existing chrome.storage content does not break.

---

## `extension/src/background.ts`

Planned changes:

```text
- pass targetDuration into buildContentPrompt
- choose/pass creative angle
- save new content fields
- save richer scenes
- ensure final createJob path receives new scene data
```

Important function:

```ts
generateContentScenes()
```

This is where the chain between content generation and scene generation should be kept intact.

---

## `extension/src/lib/prompt-engine.ts`

This is the most important provider-neutral rendering area.

Planned changes:

```text
- extend ScenePromptInput
- preserve dialogue/voiceover
- possibly represent clip groups explicitly
- fix orientation wording through helper
- add structured final prompt sections
- add product visual identity input
- add continuity in/out input
- add negative constraints
- improve variant handling
```

Potential new helpers:

```ts
formatAspectRatioInstruction()
formatDialogueBlock()
formatProductIdentityBlock()
formatContinuityBlock()
formatAvoidBlock()
buildVeoClipPrompt()
```

Avoid letting one giant function become difficult to test.

---

## `extension/src/flow-automation.ts`

Planned changes:

```text
- remove hardcoded "vertical" wording for every aspect ratio
- keep Flow settings and prompt wording consistent
- improve retry ordering
- prefer prompt rewrite before dropping product image
- keep exact final prompt available for logging/debugging
```

Important area:

```ts
flowSubmitAndWaitOnce()
```

The Flow automation layer should be responsible for transport/provider interaction, not for inventing missing creative information.

Creative content should already be complete before reaching this file.

---

## `extension/src/sidepanel.ts`

Planned changes later:

```text
- show selected angle
- show dialogue/voiceover per scene
- show richer analysis
- optionally show final generated prompt in debug mode
```

Not required for the first P0 backend prompt improvement.

---

## `extension/src/lib/autopilot.ts`

Planned changes later:

```text
- rotate angle/hook type in addition to style
- track creative combinations used for each product
- reduce duplicate outputs
```

---

## `src/services/analysis.service.ts`

Planned changes:

```text
- align prompt/schema with extension version
- remove old schema drift
- add verified facts / visual identity if server flow remains active
```

---

## `src/services/content.service.ts`

Planned changes:

```text
- receive duration
- use angle
- use style playbooks
- produce richer content schema
- align factuality rules
```

---

## `src/services/scene.service.ts`

Planned changes:

```text
- align scene schema with extension
- include cameraMotion
- include dialogue/voiceover
- duration-aware scene count
- clip-aware planning
```

---

## `src/lib/prompt-engine/prompt-builder.ts`

Planned changes:

```text
- align with extension prompt engine
- support dialogue and structured blocks
```

---

## `src/lib/prompt-engine/clip-planner.ts`

Planned changes:

```text
- reduce heuristic scene splitting
- eventually consume clip-aware plans directly
- preserve backward compatibility with old flat scene arrays
```

---

## `src/lib/prompt-engine/types.ts`

Planned changes:

```text
- add new shared types
- add camera/audio/continuity fields
```

---

# 35. Backward compatibility strategy

Existing users may already have content stored in Chrome storage without new fields.

Therefore new properties should initially be optional.

Example:

```ts
interface Scene {
  duration: number;
  description: string;
  cameraMotion?: string;
  dialogue?: string;
  voiceover?: string;
  ...
}
```

When old scenes are loaded:

```text
- missing dialogue → visual-only scene
- missing cameraMotion → use current default camera motion
- missing visualIdentity → rely on product image/name
- missing angle → generate/select default angle
```

No migration should delete old generated content.

---

# 36. Testing strategy

## Unit tests — prompt helpers

Test:

```text
- 9:16 produces portrait wording
- 16:9 produces landscape wording
- no "16:9 vertical" output
- dialogue appears in final prompt
- voiceover appears in final prompt
- product identity appears when available
- variant instructions appear when repeated generation is used
- continuity blocks only appear where appropriate
```

---

## Unit tests — duration behavior

Test each target:

```text
8
16
24
32 seconds
```

Verify:

```text
- correct clip count
- sensible requested scene count
- no empty clip
- dialogue fits expected block
```

---

## Unit tests — style playbooks

For each:

```text
UGC
Review
Problem Solution
Storytelling
Before After
Unboxing
Demo
```

Verify generated prompt instructions contain the correct structure and do not accidentally reuse a different style's requirements.

---

## Integration test — full prompt chain

Given one fixture product:

```text
Product
→ analysis
→ content
→ scenes
→ planClips
→ final Flow prompt
```

Validate that information survives the chain.

Example assertions:

```text
- chosen angle appears in content instructions
- hook becomes a script beat
- script beat becomes scene dialogue
- scene dialogue appears in clip prompt
- product identity appears in clip prompt
```

---

## Manual visual QA

For each test product, generate at least:

```text
1 x 8s
1 x 16s
1 x 24s
```

Evaluate:

```text
Product fidelity
Character consistency
Scene progression
Dialogue usefulness
Lip-sync quality
Camera continuity
Claim accuracy
Thai naturalness
TikTok/UGC feel
Repeated-generation diversity
```

---

# 37. Suggested quality scorecard

Use a 1–5 score per video.

```text
Product fidelity           1–5
Story coherence            1–5
Hook strength              1–5
Natural Thai dialogue      1–5
Visual variety             1–5
Continuity                 1–5
Product interaction        1–5
CTA clarity                1–5
TikTok authenticity        1–5
Claim/factual accuracy     1–5
```

Track average score by prompt version.

This gives a meaningful way to decide whether `veo-v4` is actually better than `veo-v3`.

---

# 38. Regression cases to explicitly test

The following should become permanent regression cases:

```text
1. 16:9 must never say vertical.
2. 32s must not be generated from only 3 repetitive scenes.
3. Spoken script must not disappear before the video prompt.
4. Different styles must not generate near-identical structures.
5. Same-product repeated runs must not have the same opening every time.
6. Product must not be replaced with a generic lookalike when image reference is present.
7. Removing previous clip during retry must not remove all continuity instructions.
8. Removing product image as final fallback must still leave textual product identity.
9. No fake "used for X days" claims without source data.
10. Thai on-screen text must not be critical to understanding the ad until post-render overlay exists.
```

---

# 39. Data migration considerations

No destructive migration is necessary for extension storage if fields are additive and optional.

If server/database schemas eventually persist the richer fields, use additive migrations first.

Examples:

```text
Content
- hookType
- angle
- scriptBeats JSON
- spokenCta

ProductAnalysis
- verifiedFacts JSON
- inferredBenefits JSON
- prohibitedClaims JSON
- visualIdentity JSON

Scene
- shotType
- subjectAction
- productAction
- dialogue
- voiceover
- soundCue
- transition
- continuityNotes
- beatType
```

Do not make all fields required immediately.

---

# 40. Rollout strategy

Prompt improvements should be released gradually.

Recommended order:

```text
1. Structural correctness
2. Dialogue preservation
3. Duration-aware planning
4. Style playbooks
5. Product fidelity
6. Clip-aware continuity
7. Provider prompt redesign
8. Overlay rendering
9. Advanced variation engine
```

Each phase should compare output against baseline before moving on.

---

# 41. What should NOT be done

Avoid these shortcuts:

```text
- Do not simply make the final prompt much longer without structuring it.
- Do not ask Veo to invent missing script content.
- Do not rely on "make it different" as the entire variation strategy.
- Do not increase scene count without respecting 8-second clip boundaries.
- Do not trust product name alone to preserve product appearance.
- Do not let retries silently degrade product fidelity without tracking it.
- Do not duplicate prompt changes separately in extension and server forever.
- Do not use generated Thai text as the only way to communicate the CTA.
- Do not fabricate review experience to make content sound convincing.
```

---

# 42. Definition of Done — P0

P0 is considered complete when all of the following are true:

```text
[ ] buildContentPrompt receives targetDuration
[ ] content generation uses analysis angles
[ ] scene count changes appropriately by target duration
[ ] scene schema supports dialogue and/or voiceover
[ ] actual Thai dialogue reaches final Flow/Veo prompt
[ ] 9:16 and 16:9 wording is correct
[ ] existing old stored scenes still load
[ ] tests cover all target durations
[ ] tests cover both aspect ratios
[ ] full prompt chain test confirms no dialogue loss
```

---

# 43. Definition of Done — Full Prompt Pipeline V2

The full redesign is considered complete when:

```text
[ ] Product analysis separates verified facts and inferred benefits
[ ] Product visual identity exists as textual fallback
[ ] Content style uses explicit playbooks
[ ] Creative angle is selected and persisted
[ ] Hook type is generated/persisted
[ ] Script is structured into timed beats
[ ] Scene plan maps beats to visual actions
[ ] Scenes include dialogue/voiceover
[ ] Storyboards are aware of 8-second clip boundaries
[ ] Final Veo prompts use structured sections
[ ] Continuity has explicit in/out state
[ ] Product reference survives retry strategy as long as possible
[ ] Repeated generations use planned creative variants
[ ] Prompt versions are stored
[ ] Exact final prompts can be inspected in debug mode
[ ] Prompt validation runs before video-credit usage
[ ] Thai overlays/subtitles no longer depend primarily on Veo rendering text
[ ] Manual QA score improves versus baseline
```

---

# 44. Suggested first implementation batch when work begins

When implementation is eventually approved, the first coding batch should be intentionally small and high impact.

Recommended first batch:

```text
1. Extend Scene with dialogue/voiceover.
2. Pass targetDuration into content generation.
3. Pass analysis.angles into content generation.
4. Make requested scene count duration-aware.
5. Preserve dialogue from script → scenes → clip prompt.
6. Fix aspect-ratio wording.
7. Add tests for those changes.
```

Do **not** combine text overlay, DB redesign, advanced personas and full prompt versioning into the same first patch.

The first patch should prove that the most important missing information — spoken intent — survives the entire pipeline.

---

# 45. Example end-to-end target

## Input

```text
Product:
Compact black stainless-steel bottle with carry handle.

Target:
Office workers who want something easy to carry.

Duration:
16 seconds

Style:
UGC

Angle:
Large bottles take too much bag space → this compact option is easier to carry.
```

## Content output

```json
{
  "hookType": "problem",
  "hook": "ใครพกขวดใหญ่แล้วกระเป๋าแน่นตลอด ดูอันนี้",
  "angle": "ขวดใหญ่กินพื้นที่ → ตัวนี้พกง่ายกว่า",
  "beats": [
    {
      "type": "hook",
      "text": "ใครพกขวดใหญ่แล้วกระเป๋าแน่นตลอด ดูอันนี้",
      "estimatedSeconds": 3
    },
    {
      "type": "demo",
      "text": "ตัวนี้ทรงกระชับ แล้วมีหูจับตรงฝาด้วย",
      "estimatedSeconds": 4
    },
    {
      "type": "benefit",
      "text": "หยิบจากกระเป๋าหรือถือเดินสะดวกขึ้น",
      "estimatedSeconds": 4
    },
    {
      "type": "cta",
      "text": "ใครชอบแบบพกง่าย กดดูในตะกร้าได้",
      "estimatedSeconds": 3
    }
  ],
  "caption": "สายพกของไปทำงานน่าจะชอบทรงนี้ 👀",
  "spokenCta": "ใครชอบแบบพกง่าย กดดูในตะกร้าได้",
  "onScreenText": "พกง่ายกว่าเดิม",
  "onScreenCta": "กดดูในตะกร้า"
}
```

## Scene plan

```json
{
  "clips": [
    {
      "clipIndex": 0,
      "scenes": [
        {
          "duration": 3,
          "shotType": "medium shot",
          "description": "หญิงวัยทำงานพยายามใส่ขวดใบใหญ่ลงกระเป๋าทำงานแล้วพื้นที่แน่น",
          "cameraMotion": "slight handheld push-in",
          "dialogue": "ใครพกขวดใหญ่แล้วกระเป๋าแน่นตลอด ดูอันนี้",
          "beatType": "hook"
        },
        {
          "duration": 5,
          "shotType": "medium close-up to product close-up",
          "description": "เธอหยิบขวดสีดำขนาดกระชับขึ้นมา หมุนให้เห็นฝาและหูจับ",
          "cameraMotion": "continue push-in then tilt down to the product",
          "dialogue": "ตัวนี้ทรงกระชับ แล้วมีหูจับตรงฝาด้วย",
          "beatType": "demo"
        }
      ],
      "continuityOut": "woman holds the bottle by the top handle near chest height while camera finishes a slight tilt down"
    },
    {
      "clipIndex": 1,
      "scenes": [
        {
          "duration": 4,
          "shotType": "close-up moving to medium shot",
          "description": "เริ่มจากตำแหน่งเดิม เธอจับหูขวดแล้วใส่ลงกระเป๋าอย่างง่าย",
          "cameraMotion": "continue from previous tilt, then gently pull back",
          "dialogue": "หยิบจากกระเป๋าหรือถือเดินสะดวกขึ้น",
          "beatType": "benefit"
        },
        {
          "duration": 4,
          "shotType": "medium hero shot",
          "description": "เธอถือกระเป๋าและขวด ยิ้มให้กล้องก่อนวางขวดด้านหน้าเฟรม",
          "cameraMotion": "steady handheld settle on the product",
          "dialogue": "ใครชอบแบบพกง่าย กดดูในตะกร้าได้",
          "beatType": "cta"
        }
      ]
    }
  ]
}
```

## Final clip prompt example

```text
[GOAL]
Generate exactly one 8-second TikTok UGC video segment.
This is part 2 of 2 of one continuous 16-second advert.

[FORMAT]
9:16 portrait vertical video.
Realistic handheld smartphone UGC footage.

[PRODUCT REFERENCE]
Use the attached product photo as the exact product identity.
Preserve the matte black cylindrical body, black screw lid and top carry handle.
Do not replace it with another bottle.

[CONTINUITY IN]
Continue directly from the previous clip's last frame.
Same Thai woman, same black shirt, same office desk, same daylight.
She starts holding the bottle by the top handle near chest height.
Camera continues from the previous slight downward tilt.

[TIMELINE]
0–4s: She smoothly puts the compact bottle into the work bag and demonstrates how easily it fits.
4–8s: She takes one step back, smiles naturally, then places the bottle prominently near the front of the frame.

[DIALOGUE]
0–4s: "หยิบจากกระเป๋าหรือถือเดินสะดวกขึ้น"
4–8s: "ใครชอบแบบพกง่าย กดดูในตะกร้าได้"
Speak exactly in natural Thai. Do not translate or add extra dialogue.

[CAMERA]
Continue the existing handheld movement, then gently pull back and settle on the product.

[AUDIO]
Natural Thai speech with clear dialogue and subtle room ambience.

[AVOID]
No jump cut at the beginning.
No face change.
No outfit change.
No product morphing.
No duplicate bottle.
No random English text.
No additional spoken lines.
```

This example represents the intended end-state: strategy, script, visual action, speech and continuity all survive into the actual video-generation prompt.

---

# 46. Final priority summary

If only a few changes can be made, the priority order should be:

```text
1. Preserve actual dialogue into Veo/Flow prompts.
2. Make script length aware of target duration.
3. Make scene planning aware of duration and 8-second clip boundaries.
4. Actually use creative angles from analysis.
5. Give every content style an explicit playbook.
6. Add product textual visual identity as fallback.
7. Separate verified facts from inferred benefits.
8. Structure final Veo prompt into explicit sections.
9. Improve planned variation for repeated generations.
10. Move Thai overlays/subtitles out of Veo and into post-processing.
```

The existing project does not need a complete rewrite. The highest-value improvement is to stop losing creative information between pipeline stages and make the final provider prompt a faithful execution of the content strategy generated earlier.
