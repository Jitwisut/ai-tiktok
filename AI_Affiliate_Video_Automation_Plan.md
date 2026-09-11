# AI Affiliate Video Automation — Project Plan

## 1. เป้าหมายโปรเจกต์

สร้าง Web App สำหรับช่วยทำคอนเทนต์ Affiliate แบบอัตโนมัติ โดยผู้ใช้สามารถนำ URL สินค้าเข้ามาในระบบ แล้วให้ AI ช่วย:

1. อ่านและจัดเก็บข้อมูลสินค้า
2. วิเคราะห์สินค้าและกลุ่มลูกค้า
3. สร้าง Hook / Script / Caption
4. สร้าง Prompt สำหรับ AI Video
5. ส่ง Prompt ไปสร้างวิดีโอ
6. เก็บไฟล์วิดีโอและสถานะงาน
7. ให้ผู้ใช้ Preview / Approve / Download
8. ในเวอร์ชันถัดไปสามารถตั้งเวลาโพสต์ไปยังแพลตฟอร์มต่าง ๆ ได้

---

# 2. Scope ของ MVP

MVP แรกยังไม่ต้องทำทุกอย่างเหมือนระบบเต็มรูปแบบ

ให้เน้น Flow นี้ก่อน:

```text
Login
  ↓
Add Product
  ↓
Analyze Product
  ↓
Generate Script
  ↓
Generate Video Prompt
  ↓
Generate Video
  ↓
Preview
  ↓
Download
```

## ฟีเจอร์ MVP

- Authentication
- Dashboard
- Add Product
- Product Library
- AI Product Analysis
- AI Hook Generator
- AI Script Generator
- AI Caption Generator
- AI Video Prompt Generator
- Video Generation
- Video Job Queue
- Video Library
- Preview Video
- Download Video
- Error Handling
- Usage / Credit Tracking แบบพื้นฐาน

---

# 3. ฟีเจอร์ที่ยังไม่ต้องทำใน MVP

เก็บไว้ Phase ถัดไป:

- TikTok Auto Post
- Instagram Reels Auto Post
- YouTube Shorts Auto Post
- Affiliate Revenue Tracking
- Shopee Affiliate API
- TikTok Shop Affiliate API
- Team Workspace
- Subscription Billing
- Advanced Analytics
- A/B Testing
- Bulk Generation 100+ videos
- AI Avatar
- Voice Cloning
- Auto Comment / Auto Reply

---

# 4. Tech Stack

## Frontend

```text
Next.js
TypeScript
Tailwind CSS
shadcn/ui
React Query / TanStack Query
```

## Backend

เริ่มจาก Next.js API Route ได้

```text
Next.js
TypeScript
REST API
```

ถ้าระบบโตขึ้นค่อยแยก Backend เป็น:

```text
NestJS
```

## Database

```text
PostgreSQL
Prisma ORM
```

Provider แนะนำ:

- Supabase
- Neon
- Railway PostgreSQL

## Queue

```text
Redis
BullMQ
```

ใช้จัดการ:

- AI Generation
- Video Generation
- Retry
- Background Job
- Scheduled Job

## AI

LLM:

```text
OpenAI API
หรือ
Gemini API
```

Video:

```text
Google Veo
```

สามารถออกแบบ Adapter ไว้รองรับ:

```text
Veo
Kling
Runway
Luma
อื่น ๆ
```

## Storage

```text
Cloudflare R2
หรือ
AWS S3
```

เก็บ:

- Product Images
- Generated Images
- Generated Videos
- Thumbnails

## Authentication

เลือกหนึ่งตัว:

```text
Better Auth
Clerk
Supabase Auth
```

## Deployment

Frontend:

```text
Vercel
```

Worker / Redis / Backend:

```text
Railway
Render
Google Cloud Run
```

---

# 5. High-Level Architecture

