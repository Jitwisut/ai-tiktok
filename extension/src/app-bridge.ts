interface GenerateViaExtensionDetail {
  videoId: string;
  clips: { index: number; prompt: string }[];
  duration: number;
  aspectRatio: string;
  imageUrl?: string | null;
  site?: "aistudio" | "flow";
}

// Answers the app's presence check. Event dispatch is synchronous, so the
// app knows the extension is here by the time its own dispatch returns.
// (Marking the DOM instead would change <html> under React and break
// hydration.)
window.addEventListener("ai-affiliate:ping", () => {
  window.dispatchEvent(new CustomEvent("ai-affiliate:pong"));
});

window.addEventListener("ai-affiliate:generate-via-extension", (event) => {
  const detail = (event as CustomEvent<GenerateViaExtensionDetail>).detail;
  if (!detail?.videoId || !detail.clips?.length) return;

  chrome.runtime.sendMessage(
    { type: "QUEUE_EXTENSION_VIDEO_JOB", job: detail, site: detail.site ?? "aistudio" },
    () => {
      window.dispatchEvent(new CustomEvent("ai-affiliate:extension-ack"));
    },
  );
});
