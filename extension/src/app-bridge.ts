interface GenerateViaExtensionDetail {
  videoId: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  imageUrl?: string | null;
}

document.documentElement.setAttribute("data-ai-affiliate-bridge-loaded", "true");

window.addEventListener("ai-affiliate:generate-via-extension", (event) => {
  const detail = (event as CustomEvent<GenerateViaExtensionDetail>).detail;
  if (!detail?.videoId || !detail.prompt) return;

  chrome.runtime.sendMessage({ type: "QUEUE_EXTENSION_VIDEO_JOB", job: detail }, () => {
    window.dispatchEvent(new CustomEvent("ai-affiliate:extension-ack"));
  });
});