```text
                          ┌───────────────────┐
                          │       User        │
                          └─────────┬─────────┘
                                    │
                                    ▼
                          ┌───────────────────┐
                          │     Next.js       │
                          │     Frontend      │
                          └─────────┬─────────┘
                                    │
                                    ▼
                          ┌───────────────────┐
                          │     API Layer     │
                          └─────┬───────┬─────┘
                                │       │
                  ┌─────────────┘       └─────────────┐
                  ▼                                   ▼
        ┌───────────────────┐               ┌───────────────────┐
        │    PostgreSQL     │               │       Redis       │
        │     Database      │               │      BullMQ       │
        └───────────────────┘               └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │      Worker       │
                                           └─────┬───────┬─────┘
                                                 │       │
                                      ┌──────────┘       └──────────┐
                                      ▼                             ▼
                              ┌──────────────┐              ┌──────────────┐
                              │     LLM      │              │  Video Model │
                              │ GPT/Gemini   │              │     Veo      │
                              └──────────────┘              └───────┬──────┘
                                                                    │
                                                                    ▼
                                                           ┌──────────────┐
                                                           │   R2 / S3    │
                                                           └──────────────┘
```

---

# 6. User Flow

## Step 1 — Login

User Login เข้าระบบ

```text
/login
```

หลังจาก Login:

```text
/dashboard
```

---

## Step 2 — Add Product

ผู้ใช้ใส่ URL สินค้า

```text
/products/new
```

ตัวอย่าง:

```text
https://example.com/product/123
```

ระบบสร้าง Product Record

```text
status = pending
```

จากนั้นระบบพยายามดึง:

- Product Name
- Description
- Price
- Images
- Product URL
- Seller
- Category

---

# 7. Product Import Strategy

ไม่ควรผูกระบบกับ Web Scraping เพียงอย่างเดียว

ออกแบบให้รองรับหลายวิธี:

```text
Product Importer Interface
        │
        ├── Manual Input
        ├── URL Parser
        ├── Chrome Extension
        ├── Official API
        └── CSV Import
```

ตัวอย่าง Interface:

```ts
interface ProductImporter {
  import(url: string): Promise<ProductData>
}
```

---

# 8. Chrome Extension

Phase หลัง MVP สามารถทำ Chrome Extension

เมื่อผู้ใช้อยู่บนหน้าสินค้า:

```text
┌──────────────────────────┐
│ + Add to AI Studio       │
└──────────────────────────┘
```

Extension ส่งข้อมูล:

```json
{
  "url": "...",
  "title": "...",
  "price": 399,
  "description": "...",
  "images": []
}
```

ไปยัง Backend

```text
POST /api/products/import
```

---

# 9. AI Content Pipeline

Flow หลัก:

```text
Product
   ↓
Product Analysis
   ↓
Marketing Angle
   ↓
Hook
   ↓
Script
   ↓
Scenes
   ↓
Video Prompt
   ↓
Video Generation
```

---

# 10. Product Analysis

ให้ AI วิเคราะห์ข้อมูลก่อนสร้าง Script

Input:

```json
{
  "name": "Example Product",
  "description": "...",
  "price": 399
}
```

Output:

```json
{
  "target_customer": "ผู้หญิงอายุ 20-35 ปี",
  "pain_points": [
    "ปัญหาที่ 1",
    "ปัญหาที่ 2"
  ],
  "selling_points": [
    "จุดขายที่ 1",
    "จุดขายที่ 2"
  ],
  "recommended_angles": [
    "Problem Solution",
    "Before After",
    "Review"
  ]
}
```

---

# 11. Content Generation

AI สร้าง Content Package

```json
{
  "hook": "...",
  "script": "...",
  "caption": "...",
  "cta": "...",
  "scenes": []
}
```

ตัวอย่าง:

