# AI Affiliate Studio — Chrome Extension

Standalone Chrome extension for turning TikTok Shop or Shopee products into
platform-specific sales videos, end to end. Product
storage, Gemini or ChatGPT analysis/scripting, and driving Google AI Studio/Flow to
render the clips — runs inside the extension itself. All control happens
through one Side Panel. New paid actions require an online licensing server;
customer libraries and AI provider API keys remain in the browser profile.

## Build

```bash
cd extension
npm install
npm run build
```

## Load into Chrome

1. `chrome://extensions`
2. Enable "Developer mode" (top right)
3. "Load unpacked" → select this `extension/` folder
4. Click the toolbar icon to open the side panel
5. In the Settings tab, choose Gemini web, ChatGPT web, or Gemini API.
   Sign in to the chosen web app in Chrome first. Gemini API requires a key
   from [Google AI Studio](https://aistudio.google.com/apikey).
6. Activate the seller's **License Key** in the panel. This is separate from
   the Gemini API key. Local development checks `http://localhost:3000`.

## Customer release (0.6.0)

Set up the HTTPS server and admin account using [LICENSE_SETUP.md](../LICENSE_SETUP.md), then run:

```bash
LICENSE_SERVER_URL='https://your-real-server.example' npm run build:release
```

Use `extension/release/` for customer installation. The command requires an
HTTPS origin and excludes the development bridge. Activate once per Chrome
Profile; days start on first successful activation. Renewal uses the same
activation unless the seller replaces the key to recover or move it.

Expired, suspended, or offline licensing pauses the next paid step. Results
already submitted can still be saved; Library, download/export, stop and
cancel remain available. After renewal/reconnection, check rights and resume
the paused job; Autopilot has its own **ทำต่อ** button. If publication is
uncertain, check the actual TikTok/Shopee account and record the result in
Library before retrying. Removing the extension clears its private token;
contact the seller for a replacement key if reinstalling or moving profiles.

## Using it

1. **สินค้า (Products)** — on a TikTok Shop/Studio product list, check the
   rows you want and click "ดึงจากหน้า TikTok", or click "+ เพิ่มจากหน้านี้"
   on any single product page. Select one product and step through
   วิเคราะห์สินค้า → สร้างฉาก → สร้างวิดีโอ.
   Product analysis and scene writing use the text source selected in Settings.
   The scene prompt also receives the saved target customer, pain points, and
   selling points from product analysis.
2. Creating a video opens (or reuses) an aistudio.google.com or
   flow.google.com tab and drives it automatically, clip by clip.
3. **คลัง/งาน (Library)** — shows jobs in progress, content ready to film,
   and finished clips (previewable in-panel; also saved to your Downloads
   folder under `ai-affiliate/`).
4. **อัตโนมัติ (Autopilot)** — choose Gemini web, ChatGPT web, or Gemini API
   for each run. The selected source handles product analysis, script writing,
   and scene planning. If an existing analysis came from a different source,
   Autopilot regenerates it before writing the script.

## Notes / known limits

- All data (products, generated content, video jobs) lives in
  `chrome.storage.local` / IndexedDB in this browser profile only — nothing
  syncs across machines, and uninstalling the extension deletes it.
- Multi-clip videos are joined locally when their MP4 formats are compatible.
  Check the full video in Library before posting; if joining fails, download
  the individual clips and combine them in a video editor.
- The Gemini API key is stored in `chrome.storage.local` and used directly
  from the background service worker — treat it like any client-side
  secret.

## Shopee Affiliate videos

1. Open a Shopee product page or Shopee Affiliate product offer detail/list in Chrome, then select **ดึงจากหน้า Shopee** in Products. The button imports names, prices and available product photos into the extension, updates existing items without duplicates, and shows the result beside the button. Checked rows are preferred when available; otherwise it reads the visible offers (up to 20 detail pages per click). Temporary background tabs resolve offer IDs to actual product links and close automatically. Tabs opened before reloading the extension are supported. This imports data for video creation; attaching products to your Shopee account/video basket is a separate step in Shopee.
2. Select **Shopee Video** in the manual or Autopilot platform selector. The four styles are market stall, factory/packing area, livestream seller, and online shop. The selected sales setting reaches script, storyboard, cast and every final video prompt. Factory scenes do not imply manufacturer origin; livestream scenes do not invent viewers or fake UI. Claims and prices must come from product data.
3. Autopilot defaults to **สร้างวิดีโออย่างเดียว** for Shopee. In Library, **ดาวน์โหลดคลิปพร้อมข้อมูลสำหรับแอป Shopee** downloads the full MP4 and a text file with the caption, canonical product URL, shop ID and item ID. Send the MP4 to your phone, then Shopee Video → เพิ่มสินค้า → the link icon → paste that product URL → นำเข้า → เพิ่ม. Enable the AI label and verify the attached product before publishing. Shopee captions are limited to 150 characters. The product badge **มีลิงก์สินค้า** means the extension has a product URL; it does not confirm that Seller Centre can attach it.
4. The optional Chrome uploader targets `https://seller.shopee.co.th/creator-center/video-upload/upload`. It uploads MP4 (3–60 seconds, up to 1 GB), fills/verifies the caption, enables the AI label, and selects a product only by its exact item ID/link. Prepare mode stops for review. Auto mode clicks Post only after all required fields are verified. Seller Centre accounts may only offer their own store's products; desktop affiliate product linking is **not verified** for accounts without a matching eligible product in this picker. An approved Affiliate account and relevant web permissions are required before claiming end-to-end affiliate posting.
5. A timeout after submitting pauses Autopilot instead of retrying a possible publication. Check the actual account, then use **ตรวจแล้ว** in Library to record whether it posted. Confirming that it did not post closes the old task tab before another attempt is allowed. Stop/skip cancels pending preparation; separate prepared videos keep separate task bindings.

Verification: `npm --prefix extension run build` and `node --import tsx --test tests/creative-quality.test.mjs tests/shopee.test.mjs`. Live upload was checked with a synthetic 3-second MP4 in Chrome; no test video was published. Affiliate product linking remains dependent on account approval/permissions and must be tested with an eligible product.

Account check on 2026-10-08: the Affiliate dashboard and product offers were accessible, and an affiliate link was generated for another store's product. The full product page was successfully imported into the extension with its image and price. After registration, Seller Centre's upload picker still returned no data when searching for that product, with no affiliate/link selector exposed. This account therefore has no verified desktop affiliate basket flow; keep Shopee Autopilot in generation-only mode and attach the product in the Shopee app. The synthetic upload was cancelled without saving a draft or publishing.

Import verification on 2026-10-08 (0.4.2): after reloading the extension, an already-open Affiliate detail page imported successfully. The product offer list then imported/updated 20 products with prices and photos, reported success beside the button, and closed its temporary detail tabs. Selecting one offer using Shopee's Ant checkbox wrapper imported/updated exactly one product, including when the nested input's checked property remained false. No video generation or publication was triggered. The scraper and tab workflow have DOM fixture coverage in `tests/shopee-import.test.mjs`.

Mobile verification on 2026-10-08 (0.4.3): the existing 8-second Spin Mop video was transferred by AirDrop and later observed as a published post on the account's Shopee profile, with the AI disclosure and one attached Spin Mop product. Opening that basket reached the product page. The mobile picker exposed Affiliate products and importing through a product link; the same account's Seller Centre picker still had no matching product. This confirms the mobile posting route, not automated Affiliate posting through Chrome. Build and 42 targeted tests passed, including preservation of the original product URL and platform in Library results.

## Phone connection (0.5.0)

The **มือถือ** tab pairs with the optional local **Phone Bridge** using a six-digit code. Select a completed Shopee video, edit its caption and generate a local QR. Android/iPhone browsers on the same Wi-Fi receive the full MP4, caption and the video's original exact product URL. A merged multi-part video is required; the extension never substitutes an incomplete first clip.

Ship the `phone-bridge/` folder alongside the extension. Install Node.js 20+ and double-click `start-windows.cmd` or `start-mac.command`, or run `npm run phone:setup` then `npm run phone:bridge` from the repository root. Instructions and troubleshooting are in [phone-bridge/README.md](../phone-bridge/README.md). No additional Chrome permissions are introduced.

Users still attach the product, enable AI disclosure and publish in the native Shopee app. Downloads/opening the receiver never mark a video posted. The receiver can report the user's confirmation; recording the result in the actual Side Panel requires a second explicit check of the published video and its basket. The existing Shopee Autopilot generation-only mode prepares videos for this handoff; this release does not automatically drive the phone's Shopee app.

The helper only accepts desktop commands from loopback after pairing; QR tokens are scoped to one transfer and expire after 30 minutes. Files stay in a temporary local directory (1 GB total / 5 transfers), with cancellation, expiry and normal shutdown cleanup. LAN HTTP is intended for trusted private Wi-Fi; the bridge does not receive Shopee credentials or browse phone files. Pairing is remembered in Chrome session storage only.

Verification for 0.5.0: extension compilation, 8 helper integration tests and 45 targeted extension tests passed. Live Chrome pairing, IndexedDB MP4 upload, QR rendering, LAN receiver metadata and a completed 2.8 MB MP4 download were verified without publishing another Shopee post. Android/Windows physical devices were not available for device testing; iPhone Mirroring required Touch ID, so the new receiver was tested in Chrome, with separate Android/iPhone download instructions.
