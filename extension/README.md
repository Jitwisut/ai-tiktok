# AI Affiliate Studio — Chrome Extension

Standalone Chrome extension for turning a TikTok Shop product into a
TikTok-style ad, end to end, with no separate backend. Everything — product
storage, Gemini analysis/scripting, and driving Google AI Studio/Flow to
render the clips — runs inside the extension itself. All control happens
through one Side Panel.

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
5. In the Settings tab, paste a Gemini API key (from [Google AI
   Studio](https://aistudio.google.com/apikey)) and save

## Using it

1. **สินค้า (Products)** — on a TikTok Shop/Studio product list, check the
   rows you want and click "ดึงจากหน้า TikTok", or click "+ เพิ่มจากหน้านี้"
   on any single product page. Select one product and step through
   วิเคราะห์สินค้า → สร้างฉาก → สร้างวิดีโอ.
2. Creating a video opens (or reuses) an aistudio.google.com or
   flow.google.com tab and drives it automatically, clip by clip.
3. **คลัง/งาน (Library)** — shows jobs in progress, content ready to film,
   and finished clips (previewable in-panel; also saved to your Downloads
   folder under `ai-affiliate/`).

## Notes / known limits

- All data (products, generated content, video jobs) lives in
  `chrome.storage.local` / IndexedDB in this browser profile only — nothing
  syncs across machines, and uninstalling the extension deletes it.
- Veo renders in ≤8s clips; this extension does not stitch them into one
  file (no server, no ffmpeg here). Download the clips and combine them in
  any video editor (e.g. CapCut).
- The Gemini API key is stored in `chrome.storage.local` and used directly
  from the background service worker — treat it like any client-side
  secret.