```json
{
  "hook": "ใครแต่งหน้าแล้วรองพื้นตกร่องต้องดู",
  "script": "วันนี้ลองตัวนี้...",
  "caption": "ลองแล้วชอบกว่าที่คิด",
  "cta": "กดดูสินค้าได้ที่ตะกร้า",
  "scenes": [
    {
      "duration": 2,
      "description": "หญิงสาวส่องกระจก"
    },
    {
      "duration": 3,
      "description": "ทดลองใช้ผลิตภัณฑ์"
    },
    {
      "duration": 3,
      "description": "Close-up ผลลัพธ์"
    }
  ]
}
```

---

# 12. Prompt Engine

ไม่ควรส่ง Product Description ตรงไปที่ Veo

สร้าง Prompt Engine ตรงกลาง

```text
Product Data
     ↓
Content Strategy
     ↓
Scene JSON
     ↓
Prompt Builder
     ↓
Veo Prompt
```

ข้อดี:

- เปลี่ยน Video Provider ได้ง่าย
- Debug ง่าย
- ควบคุมคุณภาพได้
- A/B Test Prompt ได้
- Version Prompt ได้

---

# 13. Video Prompt Structure

ตัวอย่างโครงสร้าง:

```json
{
  "style": "UGC",
  "aspect_ratio": "9:16",
  "duration": 8,
  "camera": "handheld smartphone",
  "lighting": "natural daylight",
  "character": "...",
  "product": "...",
  "scenes": [
    {
      "start": 0,
      "end": 2,
      "action": "..."
    }
  ]
}
```

จากนั้น Prompt Builder ค่อยแปลงเป็น Text Prompt

---

# 14. Video Job System

การ Generate Video ต้องเป็น Async Job

ไม่ควรทำ:

```text
Browser
   ↓
Request
   ↓
รอ Veo 1-5 นาที
```

ควรเป็น:

```text
Browser
   ↓
POST /videos
   ↓
Create Job
   ↓
Return Job ID
   ↓
Queue
   ↓
Worker
   ↓
Generate Video
   ↓
Update Database
```

---

# 15. Job Status

ใช้ Status:

```text
queued
processing
completed
failed
cancelled
```

Frontend Poll:

```text
GET /api/video-jobs/:id
```

หรือใช้:

```text
WebSocket
Server Sent Events
```

ภายหลัง

---

# 16. Retry Strategy

Video API อาจ Error

ใช้ BullMQ Retry:

```text
attempts: 3
```

Backoff:

```text
1 นาที
3 นาที
10 นาที
```

---

# 17. Database Schema

## User

```text
users
```

Fields:

```text
id
email
name
image
credits
created_at
updated_at
```

---

## Product

```text
products
```

Fields:

```text
id
user_id
source
source_url
name
description
price
currency
category
seller_name
status
created_at
updated_at
```

---

## Product Images

```text
product_images
```

Fields:

```text
id
product_id
url
position
created_at
```

---

## Product Analysis

```text
product_analyses
```

Fields:

```text
id
product_id
target_customer
pain_points
selling_points
angles
raw_json
model
created_at
```

---

## Content

```text
contents
```

Fields:

```text
id
user_id
product_id
hook
script
caption
cta
style
status
created_at
updated_at
```

---

## Scene

```text
scenes
```

Fields:

```text
id
content_id
position
duration
description
video_prompt
created_at
```

---

## Video

```text
videos
```

Fields:

```text
id
user_id
content_id
provider
provider_job_id
status
video_url
thumbnail_url
duration
aspect_ratio
error_message
created_at
updated_at
```

---

## Job

```text
jobs
```

Fields:

```text
id
user_id
type
status
payload
result
error
attempts
created_at
updated_at
```

---

## Credit Transaction

```text
credit_transactions
```

Fields:

```text
id
user_id
type
amount
reference_id
description
created_at
```

---

# 18. API Design

## Auth

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

---

## Products

```text
POST   /api/products
GET    /api/products
GET    /api/products/:id
PATCH  /api/products/:id
DELETE /api/products/:id
```

Import:

```text
POST /api/products/import
```

---

## Analysis

```text
POST /api/products/:id/analyze
GET  /api/products/:id/analysis
```

---

## Content

