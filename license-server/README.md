# License Server สำหรับ Vercel

Backend แยกสำหรับขายสิทธิ์ Chrome Extension ด้วย License Key ลูกค้าไม่ต้องมีบัญชี ส่วนผู้ขายล็อกอินหน้าแอดมินด้วยอีเมล/รหัสผ่าน แอปนี้มีเฉพาะ License, Better Auth และ PostgreSQL ไม่ใช้ Redis, worker หรือระบบสร้างวิดีโอ

## สิ่งที่มี

- หน้า `/login` และ `/admin/licenses` ภาษาไทย: ออกคีย์ 1/7/30 วันหรือจำนวนเต็ม 1–3,650 วัน ค้นหาลูกค้า/ท้ายคีย์ เติมวัน ระงับ คืนสิทธิ์ ย้าย Profile และดูประวัติ/หมายเหตุรับเงิน
- เริ่มนับจากการเปิดใช้ครั้งแรก หนึ่งวัน = 24 ชั่วโมง เปิดใช้ซ้ำไม่เริ่มเวลาใหม่
- หนึ่งคีย์ต่อหนึ่ง Chrome Profile การเปิดใช้พร้อมกันล็อกด้วย transaction
- การเติมวันใช้ `max(วันหมดอายุเดิม, เวลาปัจจุบัน) + จำนวนวัน` คีย์รอเปิดใช้เพิ่มจำนวนวันที่รอ การระงับไม่หยุดนับเวลา
- เปลี่ยนคีย์/ย้ายเครื่องคงวันหมดอายุเดิมและยกเลิก key/token เก่าทันที
- เก็บเฉพาะ hash ของ key/token แสดงคีย์เต็มครั้งเดียว คำสั่งแอดมินมี request ID ป้องกันเติมวันซ้ำ
- ตรวจ session กับฐานข้อมูลและ `LICENSE_ADMIN_USER_IDS` ทุกครั้ง ปิดสมัครสมาชิกสาธารณะ
- API ไม่ cache, rate limit เก็บใน PostgreSQL จึงใช้ร่วมกันระหว่าง Vercel instances ได้

## 1. เตรียม PostgreSQL และติดตั้ง

