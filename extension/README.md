# AI Affiliate Studio — Chrome Extension

Adds a floating "+ Add to AI Studio" button to any page. Clicking it
extracts OpenGraph product data (title, description, price, image) from
the page and opens a new tab at the web app's `/products/new` with that
data pre-filled — no server-side auth plumbing, since you're already
logged into the web app in that browser.

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
4. Visit any page and click the button in the bottom-right corner

`WEB_APP_URL` in `src/background.ts` defaults to `http://localhost:3000`
— change it (and rebuild) to point at a deployed instance.

Not verified inside an actual Chrome profile in this session — only
`tsc` type-checked and manually reviewed. Load it and click through once
before relying on it.