```text
POST   /api/contents
GET    /api/contents
GET    /api/contents/:id
PATCH  /api/contents/:id
DELETE /api/contents/:id
```

Generate:

```text
POST /api/contents/generate
```

---

## Videos

```text
POST /api/videos
GET  /api/videos
GET  /api/videos/:id
```

Regenerate:

```text
POST /api/videos/:id/regenerate
```

---

## Jobs

```text
GET /api/jobs/:id
```

---

# 19. Dashboard Pages

```text
/dashboard
/products
/products/new
/products/[id]

/contents
/contents/[id]

/videos
/videos/[id]

/settings
```

---

# 20. Dashboard UI

Sidebar:

```text
Dashboard
Products
Content
Videos
Schedule
Analytics
Settings
```

MVP ใช้ก่อน:

```text
Dashboard
Products
Content
Videos
Settings
```

---

# 21. Create Video UI

ตัวอย่าง:

```text
┌───────────────────────────────────────┐
│ Create AI Video                       │
├───────────────────────────────────────┤
│ Product                               │
│ [ Select Product ▼ ]                  │
│                                       │
│ Content Style                         │
│ ○ UGC                                 │
│ ○ Product Review                      │
│ ○ Problem / Solution                  │
│ ○ Storytelling                        │
│                                       │
│ Duration                              │
│ [ 8 Seconds ▼ ]                       │
│                                       │
│ Aspect Ratio                          │
│ [ 9:16 ▼ ]                            │
│                                       │
│ Language                              │
│ [ Thai ▼ ]                            │
│                                       │
│          [ Generate ]                 │
└───────────────────────────────────────┘
```

---

# 22. Video Library

Grid:

```text
┌──────────┐ ┌──────────┐ ┌──────────┐
│          │ │          │ │          │
│  Video   │ │  Video   │ │  Video   │
│          │ │          │ │          │
└──────────┘ └──────────┘ └──────────┘

Completed     Processing     Failed
```

Action:

```text
Preview
Download
Regenerate
Delete
```

---

# 23. Credit System

Video Generation มีค่าใช้จ่าย

ควรมี Credit Layer ตั้งแต่ต้น

ตัวอย่าง:

```text
1 Script = 1 Credit
1 Image = 3 Credits
1 Video = 20 Credits
```

แต่ MVP ยังไม่ต้องขาย Credit

สามารถแจก:

```text
100 Free Credits
```

ไว้ทดสอบก่อน

---

# 24. Security

ต้องมี:

- Auth Middleware
- Rate Limiting
- API Key Encryption
- Input Validation
- URL Validation
- File Type Validation
- User Ownership Check
- Credit Validation

ตัวอย่าง:

```text
user A
```

ห้ามเข้าถึง:

```text
/video ของ user B
```

---

# 25. Environment Variables

ตัวอย่าง `.env`:

```env
DATABASE_URL=

REDIS_URL=

OPENAI_API_KEY=
GEMINI_API_KEY=

VIDEO_API_KEY=

R2_ACCOUNT_ID=
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_BUCKET=

NEXTAUTH_SECRET=
```

ห้ามส่ง Secret ไป Frontend

---

# 26. Folder Structure

```text
src/
│
├── app/
│   ├── dashboard/
│   ├── products/
│   ├── contents/
│   ├── videos/
│   └── api/
│
├── components/
│
├── lib/
│   ├── db/
│   ├── ai/
│   ├── video/
│   ├── queue/
│   ├── storage/
│   └── auth/
│
├── services/
│   ├── product.service.ts
│   ├── analysis.service.ts
│   ├── content.service.ts
│   └── video.service.ts
│
├── workers/
│   ├── content.worker.ts
│   └── video.worker.ts
│
└── types/
```

---

# 27. AI Adapter

อย่าผูก Business Logic กับ OpenAI โดยตรง

สร้าง Interface:

```ts
interface LLMProvider {
  generate<T>(prompt: string): Promise<T>
}
```

Implement:

```text
OpenAIProvider
GeminiProvider
```

---

# 28. Video Provider Adapter

```ts
interface VideoProvider {
  generate(input: VideoInput): Promise<VideoJob>
  getStatus(jobId: string): Promise<VideoStatus>
}
```

Implement:

```text
VeoProvider
KlingProvider
RunwayProvider
```

ทำให้เปลี่ยน Provider ภายหลังง่าย

---

# 29. Phase 1 — Project Foundation

เป้าหมาย:

สร้าง Skeleton ของระบบ

Tasks:

- Create Next.js Project
- Setup TypeScript
- Setup Tailwind
- Setup shadcn/ui
- Setup PostgreSQL
- Setup Prisma
- Setup Auth
- Create Dashboard Layout
- Create Sidebar
- Create User Model
- Create Product Model

Definition of Done:

```text
User สามารถ Login และเข้าหน้า Dashboard ได้
```

---

# 30. Phase 2 — Product System

Tasks:

- Product CRUD
- Add Product Form
- Product Detail
- Upload Product Images
- Product Library
- URL Import Interface

Definition of Done:

```text
User สามารถเพิ่มสินค้าและดู Product Library ได้
```

---

# 31. Phase 3 — AI Analysis

Tasks:

- LLM Provider
- Product Analyzer
- Structured JSON Output
- Save Analysis
- Analysis UI
- Regenerate Analysis

Definition of Done:

```text
กด Analyze แล้วได้ Target Customer / Pain Points / Selling Points
```

---

# 32. Phase 4 — AI Content

Tasks:

- Hook Generator
- Script Generator
- Caption Generator
- CTA Generator
- Content Style
- Save Content
- Edit Content

Style Presets:

```text
UGC
Review
Problem Solution
Storytelling
Before After
Unboxing
Demo
```

Definition of Done:

```text
จาก Product สามารถสร้าง Script พร้อมใช้ได้
```

---

# 33. Phase 5 — Prompt Engine

Tasks:

- Scene Planner
- Prompt Builder
- Prompt Templates
- Prompt Version
- Video Settings

Parameters:

```text
Duration
Aspect Ratio
Style
Camera
Lighting
Language
```

Definition of Done:

```text
Script สามารถแปลงเป็น Video Prompt ได้
```

---

# 34. Phase 6 — Video Generation

Tasks:

- Video Provider Adapter
- Veo Integration
- Redis
- BullMQ
- Video Worker
- Job Status
- Retry Logic
- Save Video
- Upload R2/S3
- Video Preview

Definition of Done:

```text
กด Generate แล้วสุดท้ายได้ Video ใน Video Library
```

---

# 35. Phase 7 — Improve UX

เพิ่ม:

- Loading State
- Job Progress
- Toast Notification
- Error Message
- Retry Button
- Skeleton UI
- Empty State

---

# 36. Phase 8 — Chrome Extension

Chrome Extension:

```text
Manifest V3
TypeScript
React
```

Features:

```text
Detect Product
Add Product
Send to Dashboard
Open Dashboard
```

Flow:

```text
Marketplace
     ↓
Chrome Extension
     ↓
POST /api/products/import
     ↓
Product Library
```

---

# 37. Phase 9 — Scheduler

เพิ่มภายหลัง:

```text
scheduled_posts
```

Fields:

```text
id
user_id
video_id
platform
scheduled_at
status
platform_post_id
error
```

Flow:

```text
Video
  ↓
Schedule
  ↓
Queue
  ↓
Platform API
```

---

# 38. Phase 10 — Auto Posting

ต้องตรวจ API และ Policy ของแต่ละ Platform ก่อน Implement

รองรับ:

```text
TikTok
Instagram
YouTube Shorts
```

ควรใช้ Official API เมื่อเป็นไปได้

หลีกเลี่ยง:

```text
Browser Bot
Fake Click
Credential Automation
```

ถ้า Platform ไม่อนุญาต

---

# 39. Phase 11 — Billing

