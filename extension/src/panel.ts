// NOTE: shares one global scope with flow-automation.ts / ai-studio-automation.ts
// (Chrome loads them as classic scripts on the same page), which call
// aiPanelStatus()/aiPanelMount() directly as globals — kept as a slim shim so
// those two files stay untouched. The real UI now lives in the side panel
// (sidepanel.ts), which reads this status text back out of storage.

const AI_PANEL_LOG_KEY = "jobLog";
const AI_PANEL_LOG_MAX = 300;

/**
 * Every status transition, appended to a durable log instead of just the
 * one-line "latest status" — a run that stalls leaves one frozen banner
 * behind, which tells you nothing about the 10 steps that got it there or
 * which one it's actually stuck on. The side panel's Library tab renders
 * this with a copy button, so one test run produces a pasteable trace
 * instead of a screenshot of whatever happened to be on screen.
 */
async function aiPanelLog(text: string) {
  try {
    const stored = await chrome.storage.local.get(AI_PANEL_LOG_KEY);
    const entries: { at: number; text: string }[] = Array.isArray(stored[AI_PANEL_LOG_KEY])
      ? stored[AI_PANEL_LOG_KEY]
      : [];
    entries.push({ at: Date.now(), text });
    while (entries.length > AI_PANEL_LOG_MAX) entries.shift();
    await chrome.storage.local.set({ [AI_PANEL_LOG_KEY]: entries });
  } catch {
    // context already gone — see the comment in aiPanelStatus
  }
}

/** Called once at the start of a job so its trace isn't mixed in with a previous run's. */
function aiPanelClearLog() {
  try {
    chrome.storage.local.set({ [AI_PANEL_LOG_KEY]: [] }).catch(() => {});
  } catch {
    // context already gone
  }
}

function aiPanelStatus(text: string, color = "#e5e7eb") {
  // Reloading the extension while this tab is still open orphans this
  // script — chrome.storage then throws "Extension context invalidated."
  // Nothing can be done about it from here (the tab needs a real reload to
  // get the fresh script), so just swallow it instead of an uncaught
  // rejection spamming chrome://extensions.
  try {
    chrome.storage.local.set({ jobStatusText: { text, color, at: Date.now() } }).catch(() => {});
  } catch {
    // context already gone
  }
  aiPanelLog(text);
}

function aiPanelMount(_config: { site: "aistudio" | "flow"; siteLabel: string }) {
  // No in-page UI to mount anymore — the side panel is the control surface.
}