ใช้ Node.js **22** และฐานข้อมูล PostgreSQL **ใหม่สำหรับ License Server** เช่น Neon/Supabase ที่เชื่อมผ่าน [Vercel Marketplace Storage](https://vercel.com/docs/marketplace-storage) แอปนี้มี migration ของตัวเอง อย่าใช้ `migrate reset`, `db push` หรือชี้ migration นี้ไปยังฐานข้อมูล backend เต็มเดิมที่มีข้อมูลอยู่แล้ว

จากรากโปรเจกต์:

```bash
cd license-server
npm ci
cp .env.example .env
```

แก้ `.env` ในเครื่องคุณ:

| ตัวแปร | ค่า |
| --- | --- |
| `DATABASE_URL` | PostgreSQL **pooled connection URL** จากผู้ให้บริการ พร้อม TLS ตามที่ผู้ให้บริการกำหนด |
| `DIRECT_URL` | Direct connection URL ของ **ฐานข้อมูลเดียวกัน** ใช้ทำ migration และสร้างแอดมิน |
| `BETTER_AUTH_SECRET` | ค่าสุ่มอย่างน้อย 32 ตัวอักษร เก็บเป็นความลับ |
| `BETTER_AUTH_URL` | สำหรับรันในเครื่องใช้ `http://localhost:3000`; สำหรับ Vercel ใช้ HTTPS origin จริง ไม่มี path |
| `LICENSE_ADMIN_USER_IDS` | เว้นไว้ก่อน แล้วใส่รหัสที่คำสั่งสร้างแอดมินแสดง |

สร้าง secret ในเครื่องแล้วนำผลไปใส่ `.env` และ Vercel (อย่าส่งในแชตหรือ commit):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run db:generate
npm run db:migrate
npm run admin:create -- "you@example.com" "ชื่อแอดมิน"
```

คำสั่งสุดท้ายถามรหัสผ่าน 12–128 ตัวอักษรโดยไม่แสดงตัวอักษรที่พิมพ์ และแสดง `LICENSE_ADMIN_USER_IDS=...` ให้นำ ID ไปใส่ `.env` และ Environment Variables บน Vercel หากมีหลายแอดมินใช้ ID คั่นด้วย comma คำสั่งนี้ไม่เปลี่ยนรหัสผ่านบัญชีเดิม และไม่ยกสิทธิ์ผู้สมัครรายแรกอัตโนมัติ

ทดสอบในเครื่อง:

```bash
npm run dev
```

เปิด `http://localhost:3000/login` แล้วเข้าสู่ระบบด้วยบัญชีที่สร้าง หน้าแอดมินอยู่ที่ `/admin/licenses`

## 2. Deploy บน Vercel

1. นำโค้ดขึ้น Git repository ของคุณ แล้ว Import Project ใน Vercel
2. ตั้ง **Root Directory = `license-server`** ตาม [Project Settings](https://vercel.com/docs/project-configuration/project-settings) และ Node.js Version = **22.x** แอปมี `vercel.json` สำหรับ Next.js, `npm ci` และ `npm run build` แล้ว
3. ดูโดเมน Production ที่ Vercel กำหนดใน Settings → Domains หรือเพิ่มโดเมนของคุณ แล้วตั้ง Environment Variables สำหรับ **Production**:
   - `DATABASE_URL`: pooled URL ของฐานข้อมูล License
   - `BETTER_AUTH_SECRET`: secret ที่สร้างไว้
   - `BETTER_AUTH_URL`: เช่น `https://your-license-project.vercel.app` ต้องใช้โดเมนเดียวกับที่เปิดหน้าแอดมินและฝังใน Extension
   - `LICENSE_ADMIN_USER_IDS`: ID ของบัญชีที่สร้างผ่าน CLI
4. Deploy หรือ Redeploy หลังตั้ง environment แอปตรวจว่าค่า production ใช้ PostgreSQL, HTTPS และ secret อย่างน้อย 32 ตัวอักษร ถ้าตั้งไม่ครบ build จะหยุดพร้อมข้อความแก้ไข
5. เปิด `https://โดเมนจริง/api/health` ต้องได้ HTTP 200 พร้อม `status: "ok"` จากนั้นเปิด `/login` และทดลองออกคีย์

`DIRECT_URL` จำเป็นใน `.env` เครื่องที่รัน migration/CLI แต่ไม่จำเป็นบน Vercel เพราะ build ทำเฉพาะ `prisma generate` และ `next build` **ไม่แก้ schema อัตโนมัติ** รุ่นแรกต้อง migrate ให้เรียบร้อยก่อน deploy; ครั้งถัดไปทำ migration ตามรุ่นก่อนเปิดใช้โค้ดที่ต้องการ schema ใหม่

Production URL ต้องให้ Extension เรียก API ได้โดยไม่มีหน้า Vercel login/Deployment Protection มาบัง `/api/licenses/*` หน้าแอดมินยังตรวจ Better Auth และ allowlist ภายในแอป เมื่อเปลี่ยน environment ต้อง Redeploy

หากใช้ Preview Deployment ให้สร้างฐานข้อมูลและ secret แยก ตั้ง `BETTER_AUTH_URL` เป็นโดเมน HTTPS ของ preview อย่าผูก preview/ชุดทดสอบเข้าฐานข้อมูลลูกค้าจริง

งานขายเชิงพาณิชย์ควรใช้แพ็กเกจ Vercel ที่รองรับ commercial usage ตาม [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines) ตรวจค่าใช้จ่ายของ Vercel และ PostgreSQL ก่อนเปิดขาย

## 3. เชื่อม Extension และขายคีย์

จาก **รากโปรเจกต์ AI-tiktok** แทน URL ด้วยโดเมนจริง:

```bash
LICENSE_SERVER_URL='https://your-license-project.vercel.app' npm --prefix extension run build:release
```

แจกโฟลเดอร์ `extension/release/` ที่สร้างขึ้น ลูกค้ากรอกเฉพาะ License Key ในส่วน License ของ Extension ส่วน Gemini API Key ลูกค้าใส่แยกตามเดิม ไม่ต้องให้ลูกค้ากรอก URL backend หรือ secret ของแอดมิน

ผู้ขายรับเงิน → เข้า `/admin/licenses` → กรอกชื่อลูกค้า/ช่องทางติดต่อ/หมายเหตุ → เลือกวัน → ออกคีย์ → คัดลอกคีย์ที่แสดงครั้งเดียวและส่งให้ลูกค้า วันเริ่มนับเมื่อเขาเปิดใช้สำเร็จ หากคีย์หายหรือล้างข้อมูล Chrome ให้ใช้ **เปลี่ยนคีย์ / ย้ายเครื่อง** หากเครือข่ายหลุดหลังส่งคำสั่งให้ลองคำขอเดิมเพื่อไม่เติมวันซ้ำ

## API contract

| เส้นทาง | วิธี | ผู้เรียก |
| --- | --- | --- |
| `/api/licenses/activate` | POST `{ "key": "AAS_…", "installationId": "UUID" }` | Extension เปิดใช้คีย์ |
| `/api/licenses/validate` | POST `{ "token": "activation_…", "installationId": "UUID" }` | Extension ตรวจสิทธิ์ก่อนเริ่มงาน |
| `/api/admin/licenses` | GET / POST | แอดมินที่ล็อกอินและมี ID ใน allowlist เท่านั้น |
| `/api/health` | GET | ตรวจการเชื่อมต่อและตาราง License: 200 หรือ 503 |

เมื่อสำเร็จส่ง `ok`, `status`, `serverTime`, `expiresAt`; activate เพิ่ม `token` เวลาส่งเป็น UTC ISO 8601 แอดมินแสดงเวลาไทย Extension ใช้ผลจากเซิร์ฟเวอร์เป็นการอนุญาต ไม่ใช้เวลาเครื่องลูกค้าหรือ local storage

ข้อผิดพลาดมี `code`: `invalid_key`, `invalid_token`, `expired`, `suspended`, `profile_limit`, `invalid_request`, `rate_limited`, `https_required`, `server_unavailable` เป็นต้น เมื่อ DB/ระบบตรวจสิทธิ์ขัดข้องตอบ 503 เพื่อให้ Extension พักงานใหม่ ไม่อนุญาตใช้งานแทนผลตรวจ

อย่าเก็บ request/response body ของ API License ใน log/APM เพราะมีคีย์เต็มและ token ติดตาม event `license_activate_ok`, `license_validate_ok`, `license_denied`, `license_error` และ `license_database_pool_error` รวมถึง HTTP 429/503 สำรอง PostgreSQL พร้อมทดสอบการกู้คืน ข้อมูลสิทธิ์จะคงอยู่ข้ามการ restart/deploy เพราะอยู่ใน PostgreSQL

## ทดสอบ

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

`npm test` ทดสอบ environment โดยไม่ต้องมี DB; integration/HTTP/CLI/production จะข้ามเมื่อไม่มี environment ทดสอบ การรันครบให้ใช้ **ฐานข้อมูลที่ทิ้งได้เท่านั้น** และ apply migration ของแอปนี้ก่อน:

```bash
LICENSE_TEST_DATABASE_URL='postgresql://.../license_test' npm test
```

HTTP tests ต้องมี `npm run dev` ที่ชี้ฐานข้อมูลทดสอบเดียวกัน กำหนด `LICENSE_ADMIN_USER_IDS=license-http-admin` และ `BETTER_AUTH_URL=http://localhost:3000`:

```bash
LICENSE_TEST_DATABASE_URL='postgresql://.../license_test' LICENSE_TEST_URL='http://localhost:3000' npm test
```

Production tests ใช้ `npm run build` แล้ว `npm start` บนเครื่อง กำหนด auth origin HTTPS ทดสอบ เช่น `https://license-test.invalid`:

```bash
LICENSE_TEST_DATABASE_URL='postgresql://.../license_test' LICENSE_TEST_URL='http://localhost:3000' LICENSE_TEST_AUTH_ORIGIN='https://license-test.invalid' LICENSE_TEST_PRODUCTION_URL='http://localhost:3000' npm test
```

ค่าทดสอบ `LICENSE_TEST_AUTH_ORIGIN` ใช้จำลอง HTTPS reverse proxy บนเซิร์ฟเวอร์ local เท่านั้น ชุดทดสอบสร้างบัญชีชั่วคราวและลบเฉพาะข้อมูลที่สร้างเอง ตรวจ activation 1/30 วัน, สอง Profile พร้อมกัน, idempotency, เติมวันก่อน/หลังหมดอายุ, ระงับ, เปลี่ยนคีย์/token, บัญชีทั่วไป/ปลอม session, ปิด signup, rate limit และ API แบบ token ร่วมเดิมไม่อยู่ในแอปนี้

ก่อนแจกจริงยังต้องทดสอบ Extension กับสอง Chrome Profiles และโดเมน HTTPS ที่ deploy แล้ว รวมทั้งหมดอายุ/ระบบออฟไลน์ระหว่าง Batch และ Autopilot ตาม [คู่มือระบบ License](../LICENSE_SETUP.md) รุ่นแรกยังไม่มีตัดเงินอัตโนมัติหรือซิงก์คลังข้ามเครื่อง และการจำกัด Profile ไม่ใช่การป้องกันผู้ที่แก้โค้ด Extension ได้ทั้งหมด