หลังจากระบบ Core ทำงานแล้ว

เพิ่ม:

```text
Stripe
Subscription
Credit Package
Usage Tracking
Invoice
```

Plans ตัวอย่าง:

```text
Free
Creator
Pro
Agency
```

---

# 40. Phase 12 — Analytics

Metrics:

```text
Videos Generated
Success Rate
Generation Cost
Average Generation Time
Credits Used
Products Added
Content Generated
```

อนาคต:

```text
Views
Clicks
CTR
Conversions
Revenue
ROAS
```

---

# 41. Development Priority

ลำดับที่ควรทำจริง:

```text
1. Auth
2. Dashboard
3. Product CRUD
4. AI Analysis
5. Script Generation
6. Prompt Engine
7. Queue
8. Video API
9. Storage
10. Video Library
```

หลังจากนี้ค่อยทำ:

```text
11. Chrome Extension
12. Scheduler
13. Auto Post
14. Billing
15. Analytics
```

---

# 42. MVP Success Criteria

MVP ถือว่าสำเร็จเมื่อ User สามารถ:

```text
Login
   ↓
Add Product
   ↓
Analyze Product
   ↓
Generate Script
   ↓
Generate Video
   ↓
Preview
   ↓
Download
```

ได้ครบโดยไม่ต้องใช้ระบบภายนอกด้วยตัวเอง

---

# 43. สิ่งที่ไม่ควรทำตอนเริ่ม

อย่าทำพร้อมกัน:

```text
TikTok Integration
Shopee Integration
Billing
Analytics
Auto Posting
AI Avatar
Chrome Extension
Team Workspace
```

เพราะจะทำให้ MVP ช้ามาก

Core Value จริงคือ:

```text
Product
   ↓
AI Content
   ↓
AI Video
```

ทำ 3 ส่วนนี้ให้ดีเสียก่อน

---

# 44. Milestone

## Milestone 1

```text
Login + Dashboard + Product
```

## Milestone 2

```text
Product → AI Analysis
```

## Milestone 3

```text
Analysis → Script
```

## Milestone 4

```text
Script → Video Prompt
```

## Milestone 5

```text
Video Prompt → Generated Video
```

## Milestone 6

```text
Video Library + Download
```

เมื่อถึง Milestone 6:

```text
MVP พร้อมให้ User ทดลอง
```

---

# 45. Recommended First Implementation

เริ่ม Repo:

```bash
npx create-next-app@latest ai-affiliate-studio
```

เลือก:

```text
TypeScript: Yes
ESLint: Yes
Tailwind: Yes
App Router: Yes
src/: Yes
```

จากนั้นติดตั้ง:

```bash
npm install prisma @prisma/client
npm install bullmq ioredis
npm install zod
```

Setup shadcn:

```bash
npx shadcn@latest init
```

จากนั้นเริ่มจาก:

```text
User
Product
Content
Video
```

4 Model ก่อน

---

# 46. เป้าหมาย Architecture ระยะยาว

```text
                     AI Affiliate Platform
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
 Product Engine         Content Engine        Video Engine
        │                     │                     │
        ▼                     ▼                     ▼
 Marketplace          LLM / Prompt           Video Models
 Integration             Engine                Providers
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                              ▼
                         Scheduler
                              │
                              ▼
                         Publishers
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
        TikTok             Instagram            YouTube
```

---

# 47. Final MVP Architecture

```text
Next.js
  │
  ├── Auth
  ├── Dashboard
  ├── Product
  ├── Content
  └── Video
       │
       ▼
PostgreSQL
       │
       ▼
Redis + BullMQ
       │
       ▼
Worker
  │
  ├── LLM API
  └── Veo API
       │
       ▼
Cloudflare R2
```

ระบบนี้จะเป็นฐานที่สามารถต่อยอดไปเป็น SaaS เต็มรูปแบบได้โดยไม่ต้องรื้อ Architecture หลักใหม่ทั้งหมด
